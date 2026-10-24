// Creative Claw contract module defines canonical product schema shapes.
import type { CreativeMediaConstraints, CreativeDataType } from "./data-types.js";
import { CREATIVE_ARTIFACT_BACKED_DATA_TYPES } from "./data-types.js";

/**
 * Port type compatibility, spec 10.3.
 *
 * Compatibility is directional: it answers "may this output feed this input",
 * never "are these the same type". Widening is an explicit allowlist rather
 * than a structural rule so a new data type cannot silently become connectable
 * to everything.
 */

/**
 * Allowed widenings, keyed by source (output) type.
 *
 * `image-mask`, `depth-map`, and `normal-map` are raster buffers, so a
 * capability that accepts a generic `image` can consume them — that is what
 * makes "show me the depth pass" work without a conversion node. The reverse is
 * not allowed: a generic image is not a valid mask, because a mask input
 * carries a single-channel meaning the producer never promised.
 */
const DATA_TYPE_WIDENINGS: Partial<Record<CreativeDataType, readonly CreativeDataType[]>> = {
  "image-mask": ["image"],
  "depth-map": ["image"],
  "normal-map": ["image"],
  // A video mask is still decodable video; the same one-way logic as image-mask.
  "video-mask": ["video"],
  // Integers are numbers; timecode is not, because it needs a frame rate to mean anything.
  number: [],
};

/** True when a single artifact reference may stand in for `type`. */
function isArtifactBacked(type: CreativeDataType): boolean {
  return (CREATIVE_ARTIFACT_BACKED_DATA_TYPES as readonly string[]).includes(type);
}

/**
 * True when an output of `source` may connect to an input of `target`.
 *
 * Beyond exact match and the explicit widening table, any file-backed media
 * type may flow into an `artifact-ref` input (a generic "some artifact" port),
 * and an `artifact-ref` output may flow into a file-backed input because the
 * runtime resolves the reference to a concrete file before the node executes.
 * Constraint conflicts are reported separately by `findConstraintConflict`.
 */
export function isDataTypeCompatible(source: CreativeDataType, target: CreativeDataType): boolean {
  if (source === target) {
    return true;
  }
  if (target === "artifact-ref" && isArtifactBacked(source)) {
    return true;
  }
  if (source === "artifact-ref" && isArtifactBacked(target)) {
    return true;
  }
  return (DATA_TYPE_WIDENINGS[source] ?? []).includes(target);
}

/** One incompatible constraint, named so the message can point at a field. */
export type ConstraintConflict = {
  /** Constraint field that disagrees, e.g. `codecs` or `maxDimensions`. */
  field: string;
  /** What the producing port declares. */
  source: string;
  /** What the consuming port requires. */
  target: string;
};

function intersects(source: readonly string[], target: readonly string[]): boolean {
  return source.some((value) => target.includes(value));
}

function findEnumConflict(
  field: string,
  source: readonly string[] | undefined,
  target: readonly string[] | undefined,
): ConstraintConflict | undefined {
  // Absent on either side means unconstrained (spec 10.1), so only a stated
  // disagreement is a conflict. Dropping this guard makes every unannotated
  // port fail validation.
  if (!source || !target || intersects(source, target)) {
    return undefined;
  }
  return { field, source: source.join(", "), target: target.join(", ") };
}

/**
 * First constraint conflict between a producing and consuming port, if any.
 *
 * Only the first is returned: the Studio shows one actionable reason per edge,
 * and a port whose codec already disagrees will usually disagree on pixel
 * format too, which is noise rather than information.
 */
export function findConstraintConflict(
  source: CreativeMediaConstraints | undefined,
  target: CreativeMediaConstraints | undefined,
): ConstraintConflict | undefined {
  if (!source || !target) {
    return undefined;
  }

  const enumConflict =
    findEnumConflict("codecs", source.codecs, target.codecs) ??
    findEnumConflict("pixelFormats", source.pixelFormats, target.pixelFormats) ??
    findEnumConflict("colorSpaces", source.colorSpaces, target.colorSpaces) ??
    findEnumConflict("platformProfiles", source.platformProfiles, target.platformProfiles);
  if (enumConflict) {
    return enumConflict;
  }

  if (target.requiresAlpha === true && source.requiresAlpha === false) {
    return { field: "requiresAlpha", source: "false", target: "true" };
  }

  if (
    source.channels !== undefined &&
    target.channels !== undefined &&
    source.channels !== target.channels
  ) {
    return {
      field: "channels",
      source: String(source.channels),
      target: String(target.channels),
    };
  }

  const sampleRateConflict = findEnumConflict(
    "sampleRates",
    source.sampleRates?.map(String),
    target.sampleRates?.map(String),
  );
  if (sampleRateConflict) {
    return sampleRateConflict;
  }

  // A producer whose smallest output still exceeds the consumer's ceiling can
  // never satisfy it, in either axis.
  const sourceMin = source.minDimensions;
  const targetMax = target.maxDimensions;
  if (
    sourceMin &&
    targetMax &&
    (sourceMin.width > targetMax.width || sourceMin.height > targetMax.height)
  ) {
    return {
      field: "maxDimensions",
      source: `${sourceMin.width}x${sourceMin.height} minimum`,
      target: `${targetMax.width}x${targetMax.height} maximum`,
    };
  }

  const sourceMax = source.maxDimensions;
  const targetMin = target.minDimensions;
  if (
    sourceMax &&
    targetMin &&
    (sourceMax.width < targetMin.width || sourceMax.height < targetMin.height)
  ) {
    return {
      field: "minDimensions",
      source: `${sourceMax.width}x${sourceMax.height} maximum`,
      target: `${targetMin.width}x${targetMin.height} minimum`,
    };
  }

  return undefined;
}
