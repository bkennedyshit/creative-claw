import { describe, it, expect } from "vitest";
import type { EngineBindingModule } from "../ffi/binding-types.js";
import { EngineRuntime } from "../runtime/engine-runtime.js";
import type { ApplyResult, Step } from "../types.js";
import { registerBatchTools } from "./batch.js";

type ToolResult = { content: Array<{ type: string; text: string }>; details: unknown };
type Tool = {
  name: string;
  description: string;
  parameters: unknown;
  execute: (toolCallId: string, params: unknown) => Promise<ToolResult>;
};

/**
 * Concrete EngineRuntime whose applyChain is deterministic and never touches the
 * filesystem or a native library — exercises the base-class batch isolation.
 */
class TestEngine extends EngineRuntime {
  constructor() {
    super({
      engineName: "image",
      bindings: {} as unknown as EngineBindingModule,
      config: { available: false },
    });
  }
  override async applyChain(input: string, _steps: Step[], output: string): Promise<ApplyResult> {
    const ok = !input.includes("fail");
    return {
      ok,
      output_path: output,
      engine_path: "/fake/image.dll",
      duration_ms: 1,
      reason: ok ? undefined : "boom",
    };
  }
}

describe("EngineRuntime.batch — failure isolation", () => {
  it("yields one ItemResult per input and one failure never aborts the batch", async () => {
    const engine = new TestEngine();
    const { items, manifest } = await engine.batch(
      { list: ["/a.png", "/fail.png", "/c.png"] },
      [{ op: "gaussian_blur", params: {} }],
      "/out",
    );

    expect(items).toHaveLength(3);
    expect(manifest.total_items).toBe(3);
    expect(manifest.succeeded).toBe(2);
    expect(manifest.failed).toBe(1);
    // The failing item is isolated; the item after it still ran.
    expect(items.map((i) => i.ok)).toEqual([true, false, true]);
    expect(items[1]?.error).toMatch(/boom/);
  });

  it("is idempotent across re-runs (same inputs → same per-item outcomes)", async () => {
    const engine = new TestEngine();
    const run = () =>
      engine.batch({ list: ["/a.png", "/fail.png"] }, [{ op: "x", params: {} }], "/out");
    const first = await run();
    const second = await run();
    expect(first.items.map((i) => i.ok)).toEqual(second.items.map((i) => i.ok));
    expect(first.manifest.succeeded).toBe(second.manifest.succeeded);
  });
});

describe("registerBatchTools — tool wiring", () => {
  it("registers <engine>.batch for every present engine and returns summary + items + manifest", async () => {
    const engine = new TestEngine();
    const tools = new Map<string, Tool>();
    registerBatchTools((tool) => tools.set(tool.name, tool as unknown as Tool), {
      image: engine,
      audio: engine,
      video: engine,
      vector: engine,
    });
    expect([...tools.keys()].toSorted()).toEqual([
      "audio.batch",
      "image.batch",
      "vector.batch",
      "video.batch",
    ]);

    const result = (
      await tools.get("image.batch")!.execute("call-1", {
        input_set: { list: ["/a.png", "/fail.png"] },
        pipeline: [{ op: "x", params: {} }],
        output_dir: "/out",
      })
    ).details as {
      summary: { total: number; succeeded: number; failed: number };
      items: unknown[];
    };

    expect(result.summary).toMatchObject({ total: 2, succeeded: 1, failed: 1 });
    expect(result.items).toHaveLength(2);
  });
});
