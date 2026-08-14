/** Catalog of available operations from a native in-process engine. */
export interface OpCatalog {
  engine: string;
  ops: OpInfo[];
}

/** Describes a single operation supported by an engine. */
export interface OpInfo {
  id: string;
  name: string;
  description: string;
  params: OpParamDef[];
  supports_chain: boolean;
}

export interface OpParamDef {
  name: string;
  type: "number" | "string" | "boolean" | "enum";
  required: boolean;
  default?: unknown;
  enum_values?: string[];
  description?: string;
}

/** A single step in a processing chain or pipeline. */
export interface Step {
  op: string;
  params: Record<string, unknown>;
}

/** Result of applying a single operation or chain. */
export interface ApplyResult {
  ok: boolean;
  output_path: string;
  engine_path: string;
  duration_ms: number;
  reason?: string;
  input_hash?: string;
  output_hash?: string;
}

/** Result for one item in a batch run. */
export interface BatchItemResult {
  input_path: string;
  output_path: string;
  ok: boolean;
  duration_ms: number;
  error?: string;
}

/** Manifest summarizing a batch run. */
export interface RunManifest {
  started_at: string;
  completed_at: string;
  total_items: number;
  succeeded: number;
  failed: number;
  output_dir: string;
  items: BatchItemResult[];
}

/** A versioned snapshot in an edit session. */
export interface EditSessionVersion {
  version: number;
  path: string;
  ops_applied: Step[];
  input_hash: string;
  output_hash: string;
  timestamp: string;
}

/** A planned graph of operations for pipeline execution. */
export interface GraphPlan {
  id: string;
  description: string;
  nodes: GraphPlanNode[];
  connections: GraphPlanConnection[];
}

export interface GraphPlanNode {
  id: string;
  engine: "image" | "audio" | "video" | "vector";
  op: string;
  params: Record<string, unknown>;
}

export interface GraphPlanConnection {
  from_node: string;
  from_output: string;
  to_node: string;
  to_input: string;
}

/** Engine configuration from plugin config. */
export interface EngineConfig {
  /** Absolute path to the compiled engine library (.dll/.so/.dylib), or a
   * directory containing it. When omitted, the bundled binaries dir is used. */
  binaryPath?: string;
  /** Whether the native library loaded successfully (set at runtime). */
  available: boolean;
}

/** Codec configuration (ffmpeg location for audio/video decode/encode). */
export interface CodecConfig {
  /** ffmpeg binary path, or a directory containing ffmpeg/ffprobe. */
  ffmpegPath?: string;
  /** ffprobe binary path (defaults alongside ffmpeg). */
  ffprobePath?: string;
}

/** Plugin-level config shape. */
export interface CreativeEnginesConfig {
  image?: Partial<EngineConfig>;
  audio?: Partial<EngineConfig>;
  video?: Partial<EngineConfig>;
  vector?: Partial<EngineConfig>;
  codec?: CodecConfig;
  /**
   * CUDA 12 / cuDNN 9 discovery for ORT's CUDA execution provider. Optional in
   * every sense: with no CUDA present the ONNX ops run on the CPU provider and
   * say so. See `./ffi/loader.ts` `ensureCudaProviderDependencies`.
   */
  cuda?: import("./ffi/loader.js").CudaDiscoveryConfig;
  /**
   * Keyframe video-understanding options. Deliberately thin: the vision model
   * itself is normally taken from config the user already owns
   * (`tools.media.video.models[].model`), so `visionModel` here is only an
   * override. See `./media/video-understanding.ts` `resolveVisionModelRef`.
   */
  mediaUnderstanding?: import("./media/video-understanding.js").VideoUnderstandingPluginConfig;
}
