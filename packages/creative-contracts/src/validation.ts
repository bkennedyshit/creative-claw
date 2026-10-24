// Creative Claw contract module defines canonical product schema shapes.
import { type Static, Type } from "typebox";
import { CreativeIdSchema, CreativePortNameSchema, NonEmptyString } from "./primitives.js";

/**
 * Structured validation errors, spec 10.3.
 *
 * Spec 10.3 requires every finding to carry node, port, parameter, severity, and
 * a suggested resolution. Freeform message strings are not a contract: the
 * `code` is what the Studio, tests, and agent branch on, so codes are a closed
 * set (root AGENTS.md: closed codes over freeform strings).
 */

/**
 * Closed finding codes.
 *
 * The first group is decidable from the graph plus the capability registry. The
 * second group needs runtime facts (filesystem, installed models, configured
 * providers) and is only emitted when the caller supplies the matching
 * resolver hook, so the validator never guesses about the machine.
 */
export const CREATIVE_VALIDATION_CODES = [
  // Structural — decidable from graph + registry.
  "unknown-capability",
  "unsupported-capability-version",
  "duplicate-node-id",
  "duplicate-edge-id",
  "unknown-port",
  "missing-required-port",
  "missing-required-parameter",
  "incompatible-connection",
  "unsupported-media-constraint",
  "duplicate-connection",
  "dangling-edge",
  "cycle",
  "unreachable-required-output",
  "invalid-subgraph-interface",
  "disabled-node-dependency",
  // Environment — requires an injected resolver.
  "invalid-source-asset",
  "missing-requirement",
  "unsafe-target",
] as const;

/** Closed validation code schema. */
export const CreativeValidationCodeSchema = Type.String({
  enum: [...CREATIVE_VALIDATION_CODES],
});

/** Validation code union. */
export type CreativeValidationCode = (typeof CREATIVE_VALIDATION_CODES)[number];

/**
 * Finding severities.
 *
 * `error` blocks execution. `warning` does not: it covers findings a creator may
 * legitimately intend, such as a disabled node that leaves an optional output
 * unfilled. Only `error` gates the run, which is what keeps validation from
 * becoming a nag screen.
 */
export const CREATIVE_VALIDATION_SEVERITIES = ["error", "warning"] as const;

/** Closed severity schema. */
export const CreativeValidationSeveritySchema = Type.String({
  enum: [...CREATIVE_VALIDATION_SEVERITIES],
});

/** Severity union. */
export type CreativeValidationSeverity = (typeof CREATIVE_VALIDATION_SEVERITIES)[number];

/**
 * One validation finding.
 *
 * Location fields are all optional because findings attach at different scopes:
 * a cycle names several nodes, a missing parameter names one node and one
 * parameter, and an invalid graph interface names neither.
 */
export const CreativeValidationIssueSchema = Type.Object(
  {
    code: CreativeValidationCodeSchema,
    severity: CreativeValidationSeveritySchema,
    message: NonEmptyString,
    nodeId: Type.Optional(CreativeIdSchema),
    nodeIds: Type.Optional(Type.Array(CreativeIdSchema)),
    edgeId: Type.Optional(CreativeIdSchema),
    port: Type.Optional(CreativePortNameSchema),
    parameter: Type.Optional(NonEmptyString),
    suggestion: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** One validation finding. */
export type CreativeValidationIssue = Static<typeof CreativeValidationIssueSchema>;

/**
 * Validation outcome.
 *
 * `valid` is derived from the absence of `error` findings, not from an empty
 * list: a graph with only warnings is executable.
 */
export const CreativeValidationResultSchema = Type.Object(
  {
    valid: Type.Boolean(),
    issues: Type.Array(CreativeValidationIssueSchema),
  },
  { additionalProperties: false },
);

/** Validation outcome. */
export type CreativeValidationResult = Static<typeof CreativeValidationResultSchema>;

/** Build a result, deriving `valid` from the findings so callers cannot disagree with it. */
export function buildValidationResult(
  issues: readonly CreativeValidationIssue[],
): CreativeValidationResult {
  return {
    valid: !issues.some((issue) => issue.severity === "error"),
    issues: [...issues],
  };
}
