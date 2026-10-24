// Creative Claw contract module defines canonical product schema shapes.
import { Type } from "typebox";

/**
 * Shared schema primitives reused by Creative Claw project, asset, artifact,
 * graph, capability, and job schemas.
 *
 * Keep these small and domain-neutral; feature-specific validation belongs in
 * the owning schema module or the graph validator.
 */

/** Current schema version for every persisted Creative Claw record. */
export const CREATIVE_SCHEMA_VERSION = 1;

/** Non-empty string primitive for contract fields that reject blank values. */
export const NonEmptyString = Type.String({ minLength: 1 });

/**
 * Stable, path-independent identifier.
 *
 * Spec 8 requires project ids to survive a directory move, so ids are opaque
 * tokens rather than paths: no separators, no whitespace, no drive letters.
 */
export const CREATIVE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Opaque identifier primitive shared by projects, assets, artifacts, and graphs. */
export const CreativeIdSchema = Type.String({ pattern: CREATIVE_ID_PATTERN.source });

/**
 * Port and parameter names addressed by graph edges and capability descriptors.
 *
 * Restricted so a name can be embedded in a validation-error path and in
 * generated Studio form ids without escaping.
 */
export const CREATIVE_PORT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Port/parameter name primitive. */
export const CreativePortNameSchema = Type.String({
  pattern: CREATIVE_PORT_NAME_PATTERN.source,
});

/**
 * Capability identifier, dotted public form such as `video.cut_clip`.
 *
 * The dotted name is the product-facing contract; runtime tool identifiers are
 * derived from it elsewhere (spec 13.3) and are deliberately not stored here.
 */
export const CREATIVE_CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

/** Capability id primitive. */
export const CreativeCapabilityIdSchema = Type.String({
  pattern: CREATIVE_CAPABILITY_ID_PATTERN.source,
});

/**
 * Capability version, `major.minor.patch`.
 *
 * Spec 25 requires a version increment on capability removal or incompatible
 * parameter change, so only the major component gates compatibility.
 */
export const CREATIVE_CAPABILITY_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Capability version primitive. */
export const CreativeCapabilityVersionSchema = Type.String({
  pattern: CREATIVE_CAPABILITY_VERSION_PATTERN.source,
});

/** ISO 8601 timestamp primitive used by every created/updated/imported field. */
export const IsoTimestampSchema = Type.String({ format: "date-time", minLength: 1 });

/**
 * Content hash primitive, `<algorithm>:<lowercase-hex>`.
 *
 * Spec 9.2 requires hashes to be computed after a file is finalized and cache
 * hits to verify them, so the algorithm travels with the digest.
 */
export const CONTENT_HASH_PATTERN = /^(sha256|blake3):[0-9a-f]{32,128}$/;

/** Content hash primitive. */
export const ContentHashSchema = Type.String({ pattern: CONTENT_HASH_PATTERN.source });

/** Non-negative byte length primitive. */
export const ByteLengthSchema = Type.Integer({ minimum: 0 });

/** IANA media type primitive (`image/png`, `video/mp4`). */
export const MediaTypeSchema = Type.String({ minLength: 3 });

/**
 * Project-relative or content-addressed resource locator.
 *
 * Spec 8 forbids machine-specific absolute paths in persisted records, and
 * spec 20 constrains user paths to explicit roots. Absolute-path rejection is
 * enforced by the runtime path normalizer, not by this string schema, because
 * a portable manifest may legitimately record an external `file:` source.
 */
export const CreativeUriSchema = Type.String({ minLength: 1 });

/** Free-form metadata bag carried by assets, artifacts, and graphs. */
export const MetadataSchema = Type.Record(Type.String(), Type.Unknown());

/** Node parameter bag; validated against a capability's `parametersSchema`. */
export const ParametersSchema = Type.Record(Type.String(), Type.Unknown());

/** Schema version literal shared by persisted records. */
export const SchemaVersionSchema = Type.Literal(CREATIVE_SCHEMA_VERSION);

/** Two-dimensional canvas position for Studio layout persistence. */
export const CanvasPositionSchema = Type.Object(
  {
    x: Type.Number(),
    y: Type.Number(),
  },
  { additionalProperties: false },
);
