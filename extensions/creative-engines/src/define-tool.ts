import type { AnyAgentTool } from "openclaw/plugin-sdk/core";
// Shared helper that builds conforming OpenClaw agent tools for the creative
// engine surfaces. It adapts the engines' friendly `(args) => result` handlers
// into the real `AgentTool` contract: a typebox parameter schema, a UI label,
// and an `execute(toolCallId, params, ...)` that returns an `AgentToolResult`
// (`{ content: [{ type: "text", text }], details }`). Keeping this in one place
// avoids repeating the result-envelope boilerplate across every tool file.
import type { TSchema } from "typebox";

/** Registrar seam matching `api.registerTool` for a single tool. */
export type EngineToolRegistrar = (tool: AnyAgentTool) => void;

/** Friendly spec the engine tool files author; wrapped into an `AnyAgentTool`. */
export interface EngineToolSpec {
  name: string;
  /** UI label; defaults to `name` when omitted. */
  label?: string;
  description: string;
  parameters: TSchema;
  /** Runs the tool body and returns the structured result forwarded as details. */
  run: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

export function defineEngineTool(spec: EngineToolSpec): AnyAgentTool {
  return {
    name: spec.name,
    label: spec.label ?? spec.name,
    description: spec.description,
    parameters: spec.parameters,
    async execute(
      _toolCallId: string,
      params: unknown,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }> {
      const result = await spec.run((params ?? {}) as Record<string, unknown>);
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: "text", text }], details: result };
    },
  } satisfies AnyAgentTool;
}
