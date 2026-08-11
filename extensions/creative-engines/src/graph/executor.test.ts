import { describe, it, expect } from "vitest";
import type { EngineRuntime } from "../runtime/engine-runtime.js";
import type { ApplyResult } from "../types.js";
import { PipelineExecutor } from "./executor.js";
import type { Graph } from "./types.js";

/** Fake engine: applies "fail_*" ops as failures, everything else as real output. */
function makeFakeEngine(name: string): EngineRuntime {
  return {
    engineName: name,
    binaryPath: `/fake/${name}.dll`,
    isAvailable: () => true,
    reason: () => undefined,
    apply: async (_input: string, op: string, output: string): Promise<ApplyResult> => {
      const ok = !op.startsWith("fail");
      return { ok, output_path: output, engine_path: `/fake/${name}.dll`, duration_ms: 1, reason: ok ? undefined : "op failed" };
    },
  } as unknown as EngineRuntime;
}

const engines = { image: makeFakeEngine("image"), audio: makeFakeEngine("audio") };

describe("PipelineExecutor — real op wiring", () => {
  it("runs a small connected graph in dependency order with per-node status", async () => {
    const graph: Graph = {
      id: "g1",
      nodes: [
        { id: "a", engine: "image", op: "gaussian_blur", params: {}, input: "/in.png", output: "/a.png" },
        { id: "b", engine: "image", op: "scale", params: {}, output: "/b.png" },
      ],
      connections: [{ from_node: "a", from_output: "out", to_node: "b", to_input: "in" }],
    };

    const result = await new PipelineExecutor(engines).execute(graph);
    expect(result.ok).toBe(true);
    expect(result.nodes.map((n) => [n.node_id, n.status])).toEqual([
      ["a", "ok"],
      ["b", "ok"],
    ]);
    // b consumed a's output through the connection.
    expect(result.nodes.find((n) => n.node_id === "b")?.output_path).toBe("/b.png");
  });

  it("isolates a failing node and skips its dependents (not faked)", async () => {
    const graph: Graph = {
      id: "g2",
      nodes: [
        { id: "a", engine: "image", op: "fail_op", params: {}, input: "/in.png" },
        { id: "b", engine: "image", op: "scale", params: {} },
      ],
      connections: [{ from_node: "a", from_output: "out", to_node: "b", to_input: "in" }],
    };

    const result = await new PipelineExecutor(engines).execute(graph);
    expect(result.ok).toBe(false);
    expect(result.nodes.find((n) => n.node_id === "a")?.status).toBe("failed");
    expect(result.nodes.find((n) => n.node_id === "b")?.status).toBe("skipped");
  });

  it("detects cycles and refuses to execute", async () => {
    const graph: Graph = {
      id: "cyclic",
      nodes: [
        { id: "a", engine: "image", op: "scale", params: {} },
        { id: "b", engine: "image", op: "scale", params: {} },
      ],
      connections: [
        { from_node: "a", from_output: "out", to_node: "b", to_input: "in" },
        { from_node: "b", from_output: "out", to_node: "a", to_input: "in" },
      ],
    };
    await expect(new PipelineExecutor(engines).execute(graph)).rejects.toThrow(/cycle/i);
  });
});
