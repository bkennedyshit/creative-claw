// Creative Claw contract module defines canonical product schema shapes.
import { type Static, Type } from "typebox";
import { CreativeDataTypeSchema, CreativeMediaConstraintsSchema } from "./data-types.js";
import {
  CreativeCapabilityIdSchema,
  CreativeCapabilityVersionSchema,
  CreativePortNameSchema,
  NonEmptyString,
} from "./primitives.js";

/**
 * Capability descriptor, spec 10.2.
 *
 * One descriptor per node type drives agent discovery, graph validation, Studio
 * inspector forms, preflight, approvals, and test generation. Spec 10.2 forbids
 * those consumers from keeping their own handwritten operation catalogs, so any
 * fact a consumer needs about an operation belongs here.
 */

/** Capability families, spec 10.2. */
export const CREATIVE_CAPABILITY_FAMILIES = [
  "text",
  "image",
  "audio",
  "video-edit",
  "video-vfx",
  "vector",
  "provider",
  "utility",
  "publish",
] as const;

/** Closed capability family schema. */
export const CreativeCapabilityFamilySchema = Type.String({
  enum: [...CREATIVE_CAPABILITY_FAMILIES],
});

/** Capability family union. */
export type CreativeCapabilityFamily = (typeof CREATIVE_CAPABILITY_FAMILIES)[number];

/** Execution runtimes that can back a capability, spec 10.2. */
export const CREATIVE_EXECUTION_RUNTIMES = [
  "native",
  "node",
  "python",
  "provider",
  "external",
] as const;

/** Closed execution runtime schema. */
export const CreativeExecutionRuntimeSchema = Type.String({
  enum: [...CREATIVE_EXECUTION_RUNTIMES],
});

/** Execution runtime union. */
export type CreativeExecutionRuntime = (typeof CREATIVE_EXECUTION_RUNTIMES)[number];

/** GPU requirement levels, spec 10.2. */
export const CREATIVE_GPU_REQUIREMENTS = ["none", "optional", "required"] as const;

/** Closed GPU requirement schema. */
export const CreativeGpuRequirementSchema = Type.String({
  enum: [...CREATIVE_GPU_REQUIREMENTS],
});

/** GPU requirement union. */
export type CreativeGpuRequirement = (typeof CREATIVE_GPU_REQUIREMENTS)[number];

/**
 * One declared input or output port.
 *
 * On an input, `required` means the graph is invalid unless an edge or graph
 * input supplies it. On an output, `required` means the capability always
 * produces the port, so downstream nodes may depend on it unconditionally;
 * an optional output may be absent at runtime.
 */
export const CreativePortDescriptorSchema = Type.Object(
  {
    dataType: CreativeDataTypeSchema,
    required: Type.Boolean(),
    description: Type.Optional(NonEmptyString),
    constraints: Type.Optional(CreativeMediaConstraintsSchema),
  },
  { additionalProperties: false },
);

/** One declared input or output port. */
export type CreativePortDescriptor = Static<typeof CreativePortDescriptorSchema>;

const PortMapSchema = Type.Record(CreativePortNameSchema, CreativePortDescriptorSchema);

/**
 * Execution properties that decide scheduling, progress UI, and cacheability.
 *
 * `deterministic` and `cacheable` are distinct: a deterministic operation may
 * still be uncacheable when its output is too large to retain, and spec 10.4
 * requires cache hits to verify both content hash and capability version.
 */
export const CreativeCapabilityExecutionSchema = Type.Object(
  {
    runtime: CreativeExecutionRuntimeSchema,
    supportsProgress: Type.Boolean(),
    supportsCancellation: Type.Boolean(),
    deterministic: Type.Boolean(),
    cacheable: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** Capability execution properties. */
export type CreativeCapabilityExecution = Static<typeof CreativeCapabilityExecutionSchema>;

/**
 * External resources a capability needs before it can run.
 *
 * Preflight (spec 22) reads these to report a missing runtime, DLL, model, or
 * unconfigured provider without exposing secret values. Absent fields mean the
 * capability needs nothing of that kind.
 */
export const CreativeCapabilityRequirementsSchema = Type.Object(
  {
    binaries: Type.Optional(Type.Array(NonEmptyString)),
    models: Type.Optional(Type.Array(NonEmptyString)),
    provider: Type.Optional(NonEmptyString),
    gpu: Type.Optional(CreativeGpuRequirementSchema),
  },
  { additionalProperties: false },
);

/** Capability external requirements. */
export type CreativeCapabilityRequirements = Static<typeof CreativeCapabilityRequirementsSchema>;

/**
 * Consequences that decide whether execution needs approval, spec 14.
 *
 * Approval is driven by consequence, not by who authored the graph, so these
 * flags are the sole input to the approval gate for a node. `estimatedCost`
 * declares that the capability can produce a cost estimate, not the cost.
 */
export const CreativeCapabilityRiskSchema = Type.Object(
  {
    writesFiles: Type.Boolean(),
    mayOverwrite: Type.Boolean(),
    externalUpload: Type.Boolean(),
    publishes: Type.Boolean(),
    estimatedCost: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Capability risk declaration. */
export type CreativeCapabilityRisk = Static<typeof CreativeCapabilityRiskSchema>;

/**
 * Full capability descriptor.
 *
 * `parametersSchema` is a JSON Schema object rather than a typed shape: it is
 * authored per capability and rendered into Studio inspector controls, so it
 * stays opaque to this contract and is validated by the runtime JSON Schema
 * helper at execution time.
 */
export const CreativeCapabilityDescriptorSchema = Type.Object(
  {
    id: CreativeCapabilityIdSchema,
    version: CreativeCapabilityVersionSchema,
    family: CreativeCapabilityFamilySchema,
    label: NonEmptyString,
    description: NonEmptyString,
    inputs: PortMapSchema,
    outputs: PortMapSchema,
    parametersSchema: Type.Record(Type.String(), Type.Unknown()),
    execution: CreativeCapabilityExecutionSchema,
    requirements: CreativeCapabilityRequirementsSchema,
    risk: CreativeCapabilityRiskSchema,
  },
  { additionalProperties: false },
);

/** Full capability descriptor. */
export type CreativeCapabilityDescriptor = Static<typeof CreativeCapabilityDescriptorSchema>;
