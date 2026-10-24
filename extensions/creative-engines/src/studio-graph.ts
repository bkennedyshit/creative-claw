import {
  CreativeGraphSchema,
  type CreativeCapabilityDescriptor,
  type CreativeGraph,
} from "@openclaw/creative-contracts";
import { Check } from "typebox/value";
import {
  getCreativeCapability,
  validateCreativeGraph,
  validateOperationParameters,
} from "./capabilities.js";

export const STUDIO_FILE_TYPES = ["image", "audio", "video", "vector"] as const;
export type StudioFileType = (typeof STUDIO_FILE_TYPES)[number];
export function isStudioFileType(value: string): value is StudioFileType {
  return STUDIO_FILE_TYPES.some((type) => type === value);
}

/** Resolve defaults once, then validate the exact immutable snapshot being executed. */
export function prepareStudioGraph(value: unknown): {
  graph: CreativeGraph;
  capabilities: Map<string, CreativeCapabilityDescriptor>;
} {
  if (!Check(CreativeGraphSchema, value) || value.projectId !== "studio") {
    throw new Error("Expected a canonical Studio graph");
  }
  if (value.nodes.length < 1 || value.nodes.length > 32) {
    throw new Error("A workflow must contain 1–32 nodes");
  }
  if (
    value.inputs.length !== 1 ||
    value.outputs.length !== 1 ||
    !isStudioFileType(value.inputs[0].dataType)
  ) {
    throw new Error("Studio workflows need one source file input and one result output");
  }
  const capabilities = new Map<string, CreativeCapabilityDescriptor>();
  const graph = structuredClone(value);
  for (const node of graph.nodes) {
    if (node.disabled) {
      continue;
    }
    const cap = getCreativeCapability(node.capability);
    if (!cap) {
      throw new Error(`Node ${node.id}: unknown capability ${node.capability}`);
    }
    if (
      Object.keys(cap.inputs).length !== 1 ||
      Object.keys(cap.outputs).length !== 1 ||
      !Object.values(cap.inputs).every((port) => isStudioFileType(port.dataType)) ||
      !Object.values(cap.outputs).every((port) => isStudioFileType(port.dataType))
    ) {
      throw new Error(`Node ${node.id}: this operation needs a specialized editor`);
    }
    const parameters = validateOperationParameters(cap, node.parameters);
    if (!parameters.valid) {
      throw new Error(`Node ${node.id}: ${parameters.errors.join("; ")}`);
    }
    node.parameters = parameters.resolvedParams;
    capabilities.set(node.id, cap);
  }
  const validation = validateCreativeGraph(graph);
  if (!validation.valid) {
    throw new Error(validation.issues.map((issue) => issue.message).join("; "));
  }
  for (const edge of graph.edges) {
    if (
      capabilities.has(edge.targetNodeId) &&
      edge.sourceNodeId !== graph.id &&
      !capabilities.has(edge.sourceNodeId)
    ) {
      throw new Error(
        `Node ${edge.targetNodeId}: reconnect its input; the upstream node is disabled`,
      );
    }
  }
  const result = graph.edges.find(
    (edge) => edge.targetNodeId === graph.id && edge.targetPort === graph.outputs[0].name,
  );
  if (!result || !capabilities.has(result.sourceNodeId)) {
    throw new Error("Connect an enabled operation to the workflow result");
  }
  return { graph, capabilities };
}
