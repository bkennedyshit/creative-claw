// Creative Claw capability generator transforms native operation catalogs into canonical capability descriptors.
import type {
  CreativeCapabilityDescriptor,
  CreativeCapabilityFamily,
  CreativeCapabilityRequirements,
  CreativeCapabilityRisk,
  CreativePortDescriptor,
} from "@openclaw/creative-contracts";
import { CreativeGraphSchema, validateGraph } from "@openclaw/creative-contracts";
import { Check } from "typebox/value";
import { AI_CAPABILITIES } from "./ai-capabilities.js";
import { audioBindings } from "./ffi/audio-bindings.js";
import type { EngineBindingModule, FfiParam, OnnxOpSpec, OpBinding } from "./ffi/binding-types.js";
import { imageBindings } from "./ffi/image-bindings.js";
import { vectorBindings } from "./ffi/vector-bindings.js";
import { videoBindings } from "./ffi/video-bindings.js";
import { VFX_CAPABILITIES } from "./runtime/vfx.js";

const ENGINE_FAMILY_MAP: Record<string, CreativeCapabilityFamily> = {
  image: "image",
  audio: "audio",
  video: "video-edit",
  vector: "vector",
};

/**
 * Known parameter schema enhancements for common operations.
 * These provide friendly titles, bounds, enums, and required flags while keeping the schema valid JSON Schema.
 */
interface ParamEnhancement {
  type?: string;
  minimum?: number;
  maximum?: number;
  enum?: string[];
  description?: string;
  default?: unknown;
}

const OP_PARAMETER_ENHANCEMENTS: Record<
  string,
  {
    properties?: Record<string, ParamEnhancement>;
    required?: string[];
  }
> = {
  "video.cut_clip": {
    properties: {
      start_sec: {
        type: "number",
        minimum: 0,
        default: 0,
        description: "Start time in seconds",
      },
      end_sec: {
        type: "number",
        minimum: 0,
        default: 0,
        description: "End time in seconds (0 for end of clip)",
      },
      stream_copy: {
        type: "boolean",
        default: true,
        description: "Stream copy without re-encoding (fast, keyframe-accurate)",
      },
    },
  },
  "video.export_for_platform": {
    properties: {
      platform: {
        type: "string",
        enum: ["youtube", "tiktok", "instagram", "twitter", "linkedin"],
        default: "youtube",
        description: "Target platform presets for aspect ratio and codecs",
      },
    },
    required: ["platform"],
  },
  "video.thumbnail": {
    properties: {
      time_sec: {
        type: "number",
        minimum: 0,
        default: 3,
        description: "Timestamp in seconds to extract thumbnail frame",
      },
    },
  },
  "video.remove_silence": {
    properties: {
      noise_db: {
        type: "number",
        maximum: 0,
        default: -40,
        description: "Noise floor threshold in dB",
      },
      min_duration: {
        type: "number",
        minimum: 0.1,
        default: 0.5,
        description: "Minimum silence duration in seconds",
      },
      padding: {
        type: "number",
        minimum: 0,
        default: 0.1,
        description: "Padding around speech in seconds",
      },
    },
  },
  "video.speed_ramp": {
    properties: {
      factor: {
        type: "number",
        minimum: 0.1,
        maximum: 100,
        default: 2,
        description: "Speed multiplier factor (e.g. 2.0 = 2x speed)",
      },
    },
  },
  "video.stabilize": {
    properties: {
      smoothing: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        default: 10,
        description: "Smoothing window size for two-pass stabilization",
      },
    },
  },
  "video.add_subtitles": {
    properties: {
      srt_path: {
        type: "string",
        default: "",
        description: "Path to SRT subtitles file to burn into video",
      },
    },
    required: ["srt_path"],
  },
  "video.replace_audio": {
    properties: {
      audio_path: {
        type: "string",
        default: "",
        description: "Path to audio file to replace existing audio track",
      },
    },
    required: ["audio_path"],
  },
  "image.crop": {
    properties: {
      crop_x: {
        type: "integer",
        minimum: 0,
        default: 0,
        description: "Left crop origin in pixels",
      },
      crop_y: { type: "integer", minimum: 0, default: 0, description: "Top crop origin in pixels" },
      crop_width: {
        type: "integer",
        minimum: 1,
        default: 100,
        description: "Crop width in pixels",
      },
      crop_height: {
        type: "integer",
        minimum: 1,
        default: 100,
        description: "Crop height in pixels",
      },
    },
    required: ["crop_width", "crop_height"],
  },
  "image.scale": {
    properties: {
      new_width: {
        type: "integer",
        minimum: 1,
        default: 800,
        description: "Target width in pixels",
      },
      new_height: {
        type: "integer",
        minimum: 1,
        default: 600,
        description: "Target height in pixels",
      },
    },
  },
};

function toTitleCase(snake: string): string {
  return snake
    .split("_")
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function ffiParamToJsonSchema(param: FfiParam): Record<string, unknown> {
  let schemaType = "number";
  let defaultValue: number | string | boolean;

  if (param.type === "bool") {
    schemaType = "boolean";
    defaultValue = Boolean(param.default);
  } else if (param.type === "string") {
    schemaType = "string";
    defaultValue = String(param.default ?? "");
  } else if (param.type === "int" || param.type === "uint8") {
    schemaType = "integer";
    defaultValue = Number(param.default ?? 0);
  } else {
    defaultValue = Number(param.default ?? 0);
  }

  const prop: Record<string, unknown> = {
    type: schemaType,
    default: defaultValue,
  };
  if (param.description) {
    prop.description = param.description;
  }
  return prop;
}

function buildParametersSchema(capabilityId: string, params: FfiParam[]): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {};
  const enhancement = OP_PARAMETER_ENHANCEMENTS[capabilityId];

  for (const param of params) {
    const base = ffiParamToJsonSchema(param);
    const custom = enhancement?.properties?.[param.name];
    if (custom) {
      properties[param.name] = { ...base, ...custom };
    } else {
      properties[param.name] = base;
    }
  }

  // Controls are limited to parameters declared by the native binding catalog.
  // Enhancements may refine those declarations, but cannot invent a second UI-only catalog.

  const required = enhancement?.required ?? [];

  const schema: Record<string, unknown> = {
    type: "object",
    properties,
    additionalProperties: false,
  };
  if (required.length > 0) {
    schema.required = required;
  }
  return schema;
}

function buildInputPorts(engine: string, op: OpBinding): Record<string, CreativePortDescriptor> {
  if (op.kind === "generator") {
    return {};
  }
  switch (engine) {
    case "image":
      return { source: { dataType: "image", required: true, description: "Input image" } };
    case "audio":
      return { source: { dataType: "audio", required: true, description: "Input audio" } };
    case "video":
      return { source: { dataType: "video", required: true, description: "Input video" } };
    case "vector":
      return { source: { dataType: "vector", required: true, description: "Input vector" } };
    default:
      return {};
  }
}

function buildOutputPorts(engine: string, op: OpBinding): Record<string, CreativePortDescriptor> {
  if (op.kind === "mask") {
    return { mask: { dataType: "image-mask", required: true, description: "Output mask" } };
  }
  if (op.kind === "analysis") {
    return { data: { dataType: "json", required: true, description: "Analysis result" } };
  }
  if (op.name === "neural_generate_depth_map") {
    return { depth: { dataType: "depth-map", required: true, description: "Output depth map" } };
  }
  if (op.name === "thumbnail") {
    return {
      thumbnail: { dataType: "image", required: true, description: "Extracted thumbnail image" },
    };
  }
  if (engine === "video" && op.name === "extract_audio") {
    return { audio: { dataType: "audio", required: true, description: "Extracted audio track" } };
  }

  switch (engine) {
    case "image":
      return { output: { dataType: "image", required: true, description: "Output image" } };
    case "audio":
      return { output: { dataType: "audio", required: true, description: "Output audio" } };
    case "video":
      return { clip: { dataType: "video", required: true, description: "Output video" } };
    case "vector":
      return { output: { dataType: "vector", required: true, description: "Output vector" } };
    default:
      return {};
  }
}

/**
 * Build a canonical CreativeCapabilityDescriptor for an OpBinding.
 */
export function buildCapabilityDescriptor(
  engine: "image" | "audio" | "video" | "vector",
  op: OpBinding,
  onnxOps?: ReadonlyMap<string, OnnxOpSpec>,
): CreativeCapabilityDescriptor {
  const id = `${engine}.${op.name}`;
  const family = ENGINE_FAMILY_MAP[engine] ?? "utility";
  const label = toTitleCase(op.name);
  const description = op.description.trim().length > 0 ? op.description : `${label} operation.`;

  const inputs = buildInputPorts(engine, op);
  const outputs = buildOutputPorts(engine, op);
  const parametersSchema = buildParametersSchema(id, op.params);

  const onnxSpec = onnxOps?.get(op.name);
  const requirements: CreativeCapabilityRequirements = {
    ...(engine === "video" || engine === "audio" ? { binaries: ["ffmpeg"] } : {}),
    ...(onnxSpec
      ? { models: [onnxSpec.modelFile], gpu: "optional" as const }
      : { gpu: "none" as const }),
  };

  const writesFiles = op.kind !== "analysis";
  const risk: CreativeCapabilityRisk = {
    writesFiles,
    mayOverwrite: false,
    externalUpload: false,
    publishes: false,
  };

  return {
    id,
    version: "1.0.0",
    family,
    label,
    description,
    inputs,
    outputs,
    parametersSchema,
    execution: {
      runtime: "native",
      supportsProgress: false,
      supportsCancellation: false,
      deterministic: true,
      cacheable: op.kind !== "analysis" && op.kind !== "special",
    },
    requirements,
    risk,
  };
}

const BINDING_MODULES: Record<string, EngineBindingModule> = {
  image: imageBindings,
  audio: audioBindings,
  video: videoBindings,
  vector: vectorBindings,
};

let cachedDescriptors: Map<string, CreativeCapabilityDescriptor> | undefined;

function getDescriptorMap(): Map<string, CreativeCapabilityDescriptor> {
  if (cachedDescriptors) {
    return cachedDescriptors;
  }
  const map = new Map<string, CreativeCapabilityDescriptor>();

  for (const [engine, mod] of Object.entries(BINDING_MODULES) as [
    "image" | "audio" | "video" | "vector",
    EngineBindingModule,
  ][]) {
    for (const op of mod.ops) {
      if (mod.knownBroken?.has(op.name)) {
        continue;
      }
      const desc = buildCapabilityDescriptor(engine, op, mod.onnxOps);
      map.set(desc.id, desc);
    }
  }

  cachedDescriptors = map;
  for (const descriptor of [...VFX_CAPABILITIES, ...AI_CAPABILITIES]) {
    map.set(descriptor.id, descriptor);
  }
  return map;
}

/**
 * Returns all canonical capability descriptors across all native engines.
 */
export function getAllCreativeCapabilities(): CreativeCapabilityDescriptor[] {
  return Array.from(getDescriptorMap().values());
}

/**
 * Returns all capability descriptors for a specific engine.
 */
export function getEngineCapabilities(
  engine: "image" | "audio" | "video" | "vector",
): CreativeCapabilityDescriptor[] {
  const mod = BINDING_MODULES[engine];
  if (!mod) {
    return [];
  }
  return mod.ops
    .filter((op) => !mod.knownBroken?.has(op.name))
    .map((op) => buildCapabilityDescriptor(engine, op, mod.onnxOps));
}

/**
 * Retrieve a single capability descriptor by its public id (e.g. `video.cut_clip`).
 */
export function getCreativeCapability(id: string): CreativeCapabilityDescriptor | undefined {
  return getDescriptorMap().get(id);
}

/**
 * Compact capability search by query and optional family filter.
 */
export function searchCreativeCapabilities(
  query: string,
  options?: {
    family?: string;
    limit?: number;
  },
): CreativeCapabilityDescriptor[] {
  const q = query.trim().toLowerCase();
  const all = getAllCreativeCapabilities();
  const filtered = all.filter((desc) => {
    if (options?.family && desc.family !== options.family) {
      return false;
    }
    if (!q) {
      return true;
    }
    return (
      desc.id.toLowerCase().includes(q) ||
      desc.label.toLowerCase().includes(q) ||
      desc.description.toLowerCase().includes(q)
    );
  });

  const limit = options?.limit === undefined ? 10 : options.limit;
  return filtered.slice(
    0,
    Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.trunc(limit))) : 10,
  );
}

/** Validate the wire shape before the pure validator traverses node/edge arrays. */
export function validateCreativeGraph(graph: unknown) {
  if (!Check(CreativeGraphSchema, graph)) {
    return {
      valid: false,
      issues: [
        { code: "invalid-graph", severity: "error", message: "Expected a canonical CreativeGraph" },
      ],
    };
  }
  return validateGraph({ graph, capabilities: getAllCreativeCapabilities() });
}

export interface ParameterValidationResult {
  valid: boolean;
  errors: string[];
  resolvedParams: Record<string, unknown>;
}

/**
 * Validates and resolves incoming raw operation parameters against the capability's JSON Schema parametersSchema.
 * Coerces scalar values from form inputs, populates defaults for omitted optional parameters,
 * and enforces required keys, bounds, and enums.
 */
export function validateOperationParameters(
  capability: CreativeCapabilityDescriptor,
  rawParams: Record<string, unknown>,
): ParameterValidationResult {
  const schema = capability.parametersSchema as {
    type?: string;
    additionalProperties?: boolean;
    properties?: Record<
      string,
      {
        type?: string;
        minimum?: number;
        maximum?: number;
        enum?: string[];
        default?: unknown;
      }
    >;
    required?: string[];
  };

  const properties = schema.properties ?? {};
  const required = schema.required ?? [];
  const errors: string[] = [];
  const resolved: Record<string, unknown> = {};

  // The descriptor schema is the request contract. Do not let an unlisted form
  // field reach a native operation just because the dispatcher accepts a bag.
  if (!(schema.additionalProperties ?? true)) {
    for (const key of Object.keys(rawParams)) {
      if (!(key in properties)) {
        errors.push(`Unknown parameter '${key}'`);
      }
    }
  }

  // Check required parameters
  for (const reqKey of required) {
    const val = rawParams[reqKey];
    if (val === undefined || val === null || val === "") {
      errors.push(`Missing required parameter '${reqKey}'`);
    }
  }

  // Validate and resolve each declared property
  for (const [key, propDef] of Object.entries(properties)) {
    const rawVal = rawParams[key];

    if (rawVal === undefined || rawVal === null || rawVal === "") {
      if (propDef.default !== undefined) {
        resolved[key] = propDef.default;
      }
      continue;
    }

    if (propDef.type === "boolean") {
      if (typeof rawVal === "boolean") {
        resolved[key] = rawVal;
      } else if (rawVal === "true" || rawVal === "1" || rawVal === 1) {
        resolved[key] = true;
      } else if (rawVal === "false" || rawVal === "0" || rawVal === 0) {
        resolved[key] = false;
      } else {
        errors.push(`Parameter '${key}' must be a boolean (got ${JSON.stringify(rawVal)})`);
      }
    } else if (propDef.type === "integer" || propDef.type === "number") {
      const num =
        typeof rawVal === "number" || typeof rawVal === "string" ? Number(rawVal) : Number.NaN;
      if (!Number.isFinite(num)) {
        errors.push(`Parameter '${key}' must be a number (got ${JSON.stringify(rawVal)})`);
      } else if (propDef.type === "integer" && !Number.isInteger(num)) {
        errors.push(`Parameter '${key}' must be an integer (got ${JSON.stringify(rawVal)})`);
      } else {
        if (propDef.minimum !== undefined && num < propDef.minimum) {
          errors.push(`Parameter '${key}' (${num}) must be >= ${propDef.minimum}`);
        }
        if (propDef.maximum !== undefined && num > propDef.maximum) {
          errors.push(`Parameter '${key}' (${num}) must be <= ${propDef.maximum}`);
        }
        resolved[key] = num;
      }
    } else if (propDef.type === "string") {
      if (typeof rawVal !== "string") {
        errors.push(`Parameter '${key}' must be a string`);
        continue;
      }
      const str = rawVal;
      if (propDef.enum && !propDef.enum.includes(str)) {
        errors.push(
          `Parameter '${key}' must be one of: ${propDef.enum.join(", ")} (got ${JSON.stringify(rawVal)})`,
        );
      } else {
        resolved[key] = str;
      }
    } else {
      resolved[key] = rawVal;
    }
  }

  if (
    capability.id === "video.cut_clip" &&
    typeof resolved.end_sec === "number" &&
    typeof resolved.start_sec === "number" &&
    resolved.end_sec !== 0 &&
    resolved.end_sec <= resolved.start_sec
  ) {
    errors.push("end_sec must be greater than start_sec (or 0 for the end of the clip)");
  }

  for (const [key, val] of Object.entries(rawParams)) {
    if (schema.additionalProperties !== false && !(key in properties)) {
      resolved[key] = val;
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    resolvedParams: resolved,
  };
}
