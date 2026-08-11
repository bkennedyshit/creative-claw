/**
 * Shared FFI binding metadata types.
 *
 * These describe the compiled C++ `bridge_*` exports declaratively so the
 * dispatcher can build koffi calls generically. Each engine's bindings module
 * exports an {@link EngineBindingModule} that pairs a koffi C prototype string
 * (used verbatim with `lib.func(...)`) with the ordered parameter list and the
 * dispatch classification (filter / mask / resizing / generator / special).
 *
 * The metadata is data, not logic: it mirrors the ctypes argtypes and wrapper
 * defaults from the reference Python bridges so the native TypeScript port
 * calls the exact same C entry points with the exact same argument order.
 */

/** Scalar argument kinds accepted by the C bridge functions. */
export type FfiType =
  | "int" // C int
  | "float" // C float
  | "double" // C double
  | "uint8" // C uint8_t (also used for 0/1 boolean flags)
  | "bool" // JS boolean, marshalled to C int 0/1
  | "string"; // C char* (UTF-8)

/** One ordered scalar parameter that sits between the leading buffer/header
 * arguments and the trailing output buffer of a bridge function. */
export interface FfiParam {
  name: string;
  type: FfiType;
  default: number | string | boolean;
  description?: string;
}

/**
 * How the dispatcher must treat an op:
 * - `filter`     — pixels/samples in, same-sized buffer out (the common case).
 * - `mask`       — image in, single-channel `w*h` mask out (selection tools).
 * - `resizing`   — output dimensions differ from input (scale/crop/seam_carving).
 * - `generator`  — no input media; synthesizes a buffer (render_clouds/fibers).
 * - `analysis`   — returns data, not media (histograms, detection).
 * - `special`    — stateful/handle/multi-buffer op not reachable via file apply.
 */
export type OpKind = "filter" | "mask" | "resizing" | "generator" | "analysis" | "special" | "ffmpeg";

/** A single compiled bridge function, described for generic dispatch. */
export interface OpBinding {
  /** Public op id used by the tool surface and op catalog. */
  name: string;
  /** koffi C prototype string, passed verbatim to `lib.func(...)`. */
  signature: string;
  /** Ordered scalar params between the leading args and trailing out buffer. */
  params: FfiParam[];
  kind: OpKind;
  /** Whether the op is valid inside an apply_chain. */
  chainable: boolean;
  description: string;
  /** Audio: operates on the sample buffer in place (no trailing out arg). */
  inPlace?: boolean;
  /** Audio: consumes/produces separate left+right channel buffers. */
  stereo?: boolean;
  /**
   * The export returns a `BridgeOpStatus` int that MUST be checked.
   *
   * The `bridge_neural_*` family in `omni_image_bridge.cpp` validates at the
   * front door, wraps the work in `try/catch`, and reports the outcome as an int
   * (`onnx_model_host.h::BridgeOpStatus`). Binding those exports as `void` threw
   * the status away, so a failed model load looked like a success: C++
   * sentinel-fills the output buffer with zeros on `OP_EXCEPTION`, and the
   * dispatcher happily encoded that as a valid all-black PNG with `ok: true`.
   * Reproduced by pointing `OMNI_COLORIZE_MODEL` at a file that is not an ONNX
   * graph: the op returned `ok=true` with a black image.
   */
  status?: "bridgeOpStatus";
}

/**
 * Status codes returned by the guarded `bridge_*` exports.
 *
 * Mirrors `enum class BridgeOpStatus : int` in
 * `omni_image_processing/include/omni/image/ai/onnx_model_host.h`.
 */
export const BRIDGE_OP_STATUS = {
  0: "success",
  1: "invalid_argument: the bridge rejected the buffer/dimension arguments and wrote nothing",
  2: "op_exception: the C++ op threw (model missing, ONNX session create failed, or inference failed) and the output buffer was sentinel-filled",
  3: "latency_exceeded: the inference ran past the bridge's 2000ms budget (output preserved)",
} as const;

/** True when a status code means the output buffer holds a real result. */
export function bridgeStatusIsUsable(status: number): boolean {
  // LATENCY_EXCEEDED (3) preserves the produced output by contract, so it is a
  // slow success, not a failure.
  return status === 0 || status === 3;
}

/** Human-readable description of a bridge status code. */
export function describeBridgeStatus(status: number): string {
  return (
    (BRIDGE_OP_STATUS as Record<number, string | undefined>)[status] ??
    `unknown BridgeOpStatus ${status}`
  );
}

/**
 * An op whose C++ implementation runs ONNX Runtime inference.
 *
 * These ops are gated in the dispatcher: reaching the C++ bridge without a
 * correctly pre-loaded ONNX Runtime aborts the PROCESS (see the sidecar preload
 * notes in `ffi/loader.ts`), so they must fail honestly before the FFI call.
 * They are also the ops that genuinely contend for VRAM, so they are the ones
 * routed through the GPU broker claim.
 */
export interface OnnxOpSpec {
  /** Model id the C++ `OnnxModelHost` registers for this op. */
  modelId: string;
  /** File name the host looks for under `<engine dir>/models/`. */
  modelFile: string;
  /** Environment variable that overrides the model path, per the C++ host. */
  modelEnvVar: string;
}

/** Everything the dispatcher needs to run one engine's native ops. */
export interface EngineBindingModule {
  engine: "image" | "audio" | "video" | "vector";
  /** Base name of the shared library (without lib prefix / extension). */
  libraryStem: string;
  ops: OpBinding[];
  /** Ops intentionally gated off because the C++ path is known broken. */
  knownBroken: Set<string>;
  /**
   * Ops backed by ONNX model inference, keyed by op name. Absent/empty for
   * engines whose library does not link ONNX Runtime.
   */
  onnxOps?: ReadonlyMap<string, OnnxOpSpec>;
}

/** Look up an op binding by name; returns undefined when absent. */
export function findOp(mod: EngineBindingModule, name: string): OpBinding | undefined {
  return mod.ops.find((op) => op.name === name);
}

/** Map an {@link FfiType} to its C spelling for a koffi prototype string. */
export function cType(type: FfiType): string {
  switch (type) {
    case "int":
      return "int";
    case "float":
      return "float";
    case "double":
      return "double";
    case "uint8":
      return "uint8";
    case "bool":
      return "int"; // booleans marshalled to C int
    case "string":
      return "const char*";
  }
}

/** Terse param constructors — used heavily by the binding catalogs. */
export const P = {
  int: (name: string, def: number, description?: string): FfiParam => ({ name, type: "int", default: def, description }),
  float: (name: string, def: number, description?: string): FfiParam => ({ name, type: "float", default: def, description }),
  double: (name: string, def: number, description?: string): FfiParam => ({ name, type: "double", default: def, description }),
  u8: (name: string, def: number, description?: string): FfiParam => ({ name, type: "uint8", default: def, description }),
  bool: (name: string, def: boolean, description?: string): FfiParam => ({ name, type: "bool", default: def, description }),
  str: (name: string, def: string, description?: string): FfiParam => ({ name, type: "string", default: def, description }),
};

export interface PrototypeOptions {
  /** Leading argument list before the ordered params. */
  leading?: string;
  /** Trailing argument list after the ordered params (usually the out buffer). */
  trailing?: string;
  /** C return type. Defaults to `void`. */
  restype?: string;
}

/**
 * Build a koffi C prototype string, e.g.
 * `void bridge_gaussian_blur(uint8* pixels, int w, int h, int channels, float sigma, uint8* out)`.
 *
 * This is exactly the string handed to `lib.func(...)`; generating it from
 * metadata keeps the ~200 bridge declarations correct and consistent.
 */
export function buildPrototype(symbol: string, params: FfiParam[], opts: PrototypeOptions = {}): string {
  const leading = opts.leading ?? "uint8* pixels, int w, int h, int channels";
  const trailing = opts.trailing ?? "uint8* out";
  const restype = opts.restype ?? "void";
  const mid = params.map((p) => `${cType(p.type)} ${p.name}`).join(", ");
  const parts = [leading, mid, trailing].filter((s) => s.length > 0);
  return `${restype} bridge_${symbol}(${parts.join(", ")})`;
}
