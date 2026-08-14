import { describe, it, expect, vi } from "vitest";
import type { EngineRuntime } from "../runtime/engine-runtime.js";
import type { OpCatalog, OpInfo } from "../types.js";
import { registerOpsTools } from "./ops.js";

type ToolResult = { content: Array<{ type: string; text: string }>; details: unknown };
type Tool = {
  name: string;
  description: string;
  parameters: unknown;
  execute: (toolCallId: string, params: unknown) => Promise<ToolResult>;
};

function makeFakeEngine(name: string): EngineRuntime {
  const catalog: OpCatalog = {
    engine: name,
    ops: [
      {
        id: "gaussian_blur",
        name: "Gaussian Blur",
        description: "blur",
        params: [],
        supports_chain: true,
      },
    ],
  };
  return {
    engineName: name,
    binaryPath: `/fake/${name}.dll`,
    isAvailable: () => true,
    reason: () => undefined,
    listOps: () => catalog,
    opInfo: (opId: string): OpInfo => {
      const info = catalog.ops.find((o) => o.id === opId);
      if (!info) {
        throw new Error(`unknown op '${opId}' for engine '${name}'`);
      }
      return info;
    },
    apply: vi.fn(async (_input, _op, output) => ({
      ok: true,
      output_path: output,
      engine_path: `/fake/${name}.dll`,
      duration_ms: 1,
    })),
    applyChain: vi.fn(async (_input, _steps, output) => ({
      ok: true,
      output_path: output,
      engine_path: `/fake/${name}.dll`,
      duration_ms: 1,
    })),
  } as unknown as EngineRuntime;
}

function collectTools(engines: Record<string, EngineRuntime>): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  registerOpsTools((tool) => tools.set(tool.name, tool as unknown as Tool), engines);
  return tools;
}

describe("registerOpsTools — registration + namespacing", () => {
  it("registers list_ops/op_info/apply/apply_chain for every present engine, namespaced", () => {
    const engines = {
      image: makeFakeEngine("image"),
      audio: makeFakeEngine("audio"),
      video: makeFakeEngine("video"),
      vector: makeFakeEngine("vector"),
    };
    const tools = collectTools(engines);

    for (const name of ["image", "audio", "video", "vector"]) {
      for (const suffix of ["list_ops", "op_info", "apply", "apply_chain"]) {
        expect(tools.has(`${name}.${suffix}`)).toBe(true);
      }
    }
    expect(tools.size).toBe(16);
  });

  it("skips engines that are absent from the record", () => {
    const tools = collectTools({ image: makeFakeEngine("image") });
    expect([...tools.keys()].every((n) => n.startsWith("image."))).toBe(true);
    expect(tools.size).toBe(4);
  });
});

describe("registerOpsTools — execution", () => {
  it("list_ops reports engine_path alongside the catalog", async () => {
    const engines = { image: makeFakeEngine("image") };
    const tools = collectTools(engines);
    const result = (await tools.get("image.list_ops")!.execute("call-1", {})).details as {
      engine: string;
      engine_path: string;
    };
    expect(result.engine).toBe("image");
    expect(result.engine_path).toBe("/fake/image.dll");
  });

  it("apply routes through the engine runtime", async () => {
    const engine = makeFakeEngine("image");
    const tools = collectTools({ image: engine });
    await tools.get("image.apply")!.execute("call-1", {
      input: "/in.png",
      op: "gaussian_blur",
      output: "/out.png",
      params: { sigma: 2 },
    });
    expect(engine.apply).toHaveBeenCalledWith("/in.png", "gaussian_blur", "/out.png", { sigma: 2 });
  });

  it("op_info on an unknown op throws (nothing executed)", async () => {
    const engine = makeFakeEngine("image");
    const tools = collectTools({ image: engine });
    await expect(
      tools.get("image.op_info")!.execute("call-1", { op_id: "does_not_exist" }),
    ).rejects.toThrow(/unknown op/);
    expect(engine.apply).not.toHaveBeenCalled();
  });
});
