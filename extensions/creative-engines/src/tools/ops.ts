import { Type } from "typebox";
import { defineEngineTool, type EngineToolRegistrar } from "../define-tool.js";
import type { EngineRuntime } from "../runtime/engine-runtime.js";

const ENGINE_NAMES = ["image", "audio", "video", "vector"] as const;

/**
 * Registers per-engine operation tools:
 *   <engine>.list_ops, <engine>.op_info, <engine>.apply, <engine>.apply_chain
 */
export function registerOpsTools(
  registerTool: EngineToolRegistrar,
  engines: Record<string, EngineRuntime>,
): void {
  for (const name of ENGINE_NAMES) {
    const engine = engines[name];
    if (!engine) {
      continue;
    }

    registerTool(
      defineEngineTool({
        name: `${name}.list_ops`,
        description: `List all available operations from the ${name} engine.`,
        parameters: Type.Object({}),
        run() {
          const catalog = engine.listOps();
          return { ...catalog, engine_path: engine.binaryPath ?? "unknown" };
        },
      }),
    );

    registerTool(
      defineEngineTool({
        name: `${name}.op_info`,
        description: `Get detailed info about a specific ${name} engine operation.`,
        parameters: Type.Object({
          op_id: Type.String({ description: "Operation identifier" }),
        }),
        run(args) {
          const info = engine.opInfo(args.op_id as string);
          return { ...info, engine_path: engine.binaryPath ?? "unknown" };
        },
      }),
    );

    registerTool(
      defineEngineTool({
        name: `${name}.apply`,
        description: `Apply a single ${name} engine operation to a file.`,
        parameters: Type.Object({
          input: Type.String({ description: "Input file path" }),
          op: Type.String({ description: "Operation id to apply" }),
          output: Type.String({ description: "Output file path" }),
          params: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), { description: "Operation parameters" }),
          ),
        }),
        run(args) {
          return engine.apply(
            args.input as string,
            args.op as string,
            args.output as string,
            (args.params as Record<string, unknown>) ?? {},
          );
        },
      }),
    );

    registerTool(
      defineEngineTool({
        name: `${name}.apply_chain`,
        description: `Apply a chain of ${name} engine operations sequentially.`,
        parameters: Type.Object({
          input: Type.String({ description: "Input file path" }),
          steps: Type.Array(
            Type.Object({
              op: Type.String(),
              params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
            }),
            { description: "Ordered list of operations to apply" },
          ),
          output: Type.String({ description: "Final output file path" }),
        }),
        run(args) {
          return engine.applyChain(
            args.input as string,
            args.steps as Array<{ op: string; params: Record<string, unknown> }>,
            args.output as string,
          );
        },
      }),
    );
  }
}
