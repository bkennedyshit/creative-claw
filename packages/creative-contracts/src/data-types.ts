// Creative Claw contract module defines canonical product schema shapes.
import { type Static, Type } from "typebox";

/**
 * Canonical graph port data types and the media constraints they may carry.
 *
 * Spec 10.1 fixes the type set recognized by the first release. Adding a type
 * is a contract change: the compatibility table in
 * `data-type-compatibility.ts` must gain a matching entry, otherwise the new
 * type silently connects to nothing.
 */

/**
 * Recognized port data types, spec 10.1.
 *
 * Ordering is stable so generated Studio palettes and prompt-cached capability
 * listings do not churn (root AGENTS.md prompt-cache rule).
 */
export const CREATIVE_DATA_TYPES = [
  "text",
  "json",
  "number",
  "boolean",
  "timecode",
  "image",
  "image-mask",
  "audio",
  "video",
  "video-mask",
  "depth-map",
  "normal-map",
  "vector",
  "subtitle-track",
  "timeline",
  "artifact-ref",
  "artifact-list",
] as const;

/** Closed port data type schema. */
export const CreativeDataTypeSchema = Type.String({ enum: [...CREATIVE_DATA_TYPES] });

/** Port data type union. */
export type CreativeDataType = (typeof CREATIVE_DATA_TYPES)[number];

/** True when `value` is a recognized port data type. */
export function isCreativeDataType(value: unknown): value is CreativeDataType {
  return typeof value === "string" && (CREATIVE_DATA_TYPES as readonly string[]).includes(value);
}

/**
 * Data types that reference a file-backed artifact rather than an inline value.
 *
 * Spec 9.2 requires every engine or provider result to be a registered
 * artifact, so these are the types that can widen to `artifact-ref`.
 */
export const CREATIVE_ARTIFACT_BACKED_DATA_TYPES = [
  "image",
  "image-mask",
  "audio",
  "video",
  "video-mask",
  "depth-map",
  "normal-map",
  "vector",
  "subtitle-track",
  "timeline",
] as const satisfies readonly CreativeDataType[];

/** Frame rate expressed as an exact rational, avoiding 29.97 rounding drift. */
export const FrameRateSchema = Type.Object(
  {
    numerator: Type.Integer({ minimum: 1 }),
    denominator: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

/** Frame rate rational. */
export type FrameRate = Static<typeof FrameRateSchema>;

/** Pixel dimensions constraint. */
export const PixelDimensionsSchema = Type.Object(
  {
    width: Type.Integer({ minimum: 1 }),
    height: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

/** Pixel dimensions. */
export type PixelDimensions = Static<typeof PixelDimensionsSchema>;

/**
 * Optional media constraints a port may declare, spec 10.1.
 *
 * Every field is optional and absence means "unconstrained": a port that omits
 * `codecs` accepts any codec. The validator therefore only reports a conflict
 * when both sides state something concrete and the statements disagree.
 */
export const CreativeMediaConstraintsSchema = Type.Object(
  {
    codecs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
    pixelFormats: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
    colorSpaces: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
    platformProfiles: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
    minDimensions: Type.Optional(PixelDimensionsSchema),
    maxDimensions: Type.Optional(PixelDimensionsSchema),
    frameRates: Type.Optional(Type.Array(FrameRateSchema, { minItems: 1 })),
    channels: Type.Optional(Type.Integer({ minimum: 1 })),
    sampleRates: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1 })),
    minDurationSeconds: Type.Optional(Type.Number({ minimum: 0 })),
    maxDurationSeconds: Type.Optional(Type.Number({ minimum: 0 })),
    requiresAlpha: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Optional media constraints attached to a port. */
export type CreativeMediaConstraints = Static<typeof CreativeMediaConstraintsSchema>;
