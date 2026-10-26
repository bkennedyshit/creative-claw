import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "./runtime/execution.js";
import { StudioJobs } from "./studio-jobs.js";
import { buildStudioRecipe } from "./studio-recipes.js";

type Stored = Parameters<ConstructorParameters<typeof StudioJobs>[0]["register"]>[1];
const outcome = {
  ok: true,
  output: "artifact.mp4",
  message: "done",
  artifact: { id: "artifact-1" },
  nodes: [],
  duration_ms: 12,
};
describe("Durable Studio job queue", () => {
  let directory: string;
  let store: ConstructorParameters<typeof StudioJobs>[0];
  let jobs: StudioJobs;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "creative-jobs-"));
    store = createPluginStateKeyedStoreForTests<Stored>("creative-engines", {
      namespace: "studio-jobs",
      maxEntries: 1000,
      env: { ...process.env, OPENCLAW_STATE_DIR: directory },
    });
  });
  afterEach(async () => {
    await jobs?.shutdown();
    resetPluginStateStoreForTests();
    await rm(directory, { recursive: true, force: true });
  });

  it("pins immutable graph revisions, serializes execution, reports progress and persists completion", async () => {
    let complete: () => void = () => {};
    let context: ExecutionContext = {};
    const execute = vi.fn(async (_graph, _input, _output, current: ExecutionContext) => {
      context = current;
      if (execute.mock.calls.length === 1) {
        await new Promise<void>((resolve, reject) => {
          complete = resolve;
          current.signal?.addEventListener("abort", () => reject(new Error("Cancelled")), {
            once: true,
          });
        });
      }
      return outcome;
    });
    jobs = new StudioJobs(store, execute);
    const graph = buildStudioRecipe("clean-cut");
    const first = await jobs.start(graph, "source.mp4");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    graph.nodes[0].parameters.start_sec = 99;
    expect(execute.mock.calls[0][0].nodes[0].parameters.start_sec).toBe(0);
    const second = await jobs.start(buildStudioRecipe("warm"), "another.mp4");
    expect((await jobs.get(second.id)).status).toBe("queued");
    context.onProgress?.({ stage: "processing", frames: 4, totalFrames: 12, nodeId: "step-1" });
    expect((await jobs.get(first.id)).progress?.frames).toBe(4);
    complete();
    await vi.waitFor(async () => expect((await jobs.get(second.id)).status).toBe("succeeded"));
    expect(execute).toHaveBeenCalledTimes(2);
    expect((await store.lookup(first.id))?.result?.artifact.id).toBe("artifact-1");
  });

  it("cancels running and queued work without dispatching the cancelled queue entry", async () => {
    const execute = vi.fn(async (_graph, _input, _output, context: ExecutionContext) => {
      await new Promise<void>((_resolve, reject) => {
        context.signal?.addEventListener("abort", () => reject(new Error("Cancelled")), {
          once: true,
        });
      });
      return outcome;
    });
    jobs = new StudioJobs(store, execute);
    const active = await jobs.start(buildStudioRecipe("clean-cut"), "source.mp4");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    const queued = await jobs.start(buildStudioRecipe("warm"), "next.mp4");
    expect((await jobs.cancel(queued.id)).status).toBe("cancelled");
    await jobs.cancel(active.id);
    await vi.waitFor(async () => expect((await jobs.get(active.id)).status).toBe("cancelled"));
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await jobs.get(queued.id)).status).toBe("cancelled");
  });

  it("bounds the queue and reopens a slot after queued cancellation", async () => {
    jobs = new StudioJobs(store, async (_graph, _input, _output, context) => {
      await new Promise<void>((_resolve, reject) => {
        context.signal?.addEventListener("abort", () => reject(new Error("Cancelled")), {
          once: true,
        });
      });
      return outcome;
    });
    const first = await jobs.start(buildStudioRecipe("clean-cut"), "source.mp4");
    await vi.waitFor(async () => expect((await jobs.get(first.id)).status).toBe("running"));
    const queued = [];
    for (let index = 0; index < 8; index++) {
      queued.push(await jobs.start(buildStudioRecipe("clean-cut"), `source-${index}.mp4`));
    }
    await expect(jobs.start(buildStudioRecipe("warm"), "overflow.mp4")).rejects.toThrow(
      "queue is full",
    );
    await jobs.cancel(queued[0].id);
    expect((await jobs.start(buildStudioRecipe("warm"), "new-slot.mp4")).status).toBe("queued");
  });
  it("keeps cancellation terminal when an operation does not observe its signal", async () => {
    let finish!: () => void;
    const execute = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return outcome;
    });
    jobs = new StudioJobs(store, execute);
    const job = await jobs.start(buildStudioRecipe("clean-cut"), "source.mp4");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect((await jobs.cancel(job.id)).status).toBe("cancelling");
    finish();
    await vi.waitFor(async () => expect((await jobs.get(job.id)).status).toBe("cancelled"));
    expect((await jobs.get(job.id)).result).toBeUndefined();
  });

  it.each(["running", "succeeded"] as const)(
    "continues accepted work after one failed %s state write without replaying execution",
    async (phase) => {
      const register = store.register.bind(store);
      let failWrite!: () => void;
      const failure = new Promise<void>((resolve) => {
        failWrite = resolve;
      });
      let injected = false;
      vi.spyOn(store, "register").mockImplementation(async (key, record) => {
        if (!injected && record.status === phase) {
          injected = true;
          await failure;
          throw new Error("Transient state write failure");
        }
        return register(key, record);
      });
      const execute = vi.fn(async () => outcome);
      jobs = new StudioJobs(store, execute);
      const first = await jobs.start(buildStudioRecipe("clean-cut"), "first.mp4");
      await vi.waitFor(() => expect(injected).toBe(true));
      const second = await jobs.start(buildStudioRecipe("warm"), "second.mp4");
      failWrite();
      await vi.waitFor(async () => expect((await jobs.get(second.id)).status).toBe("succeeded"));
      expect((await jobs.get(first.id)).status).toBe(phase === "running" ? "failed" : "succeeded");
      expect(execute).toHaveBeenCalledTimes(phase === "running" ? 1 : 2);
    },
  );

  it("recovers interrupted lifecycle records and retains completed outcomes after reopening SQLite", async () => {
    const graph = buildStudioRecipe("clean-cut");
    const now = new Date().toISOString();
    await store.register("crashed", {
      id: "crashed",
      graphId: graph.id,
      graphRevision: graph.revision,
      graph,
      name: graph.name,
      input: "source.mp4",
      output: "",
      status: "running",
      createdAt: now,
      updatedAt: now,
    });
    jobs = new StudioJobs(store, async () => outcome);
    expect((await jobs.get("crashed")).status).toBe("interrupted");
    const successful = await jobs.start(graph, "source.mp4");
    await vi.waitFor(async () => expect((await jobs.get(successful.id)).status).toBe("succeeded"));
    await jobs.shutdown();
    resetPluginStateStoreForTests();
    const reopened = createPluginStateKeyedStoreForTests<Stored>("creative-engines", {
      namespace: "studio-jobs",
      maxEntries: 1000,
      env: { ...process.env, OPENCLAW_STATE_DIR: directory },
    });
    jobs = new StudioJobs(reopened, async () => outcome);
    expect((await jobs.get(successful.id)).result?.output).toBe("artifact.mp4");
    expect((await jobs.get("crashed")).error).toContain("Gateway stopped");
  });

  it("records execution failures without fabricating successful artifacts", async () => {
    jobs = new StudioJobs(store, async () => {
      throw new Error("Missing model");
    });
    const job = await jobs.start(buildStudioRecipe("clean-cut"), "source.mp4");
    await vi.waitFor(async () => expect((await jobs.get(job.id)).status).toBe("failed"));
    expect(await jobs.get(job.id)).toMatchObject({ error: "Missing model", status: "failed" });
    expect((await jobs.get(job.id)).result).toBeUndefined();
  });
});
