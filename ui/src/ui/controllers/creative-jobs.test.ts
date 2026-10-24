import type { CreativeGraph } from "@openclaw/creative-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { CreativeJob } from "./creative-jobs.ts";
import { CreativeStudioController } from "./creative-studio.ts";

const graph: CreativeGraph = {
  schemaVersion: 1,
  id: "graph-1",
  projectId: "studio",
  revision: 4,
  name: "AI workflow",
  createdAt: "2026-10-24T00:00:00.000Z",
  updatedAt: "2026-10-24T00:00:00.000Z",
  nodes: [],
  edges: [],
  inputs: [],
  outputs: [],
  metadata: {},
};
const job = (status: string): CreativeJob => ({
  id: "job-1",
  graphId: graph.id,
  name: graph.name,
  status,
  createdAt: graph.createdAt,
  updatedAt: graph.updatedAt,
});

describe("Creative workflow job client", () => {
  let studio: CreativeStudioController;
  let request: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    request = vi.fn(async () => ({}));
    studio = new CreativeStudioController({
      connected: true,
      client: { request } as unknown as GatewayBrowserClient,
      addController() {},
      removeController() {},
      requestUpdate() {},
      updateComplete: Promise.resolve(true),
    });
    studio.updateRunForm({ input: "source.mp4", output: "export.mp4" });
  });
  afterEach(() => {
    studio.jobs.stopPolling();
    vi.useRealTimers();
  });

  it("submits the saved revision, polls progress and reports real model/provider output", async () => {
    request.mockImplementation((method: string) => {
      if (method === "creative.studio.job.start") {
        return { job: job("queued") };
      }
      if (method === "creative.studio.job.get") {
        return {
          job: {
            ...job("succeeded"),
            result: {
              ok: true,
              message: "export.mp4",
              artifact: { id: "output-1" },
              nodes: [
                {
                  node_id: "step-1",
                  capability: "ai.video_background_blur",
                  status: "ok",
                  engine_path: "image.dll",
                  metadata: { modelId: "u2net", executionProvider: "cpu" },
                },
              ],
            },
          },
        };
      }
      if (method === "creative.studio.snapshot") {
        return { graphs: [graph], project: { activeGraphId: graph.id }, results: [] };
      }
      return { results: [] };
    });
    await studio.runWorkflow(graph);
    expect(request).toHaveBeenCalledWith("creative.studio.job.start", {
      id: graph.id,
      revision: 4,
      input: "source.mp4",
      output: "export.mp4",
    });
    expect(studio.running).toBe(true);
    await vi.advanceTimersByTimeAsync(700);
    expect(studio.running).toBe(false);
    expect(studio.lastNodes[0]).toMatchObject({
      capability: "ai.video_background_blur",
      model: "u2net",
      provider: "cpu",
    });
    expect(studio.lastResult).toEqual({ ok: true, message: "export.mp4" });
  });

  it("recovers a live job on reload and sends cancellation without losing the source", async () => {
    request.mockImplementation((method: string) => {
      if (method === "creative.studio.job.list") {
        return {
          jobs: [
            {
              ...job("running"),
              progress: {
                stage: "processing",
                frames: 3,
                totalFrames: 24,
                nodeIndex: 1,
                totalNodes: 2,
              },
            },
          ],
        };
      }
      if (method === "creative.studio.job.cancel") {
        return { job: job("cancelling") };
      }
      return { job: { ...job("cancelled"), error: "Workflow cancelled by operator" } };
    });
    await studio.jobs.load();
    expect(studio.running).toBe(true);
    expect(studio.jobs.active?.progress?.frames).toBe(3);
    await studio.jobs.cancel();
    expect(request).toHaveBeenCalledWith("creative.studio.job.cancel", { id: "job-1" });
    expect(studio.jobs.active?.status).toBe("cancelling");
    await studio.jobs.poll();
    expect(studio.running).toBe(false);
    expect(studio.lastResult?.message).toContain("cancelled");
    expect(studio.runForm.input).toBe("source.mp4");
  });

  it("surfaces rejected job starts instead of leaving the interface stuck running", async () => {
    request.mockResolvedValue({ error: "Workflow changed elsewhere" });
    await studio.runWorkflow(graph);
    expect(studio.running).toBe(false);
    expect(studio.lastResult?.message).toContain("changed elsewhere");
  });
});
