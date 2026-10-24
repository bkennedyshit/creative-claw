import { Type } from "typebox";
import {
  getCreativeCapability,
  searchCreativeCapabilities,
  validateCreativeGraph,
} from "../capabilities.js";
import { defineEngineTool, type EngineToolRegistrar } from "../define-tool.js";

/**
 * Registers compact Creative Claw discovery tools for agents and the Codex bridge.
 * These replace injecting 280 individual op schemas with 3 high-leverage tools:
 * 1. creative.capabilities.search
 * 2. creative.capabilities.get
 * 3. creative.graph.validate
 */
export function registerDiscoveryTools(registerTool: EngineToolRegistrar): void {
  // 1. Search capabilities
  registerTool(
    defineEngineTool({
      name: "creative.capabilities.search",
      description:
        "Search Creative Claw native media capabilities and operations by description or keyword. " +
        "Returns compact matching capabilities (id, family, label, description, inputs, outputs).",
      parameters: Type.Object({
        query: Type.String({
          description:
            "Search query describing what you want to do (e.g. 'cut video', 'invert image', 'blur background', 'stabilize')",
        }),
        family: Type.Optional(
          Type.String({
            description:
              "Optional capability family filter: 'image' | 'audio' | 'video-edit' | 'vector'",
          }),
        ),
        limit: Type.Optional(
          Type.Number({
            description: "Maximum number of results to return (default 10)",
          }),
        ),
      }),
      run(args) {
        const query = typeof args.query === "string" ? args.query : "";
        const family = typeof args.family === "string" ? args.family : undefined;
        const limit = typeof args.limit === "number" ? args.limit : 10;
        const matches = searchCreativeCapabilities(query, { family, limit });
        return {
          count: matches.length,
          capabilities: matches.map((d) => ({
            id: d.id,
            family: d.family,
            label: d.label,
            description: d.description,
            inputs: d.inputs,
            outputs: d.outputs,
            execution: {
              runtime: d.execution.runtime,
              deterministic: d.execution.deterministic,
            },
          })),
        };
      },
    }),
  );

  // 2. Get full capability descriptor and parametersSchema
  registerTool(
    defineEngineTool({
      name: "creative.capabilities.get",
      description:
        "Retrieve the full canonical capability descriptor, parametersSchema, requirements, and risk for a specific operation ID.",
      parameters: Type.Object({
        id: Type.String({
          description:
            "The capability ID to inspect (e.g. 'video.cut_clip', 'image.crop', 'image.remove_background')",
        }),
      }),
      run(args) {
        const id = typeof args.id === "string" ? args.id.trim() : "";
        const capability = getCreativeCapability(id);
        if (!capability) {
          return {
            found: false,
            error: `Capability '${id}' not found in registered engines`,
          };
        }
        return {
          found: true,
          capability,
        };
      },
    }),
  );

  // 3. Pure graph validator
  registerTool(
    defineEngineTool({
      name: "creative.graph.validate",
      description:
        "Purely validate a Creative Claw execution graph structure, port type compatibility, parameter requirements, and acyclicity without performing I/O or media execution.",
      parameters: Type.Object({
        graph: Type.Record(Type.String(), Type.Unknown(), {
          description: "Creative Claw graph structure to validate",
        }),
      }),
      run(args) {
        const result = validateCreativeGraph(args.graph);
        return {
          valid: result.valid,
          ok: result.valid,
          issues: result.issues,
        };
      },
    }),
  );
}
