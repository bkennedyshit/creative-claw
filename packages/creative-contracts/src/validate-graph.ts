// Creative Claw contract module defines canonical product schema shapes.
import type { CreativeCapabilityDescriptor } from "./capability.js";
import type { CreativeGraph, CreativeGraphNode } from "./graph.js";
import {
  type CapabilityIndex,
  checkEdgeCompatibility,
  findCycleNodeIds,
  indexCapabilities,
  isGraphBoundary,
  requiredParameterNames,
  resolveCapability,
  resolveSourcePort,
  resolveTargetPort,
} from "./validate-graph-internals.js";
import {
  buildValidationResult,
  type CreativeValidationIssue,
  type CreativeValidationResult,
} from "./validation.js";

/**
 * Pure graph validator, spec 10.3.
 *
 * Runs before execution and performs no I/O: spec 24 requires validation to
 * complete without executing media operations. Checks that need machine facts —
 * an offline asset, a missing model, an unsafe overwrite target — are delegated
 * to caller-supplied hooks so this module never fabricates an answer about the
 * environment.
 */

/** A missing external requirement reported by the caller. */
export type RequirementQuery = {
  kind: "binary" | "model" | "provider" | "gpu";
  name: string;
  nodeId: string;
};

/** Caller-supplied environment probes. Omitted probes simply skip their checks. */
export type CreativeValidationHooks = {
  /**
   * Report whether an external requirement is satisfied on this machine.
   *
   * Returning `undefined` means "unknown", which is treated as satisfied: an
   * unimplemented probe must not turn every GPU node into a validation error.
   */
  resolveRequirement?: (
    query: RequirementQuery,
  ) => { satisfied: boolean; reason?: string } | undefined;
  /**
   * Contribute findings only the caller can decide, such as an unreadable
   * source asset (`invalid-source-asset`) or an unsafe overwrite target
   * (`unsafe-target`).
   */
  inspectNode?: (
    node: CreativeGraphNode,
    descriptor: CreativeCapabilityDescriptor,
  ) => readonly CreativeValidationIssue[];
};

/** Validator inputs. */
export type ValidateGraphOptions = {
  graph: CreativeGraph;
  capabilities: readonly CreativeCapabilityDescriptor[];
  hooks?: CreativeValidationHooks;
};

function checkIdentifiers(graph: CreativeGraph, issues: CreativeValidationIssue[]): void {
  const seenNodes = new Set<string>();
  for (const node of graph.nodes) {
    if (node.id === graph.id) {
      issues.push({
        code: "duplicate-node-id",
        severity: "error",
        message: `Node id ${node.id} collides with the graph boundary id.`,
        nodeId: node.id,
        suggestion: "Give the node an id different from the graph id.",
      });
    }
    if (seenNodes.has(node.id)) {
      issues.push({
        code: "duplicate-node-id",
        severity: "error",
        message: `Duplicate node id ${node.id}.`,
        nodeId: node.id,
        suggestion: "Give each node a unique id.",
      });
    }
    seenNodes.add(node.id);
  }

  const seenEdges = new Set<string>();
  for (const edge of graph.edges) {
    if (seenEdges.has(edge.id)) {
      issues.push({
        code: "duplicate-edge-id",
        severity: "error",
        message: `Duplicate edge id ${edge.id}.`,
        edgeId: edge.id,
        suggestion: "Give each edge a unique id.",
      });
    }
    seenEdges.add(edge.id);
  }
}

function checkInterface(graph: CreativeGraph, issues: CreativeValidationIssue[]): void {
  for (const [label, ports] of [
    ["input", graph.inputs],
    ["output", graph.outputs],
  ] as const) {
    const seen = new Set<string>();
    for (const port of ports) {
      if (seen.has(port.name)) {
        issues.push({
          code: "invalid-subgraph-interface",
          severity: "error",
          message: `Duplicate graph ${label} port ${port.name}.`,
          port: port.name,
          suggestion: `Rename one of the graph ${label} ports.`,
        });
      }
      seen.add(port.name);
    }
  }
}

function checkNodes(
  graph: CreativeGraph,
  index: CapabilityIndex,
  hooks: CreativeValidationHooks | undefined,
  issues: CreativeValidationIssue[],
): Map<string, CreativeCapabilityDescriptor> {
  const resolved = new Map<string, CreativeCapabilityDescriptor>();

  for (const node of graph.nodes) {
    const resolution = resolveCapability(node, index);
    if (resolution.kind === "unknown-capability") {
      issues.push({
        code: "unknown-capability",
        severity: "error",
        message: `Unknown capability ${node.capability}.`,
        nodeId: node.id,
        suggestion: "Install the plugin that provides this capability, or replace the node.",
      });
      continue;
    }
    if (resolution.kind === "unsupported-version") {
      issues.push({
        code: "unsupported-capability-version",
        severity: "error",
        message: `Capability ${node.capability} has no version compatible with ${node.capabilityVersion}; available: ${resolution.available.join(", ")}.`,
        nodeId: node.id,
        suggestion: "Run the graph migration, or pin a compatible capability version.",
      });
      continue;
    }

    const descriptor = resolution.descriptor;
    resolved.set(node.id, descriptor);

    for (const name of requiredParameterNames(descriptor)) {
      if (node.parameters[name] === undefined) {
        issues.push({
          code: "missing-required-parameter",
          severity: "error",
          message: `Node ${node.id} is missing required parameter ${name}.`,
          nodeId: node.id,
          parameter: name,
          suggestion: `Set ${name} in the inspector.`,
        });
      }
    }

    collectRequirementIssues(node, descriptor, hooks, issues);
    if (hooks?.inspectNode) {
      issues.push(...hooks.inspectNode(node, descriptor));
    }
  }

  return resolved;
}

function collectRequirementIssues(
  node: CreativeGraphNode,
  descriptor: CreativeCapabilityDescriptor,
  hooks: CreativeValidationHooks | undefined,
  issues: CreativeValidationIssue[],
): void {
  const probe = hooks?.resolveRequirement;
  if (!probe) {
    return;
  }
  const queries: RequirementQuery[] = [
    ...(descriptor.requirements.binaries ?? []).map(
      (name) => ({ kind: "binary", name, nodeId: node.id }) as const,
    ),
    ...(descriptor.requirements.models ?? []).map(
      (name) => ({ kind: "model", name, nodeId: node.id }) as const,
    ),
  ];
  if (descriptor.requirements.provider) {
    queries.push({ kind: "provider", name: descriptor.requirements.provider, nodeId: node.id });
  }
  // Only a hard GPU requirement can fail validation; `optional` falls back to
  // CPU, and spec 3 requires honest degradation rather than a blocked graph.
  if (descriptor.requirements.gpu === "required") {
    queries.push({ kind: "gpu", name: "gpu", nodeId: node.id });
  }

  for (const query of queries) {
    const outcome = probe(query);
    if (!outcome || outcome.satisfied) {
      continue;
    }
    issues.push({
      code: "missing-requirement",
      severity: "error",
      message: `Node ${node.id} needs ${query.kind} ${query.name}: ${outcome.reason ?? "not available"}.`,
      nodeId: node.id,
      suggestion: `Install or configure ${query.name}, then revalidate.`,
    });
  }
}

function checkEdges(
  graph: CreativeGraph,
  resolved: Map<string, CreativeCapabilityDescriptor>,
  issues: CreativeValidationIssue[],
): Set<string> {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const filledInputs = new Set<string>();
  const claimedInputs = new Set<string>();

  for (const edge of graph.edges) {
    const sourceIsBoundary = isGraphBoundary(graph, edge.sourceNodeId);
    const targetIsBoundary = isGraphBoundary(graph, edge.targetNodeId);

    if (!sourceIsBoundary && !nodeIds.has(edge.sourceNodeId)) {
      issues.push(danglingEdge(edge.id, edge.sourceNodeId));
      continue;
    }
    if (!targetIsBoundary && !nodeIds.has(edge.targetNodeId)) {
      issues.push(danglingEdge(edge.id, edge.targetNodeId));
      continue;
    }

    const source = resolveSourcePort(graph, edge, resolved.get(edge.sourceNodeId));
    if (!source) {
      issues.push(unknownPort(edge.id, edge.sourceNodeId, edge.sourcePort, "output"));
      continue;
    }
    const target = resolveTargetPort(graph, edge, resolved.get(edge.targetNodeId));
    if (!target) {
      issues.push(unknownPort(edge.id, edge.targetNodeId, edge.targetPort, "input"));
      continue;
    }

    // One input port accepts one connection; fan-in would make execution order
    // decide the value, which spec 10.4 forbids by requiring determinism.
    const inputKey = `${edge.targetNodeId}\u0000${edge.targetPort}`;
    if (claimedInputs.has(inputKey)) {
      issues.push({
        code: "duplicate-connection",
        severity: "error",
        message: `Input ${edge.targetPort} on ${edge.targetNodeId} already has a connection.`,
        edgeId: edge.id,
        nodeId: edge.targetNodeId,
        port: edge.targetPort,
        suggestion: "Remove the other edge, or merge upstream values with a utility node.",
      });
    }
    claimedInputs.add(inputKey);
    filledInputs.add(inputKey);

    issues.push(...checkEdgeCompatibility(edge, source, target));
  }

  return filledInputs;
}

function danglingEdge(edgeId: string, missingNodeId: string): CreativeValidationIssue {
  return {
    code: "dangling-edge",
    severity: "error",
    message: `Edge ${edgeId} references missing node ${missingNodeId}.`,
    edgeId,
    suggestion: "Delete the edge, or restore the node it referenced.",
  };
}

function unknownPort(
  edgeId: string,
  nodeId: string,
  port: string,
  direction: "input" | "output",
): CreativeValidationIssue {
  return {
    code: "unknown-port",
    severity: "error",
    message: `Node ${nodeId} has no ${direction} port ${port}.`,
    edgeId,
    nodeId,
    port,
    suggestion: `Reconnect the edge to a declared ${direction} port.`,
  };
}

function checkRequiredInputs(
  graph: CreativeGraph,
  resolved: Map<string, CreativeCapabilityDescriptor>,
  filledInputs: Set<string>,
  issues: CreativeValidationIssue[],
): void {
  for (const node of graph.nodes) {
    if (node.disabled) {
      continue;
    }
    const descriptor = resolved.get(node.id);
    if (!descriptor) {
      continue;
    }
    for (const [name, port] of Object.entries(descriptor.inputs)) {
      if (!port.required) {
        continue;
      }
      if (!filledInputs.has(`${node.id}\u0000${name}`)) {
        issues.push({
          code: "missing-required-port",
          severity: "error",
          message: `Node ${node.id} has no connection for required input ${name}.`,
          nodeId: node.id,
          port: name,
          suggestion: `Connect an upstream ${port.dataType} output to ${name}.`,
        });
      }
    }
  }
}

function checkDisabledDependencies(graph: CreativeGraph, issues: CreativeValidationIssue[]): void {
  const disabled = new Set(graph.nodes.filter((node) => node.disabled).map((node) => node.id));
  if (disabled.size === 0) {
    return;
  }
  for (const edge of graph.edges) {
    if (!disabled.has(edge.sourceNodeId) || disabled.has(edge.targetNodeId)) {
      continue;
    }
    if (isGraphBoundary(graph, edge.targetNodeId)) {
      continue;
    }
    issues.push({
      code: "disabled-node-dependency",
      severity: "error",
      message: `Node ${edge.targetNodeId} depends on disabled node ${edge.sourceNodeId}.`,
      edgeId: edge.id,
      nodeId: edge.targetNodeId,
      port: edge.targetPort,
      suggestion: `Re-enable ${edge.sourceNodeId}, or disable the downstream node too.`,
    });
  }
}

function checkReachableOutputs(
  graph: CreativeGraph,
  filledInputs: Set<string>,
  issues: CreativeValidationIssue[],
): void {
  for (const port of graph.outputs) {
    if (!port.required) {
      continue;
    }
    if (!filledInputs.has(`${graph.id}\u0000${port.name}`)) {
      issues.push({
        code: "unreachable-required-output",
        severity: "error",
        message: `Required graph output ${port.name} has no producing connection.`,
        port: port.name,
        suggestion: `Connect a node output to graph output ${port.name}.`,
      });
    }
  }
}

/**
 * Validate a graph against a capability registry snapshot.
 *
 * Findings are ordered structurally — identifiers, interface, nodes, edges,
 * then reachability — so the same graph always produces the same list. Spec 23
 * traces and prompt caching both depend on that stability.
 */
export function validateGraph(options: ValidateGraphOptions): CreativeValidationResult {
  const { graph, capabilities, hooks } = options;
  const issues: CreativeValidationIssue[] = [];
  const index = indexCapabilities(capabilities);

  checkIdentifiers(graph, issues);
  checkInterface(graph, issues);

  const resolved = checkNodes(graph, index, hooks, issues);
  const filledInputs = checkEdges(graph, resolved, issues);

  checkRequiredInputs(graph, resolved, filledInputs, issues);
  checkDisabledDependencies(graph, issues);
  checkReachableOutputs(graph, filledInputs, issues);

  const cycleNodeIds = findCycleNodeIds(graph);
  if (cycleNodeIds.length > 0) {
    issues.push({
      code: "cycle",
      severity: "error",
      message: `Graph contains a cycle through: ${cycleNodeIds.join(", ")}.`,
      nodeIds: cycleNodeIds,
      suggestion: "Remove one edge in the cycle; execution requires a directed acyclic graph.",
    });
  }

  return buildValidationResult(issues);
}
