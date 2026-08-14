import { Type } from "typebox";
import { defineEngineTool, type EngineToolRegistrar } from "../define-tool.js";
import type { EngineRuntime } from "../runtime/engine-runtime.js";
import type { Step } from "../types.js";

const ENGINE_NAMES = ["image", "audio", "video", "vector"] as const;

/**
 * Registers per-engine batch tools:
 *   <engine>.batch — process multiple inputs through a pipeline.
 *   One failure never aborts the batch.
 */
export function registerBatchTools(
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
        name: `${name}.batch`,
        description: `Run a batch pipeline over multiple ${name} inputs. One failure never aborts the batch.`,
        parameters: Type.Object({
          input_set: Type.Object(
            {
              glob: Type.Optional(Type.String({ description: "Glob pattern for input files" })),
              folder: Type.Optional(
                Type.String({ description: "Folder path containing input files" }),
              ),
              list: Type.Optional(
                Type.Array(Type.String(), { description: "Explicit list of file paths" }),
              ),
            },
            {
              description: "Input specification: glob pattern, folder path, or explicit file list",
            },
          ),
          pipeline: Type.Array(
            Type.Object({
              op: Type.String(),
              params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
            }),
            { description: "Pipeline of operations to apply to each input" },
          ),
          output_dir: Type.String({ description: "Output directory for processed files" }),
        }),
        async run(args) {
          const inputSet = args.input_set as { glob?: string; folder?: string; list?: string[] };
          const pipeline = args.pipeline as Step[];
          const outputDir = args.output_dir as string;

          const result = await engine.batch(inputSet, pipeline, outputDir);
          return {
            summary: {
              total: result.manifest.total_items,
              succeeded: result.manifest.succeeded,
              failed: result.manifest.failed,
              output_dir: result.manifest.output_dir,
            },
            items: result.items,
            manifest: result.manifest,
          };
        },
      }),
    );
  }
}
