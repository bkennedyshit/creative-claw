// Creative Claw contract module defines canonical product schema shapes.
import type { CreativeCapabilityDescriptor, CreativePortDescriptor } from "./capability.js";
import { findConstraintConflict, isDataTypeCompatible } from "./data-type-compatibility.js";
import type { CreativeDataType } from "./data-types.js";
import type { CreativeGraph, CreativeGraphEdge, CreativeGraphNode } from "./graph.js";
import { CREATIVE_CAPABILITY_VERSION_PATTERN } from "./primitives.js";
import type { CreativeValidationIssue } from "./validation.js";

/**
 * Graph validation helpers shared by the validator entry point.
 *
 * Split from `validate-graph.ts` to keep each file inside the 500-line cap
 * enforced by `pnpm check:loc`.
 */

/**
 * Sentinel meaning "the graph's own interface" in an edge endpoint.
 *
 * An edge whose `sourceNodeId` is the graph id draws from a graph input; one
 * whose `targetNodeId` is the graph id feeds a graph output. Reusing the graph
 * id avoids adding a nullable endpoint field or a magic node, and a real node
 * can never collide because node ids live in the same namespace and are
 * rejected as duplicates.
 */
export function isGraphBoundary(graph: CreativeGraph, nodeId: string): boolean {
  return nodeId === graph.id;
}

/** Parsed capability version, comparable component-wise. */
export type ParsedVersion = { major: number; minor: number; patch: number };

/** Parse `major.minor.patch`, or undefined when malformed. */
export function parseVersion(value: string): ParsedVersion | undefined {
  const match = CREATIVE_CAPABILITY_VERSION_PATTERN.exec(value);
  if (!match) {
    return undefined;
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function isAtLeast(available: ParsedVersion, requested: ParsedVersion): boolean {
  if (available.minor !== requested.minor) {
    return available.minor > requested.minor;
  }
  return available.patch >= requested.patch;
}

/**
 * Registry snapshot indexed for lookup.
 *
 * Built once per validation run; spec 24 wants validation to complete without
 * executing media operations, so nothing here touches the filesystem.
 */
export type CapabilityIndex = Map<string, CreativeCapabilityDescriptor[]>;

/** Index descriptors by capability id, newest version first. */
export function indexCapabilities(
  descriptors: readonly CreativeCapabilityDescriptor[],
): CapabilityIndex {
  const index: CapabilityIndex = new Map();
  for (const descriptor of descriptors) {
    const bucket = index.get(descriptor.id);
    if (bucket) {
      bucket.push(descriptor);
    } else {
      index.set(descriptor.id, [descriptor]);
    }
  }
  for (const bucket of index.values()) {
    bucket.sort((left, right) => {
      const a = parseVersion(left.version);
      const b = parseVersion(right.version);
      if (!a || !b) {
        return 0;
      }
      return b.major - a.major || b.minor - a.minor || b.patch - a.patch;
    });
  }
  return index;
}

/** Outcome of resolving a node's capability against the registry. */
export type CapabilityResolution =
  | { kind: "resolved"; descriptor: CreativeCapabilityDescriptor }
  | { kind: "unknown-capability" }
  | { kind: "unsupported-version"; available: readonly string[] };

/**
 * Resolve the descriptor a node should execute against.
 *
 * An omitted `capabilityVersion` takes the newest registered version, which is
 * what a freshly authored graph wants. A pinned version requires the same major
 * — spec 25 increments the version on an incompatible parameter change, so
 * crossing a major boundary would silently reinterpret the node's parameters.
 */
export function resolveCapability(
  node: CreativeGraphNode,
  index: CapabilityIndex,
): CapabilityResolution {
  const bucket = index.get(node.capability);
  if (!bucket || bucket.length === 0) {
    return { kind: "unknown-capability" };
  }
  if (!node.capabilityVersion) {
    return { kind: "resolved", descriptor: bucket[0]! };
  }
  const requested = parseVersion(node.capabilityVersion);
  if (requested) {
    for (const descriptor of bucket) {
      const available = parseVersion(descriptor.version);
      if (available && available.major === requested.major && isAtLeast(available, requested)) {
        return { kind: "resolved", descriptor };
      }
    }
  }
  return { kind: "unsupported-version", available: bucket.map((entry) => entry.version) };
}

/** Data type and constraints of one endpoint, resolved from node or graph interface. */
export type ResolvedPort = {
  dataType: CreativeDataType;
  descriptor: CreativePortDescriptor | undefined;
};

function toResolvedPort(descriptor: CreativePortDescriptor): ResolvedPort {
  return { dataType: descriptor.dataType as CreativeDataType, descriptor };
}

/**
 * Resolve an edge's producing port.
 *
 * A graph-boundary source reads the graph's declared `inputs`: from inside the
 * graph, a graph input behaves as an output that feeds nodes.
 */
export function resolveSourcePort(
  graph: CreativeGraph,
  edge: CreativeGraphEdge,
  descriptor: CreativeCapabilityDescriptor | undefined,
): ResolvedPort | undefined {
  if (isGraphBoundary(graph, edge.sourceNodeId)) {
    const port = graph.inputs.find((entry) => entry.name === edge.sourcePort);
    return port
      ? {
          dataType: port.dataType as CreativeDataType,
          descriptor: {
            dataType: port.dataType,
            required: port.required,
            constraints: port.constraints,
          },
        }
      : undefined;
  }
  const port = descriptor?.outputs[edge.sourcePort];
  return port ? toResolvedPort(port) : undefined;
}

/** Resolve an edge's consuming port; a graph-boundary target writes a graph output. */
export function resolveTargetPort(
  graph: CreativeGraph,
  edge: CreativeGraphEdge,
  descriptor: CreativeCapabilityDescriptor | undefined,
): ResolvedPort | undefined {
  if (isGraphBoundary(graph, edge.targetNodeId)) {
    const port = graph.outputs.find((entry) => entry.name === edge.targetPort);
    return port
      ? {
          dataType: port.dataType as CreativeDataType,
          descriptor: {
            dataType: port.dataType,
            required: port.required,
            constraints: port.constraints,
          },
        }
      : undefined;
  }
  const port = descriptor?.inputs[edge.targetPort];
  return port ? toResolvedPort(port) : undefined;
}

/** Type and constraint findings for one edge, empty when the edge is sound. */
export function checkEdgeCompatibility(
  edge: CreativeGraphEdge,
  source: ResolvedPort,
  target: ResolvedPort,
): CreativeValidationIssue[] {
  if (!isDataTypeCompatible(source.dataType, target.dataType)) {
    return [
      {
        code: "incompatible-connection",
        severity: "error",
        message: `Cannot connect ${source.dataType} output to ${target.dataType} input.`,
        edgeId: edge.id,
        nodeId: edge.targetNodeId,
        port: edge.targetPort,
        suggestion: `Insert a conversion node that outputs ${target.dataType}.`,
      },
    ];
  }
  const conflict = findConstraintConflict(
    source.descriptor?.constraints,
    target.descriptor?.constraints,
  );
  if (!conflict) {
    return [];
  }
  return [
    {
      code: "unsupported-media-constraint",
      severity: "error",
      message: `Constraint ${conflict.field} conflicts: source allows ${conflict.source}, target requires ${conflict.target}.`,
      edgeId: edge.id,
      nodeId: edge.targetNodeId,
      port: edge.targetPort,
      suggestion: `Adjust ${conflict.field} on the upstream node or insert a conversion node.`,
    },
  ];
}

/**
 * Node ids that participate in a cycle, spec 10.3.
 *
 * Kahn's algorithm: whatever still has unsatisfied predecessors after the
 * topological sweep is exactly the cyclic remainder. Graph-boundary endpoints
 * are excluded because the interface is not a schedulable node and would
 * otherwise appear as a phantom participant.
 */
export function findCycleNodeIds(graph: CreativeGraph): string[] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of graph.nodes) {
    indegree.set(node.id, 0);
    dependents.set(node.id, []);
  }

  for (const edge of graph.edges) {
    if (isGraphBoundary(graph, edge.sourceNodeId) || isGraphBoundary(graph, edge.targetNodeId)) {
      continue;
    }
    if (!indegree.has(edge.sourceNodeId) || !indegree.has(edge.targetNodeId)) {
      continue;
    }
    dependents.get(edge.sourceNodeId)!.push(edge.targetNodeId);
    indegree.set(edge.targetNodeId, indegree.get(edge.targetNodeId)! + 1);
  }

  const ready = [...indegree.entries()].filter(([, count]) => count === 0).map(([id]) => id);
  const settled = new Set<string>();
  while (ready.length > 0) {
    const current = ready.pop()!;
    settled.add(current);
    for (const dependent of dependents.get(current) ?? []) {
      const remaining = indegree.get(dependent)! - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
      }
    }
  }

  return graph.nodes.map((node) => node.id).filter((id) => !settled.has(id));
}

/**
 * Required parameter names declared by an opaque JSON Schema.
 *
 * `parametersSchema` is authored per capability and stays untyped in the
 * contract (spec 10.2), so this reads the standard `required` array defensively
 * and treats anything else as "no required parameters" rather than throwing on
 * a hand-written schema.
 */
export function requiredParameterNames(
  descriptor: CreativeCapabilityDescriptor,
): readonly string[] {
  const required = (descriptor.parametersSchema as { required?: unknown }).required;
  if (!Array.isArray(required)) {
    return [];
  }
  return required.filter((entry): entry is string => typeof entry === "string");
}
