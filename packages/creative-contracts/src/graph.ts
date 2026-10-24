// Creative Claw contract module defines canonical product schema shapes.
import { type Static, Type } from "typebox";
import { CreativeDataTypeSchema, CreativeMediaConstraintsSchema } from "./data-types.js";
import {
  CanvasPositionSchema,
  CreativeCapabilityIdSchema,
  CreativeCapabilityVersionSchema,
  CreativeIdSchema,
  CreativePortNameSchema,
  IsoTimestampSchema,
  MetadataSchema,
  NonEmptyString,
  ParametersSchema,
  SchemaVersionSchema,
} from "./primitives.js";

/**
 * Canonical workflow graph, spec 10.
 *
 * The typed-port model from the `video-agent-ai` repository is the starting
 * point; the legacy `creative graph` JSON is a compatible subset that receives
 * an importer rather than a second persisted format (spec 10, spec 25).
 */

/** Per-node cache policies, spec 10 node shape. */
export const CREATIVE_CACHE_POLICIES = ["auto", "always", "never"] as const;

/** Closed cache policy schema. */
export const CreativeCachePolicySchema = Type.String({ enum: [...CREATIVE_CACHE_POLICIES] });

/** Cache policy union. */
export type CreativeCachePolicy = (typeof CREATIVE_CACHE_POLICIES)[number];

/**
 * One graph node.
 *
 * `capabilityVersion` is optional: omitting it pins the node to whatever
 * version the registry currently resolves, which is what a freshly authored
 * graph wants. Persisted runs record the resolved version in their trace
 * (spec 23) so a later incompatible bump is detectable.
 *
 * A `disabled` node is retained in the graph and skipped at execution, so the
 * creator can mute a stage without losing its parameters or layout.
 */
export const CreativeGraphNodeSchema = Type.Object(
  {
    id: CreativeIdSchema,
    capability: CreativeCapabilityIdSchema,
    capabilityVersion: Type.Optional(CreativeCapabilityVersionSchema),
    label: Type.Optional(NonEmptyString),
    parameters: ParametersSchema,
    position: Type.Optional(CanvasPositionSchema),
    disabled: Type.Optional(Type.Boolean()),
    cachePolicy: Type.Optional(CreativeCachePolicySchema),
  },
  { additionalProperties: false },
);

/** One graph node. */
export type CreativeGraphNode = Static<typeof CreativeGraphNodeSchema>;

/** One directed connection between an output port and an input port. */
export const CreativeGraphEdgeSchema = Type.Object(
  {
    id: CreativeIdSchema,
    sourceNodeId: CreativeIdSchema,
    sourcePort: CreativePortNameSchema,
    targetNodeId: CreativeIdSchema,
    targetPort: CreativePortNameSchema,
  },
  { additionalProperties: false },
);

/** One graph edge. */
export type CreativeGraphEdge = Static<typeof CreativeGraphEdgeSchema>;

/**
 * One port on the graph's own interface, used when the graph is a subgraph or
 * a reusable workflow template (spec 10, spec 17).
 */
export const GraphInterfacePortSchema = Type.Object(
  {
    name: CreativePortNameSchema,
    dataType: CreativeDataTypeSchema,
    required: Type.Boolean(),
    description: Type.Optional(NonEmptyString),
    constraints: Type.Optional(CreativeMediaConstraintsSchema),
  },
  { additionalProperties: false },
);

/** One graph interface port. */
export type GraphInterfacePort = Static<typeof GraphInterfacePortSchema>;

/**
 * Full workflow graph.
 *
 * `revision` increments on every accepted edit and is captured by a graph run
 * (spec 10.4), which is what makes a run reproducible against the exact graph
 * that produced it. `id` is stable across renames so artifacts keep resolving.
 */
export const CreativeGraphSchema = Type.Object(
  {
    schemaVersion: SchemaVersionSchema,
    id: CreativeIdSchema,
    projectId: CreativeIdSchema,
    name: NonEmptyString,
    description: Type.Optional(NonEmptyString),
    revision: Type.Integer({ minimum: 0 }),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    nodes: Type.Array(CreativeGraphNodeSchema),
    edges: Type.Array(CreativeGraphEdgeSchema),
    inputs: Type.Array(GraphInterfacePortSchema),
    outputs: Type.Array(GraphInterfacePortSchema),
    metadata: MetadataSchema,
  },
  { additionalProperties: false },
);

/** Full workflow graph. */
export type CreativeGraph = Static<typeof CreativeGraphSchema>;
