/**
 * Native dispatch — the in-process TypeScript port of `omni_dispatch.py`.
 *
 * For each op it decodes the media to a raw buffer, calls the koffi-bound C++
 * `bridge_*` function DIRECTLY in-process (no HTTP, no co-process, no Python),
 * then re-encodes and saves. It ports the dimension handling (resizing filters
 * and dimension-swapping rotates), the single-channel mask handling, the
 * generator path, and the known-broken gating from the reference dispatcher.
 *
 * Engine calling conventions differ, so the dispatcher routes by engine:
 *   - image  : RGBA buffer in/out via sharp; koffi filter/mask/resizing/generator.
 *   - audio  : mono float32 via ffmpeg; in-place or out-buffer DSP ops.
 *   - video  : hybrid — per-frame koffi ops over ffmpeg-decoded frames, plus
 *              file-level ffmpeg pipeline ops.
 *   - vector : SVG point arrays — affine transforms and rasterizers.
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ApplyResult, OpCatalog, OpInfo, OpParamDef, Step } from "../types.js";
import { withGpuClaim, withoutGpuClaim } from "../gpu-coop.js";
import { AFFINE_OPS, RASTER_ONLY } from "./vector-bindings.js";
import { DIMENSION_SWAP, MASK_FILTERS, RESIZING_FILTERS } from "./image-bindings.js";
import {
  bridgeStatusIsUsable,
  describeBridgeStatus,
  type EngineBindingModule,
  type FfiParam,
  type OnnxOpSpec,
  type OpBinding,
} from "./binding-types.js";
import {
  type CodecConfig,
  decodeAudioF32,
  decodeImageRGBA,
  decodeVideoRGBA,
  encodeAudioF32,
  encodeImageRGBA,
  encodeMaskPNG,
  encodeVideoRGBA,
  resolveFfmpeg,
  runCapture,
} from "./codec.js";
import { onnxUnavailableReason, type KoffiLib } from "./loader.js";

type BoundFn = (...args: unknown[]) => unknown;

function ffiTypeToParamType(t: FfiParam["type"]): OpParamDef["type"] {
  if (t === "bool") return "boolean";
  if (t === "string") return "string";
  return "number";
}

/** Read a param value with its default, marshalling booleans to C ints. */
function paramValue(p: FfiParam, params: Record<string, unknown>): number | string {
  const raw = params[p.name];
  const v = raw === undefined ? p.default : raw;
  if (p.type === "bool") return v ? 1 : 0;
  if (p.type === "string") return String(v);
  return Number(v);
}

/** Build the ordered scalar arg values (excluding the color buffer, if any). */
function scalarArgs(op: OpBinding, params: Record<string, unknown>, skip: Set<string> = new Set()): (number | string)[] {
  return op.params.filter((p) => !skip.has(p.name)).map((p) => paramValue(p, params));
}

// ── Output-dimension contracts ───────────────────────────────────────────────
//
// For ops whose OUT BUFFER size comes from PARAMS rather than from the input
// media, the buffer size and the scalar dimension args marshalled to C++ MUST
// be derived from the same resolved values.
//
// They used not to be: the buffer was sized from `params.new_width ?? width`
// (falling back to the SOURCE dimension) while the same param reached C++
// through `paramValue()`, whose fallback is the BINDING DEFAULT of `0`. So
// `scale { new_width: 16 }` on a 4x4 allocated 16x4x4 bytes and then told
// `bridge_scale` to write a 0-wide image: nothing was written, the zeroed
// buffer was encoded to a real PNG, and the op reported `ok: true`. Passing an
// explicit `0` was worse — a 0-length out buffer handed to C++ crashed the
// process with an access violation.
//
// `resolveOutputDims` is now the single source of truth: it fills the resolved
// dimensions back into the params object used for BOTH the allocation and the
// scalar args, so the two cannot disagree.

/** What a missing dimension param means for a given op. */
type DimFallback =
  /** Missing dimension means "keep the source dimension" (a real resample). */
  | "source"
  /** Missing dimension has no honest default; reject the call. */
  | "required";

interface DimContract {
  /** Param carrying the output width. */
  width: string;
  /** Param carrying the output height. */
  height: string;
  fallback: DimFallback;
  /** Rect origin params, when the op reads a sub-rectangle of the source. */
  origin?: { x: string; y: string };
}

/**
 * Image ops that size their output from params.
 *
 * - `scale` / `seam_carving` resample the whole frame, so a missing dimension
 *   genuinely means "leave that axis alone" → fall back to the source dim.
 * - `crop` defines a rectangle; a missing width/height has no honest default
 *   (0 is not "the rest of the image" to `bridge_crop`, it is an empty rect),
 *   so the call is rejected naming the missing param.
 */
const IMAGE_DIM_CONTRACTS: Record<string, DimContract> = {
  scale: { width: "new_width", height: "new_height", fallback: "source" },
  seam_carving: { width: "new_width", height: "new_height", fallback: "source" },
  crop: { width: "crop_width", height: "crop_height", fallback: "required", origin: { x: "crop_x", y: "crop_y" } },
};

/** Video per-frame ops that size their output from params (same reasoning). */
const VIDEO_DIM_CONTRACTS: Record<string, DimContract> = {
  video_transform_resize: { width: "dw", height: "dh", fallback: "source" },
  video_transform_crop: { width: "cw", height: "crop_h", fallback: "required", origin: { x: "x", y: "y" } },
};

interface ResolvedDims {
  /** Params with the resolved dimensions written back in. */
  params: Record<string, unknown>;
  width: number;
  height: number;
}

/** Require a positive integer dimension, naming the param in the failure. */
function requirePositiveDim(opName: string, param: string, raw: unknown, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `op '${opName}' needs a positive integer '${param}' (got ${JSON.stringify(raw ?? value)}); a zero/negative dimension makes the C++ bridge write nothing`,
    );
  }
  return value;
}

/**
 * Resolve the output dimensions of a params-sized op, returning params that
 * carry those exact values so the allocation and the C++ scalar args agree.
 * Throws (→ `ok: false` with a reason) rather than producing a blank output.
 */
function resolveOutputDims(
  op: OpBinding,
  contract: DimContract | undefined,
  params: Record<string, unknown>,
  srcWidth: number,
  srcHeight: number,
): ResolvedDims {
  if (!contract) {
    throw new Error(
      `op '${op.name}' sizes its output from params but has no dimension contract in dispatch; refusing to guess a size`,
    );
  }
  const resolved: Record<string, unknown> = { ...params };
  const dims: number[] = [];
  for (const [param, sourceDim] of [
    [contract.width, srcWidth],
    [contract.height, srcHeight],
  ] as const) {
    const raw = params[param];
    let value: number;
    if (raw === undefined || raw === null || raw === "") {
      if (contract.fallback === "required") {
        throw new Error(
          `op '${op.name}' requires '${param}': the binding default is 0, which would write a blank image`,
        );
      }
      value = sourceDim;
    } else {
      value = Number(raw);
    }
    resolved[param] = requirePositiveDim(op.name, param, raw, value);
    dims.push(value);
  }
  const width = dims[0]!;
  const height = dims[1]!;

  if (contract.origin) {
    const rawX = params[contract.origin.x];
    const rawY = params[contract.origin.y];
    const x = rawX === undefined || rawX === null || rawX === "" ? 0 : Number(rawX);
    const y = rawY === undefined || rawY === null || rawY === "" ? 0 : Number(rawY);
    for (const [param, raw, value] of [
      [contract.origin.x, rawX, x],
      [contract.origin.y, rawY, y],
    ] as const) {
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`op '${op.name}' needs a non-negative integer '${param}' (got ${JSON.stringify(raw ?? value)})`);
      }
    }
    if (x + width > srcWidth || y + height > srcHeight) {
      throw new Error(
        `op '${op.name}' rect ${width}x${height} at (${x},${y}) is outside the ${srcWidth}x${srcHeight} source bounds; the C++ bridge only fills the overlapping region and leaves the rest blank`,
      );
    }
    resolved[contract.origin.x] = x;
    resolved[contract.origin.y] = y;
  }

  return { params: resolved, width, height };
}

export class NativeDispatch {
  private readonly funcs = new Map<string, BoundFn>();

  constructor(
    private readonly mod: EngineBindingModule,
    private readonly lib: KoffiLib | undefined,
    private readonly codec: CodecConfig | undefined,
    private readonly libPath: string | undefined,
  ) {}

  isAvailable(): boolean {
    return !!this.lib;
  }

  get enginePath(): string {
    return this.libPath ?? "unavailable";
  }

  /** Lazily bind (and cache) a koffi function from its C prototype string. */
  private fn(op: OpBinding): BoundFn {
    const cached = this.funcs.get(op.name);
    if (cached) return cached;
    if (!this.lib) throw new Error(`engine '${this.mod.engine}' library not loaded`);
    const bound = this.lib.func(op.signature) as BoundFn;
    this.funcs.set(op.name, bound);
    return bound;
  }

  private find(name: string): OpBinding | undefined {
    return this.mod.ops.find((o) => o.name === name);
  }

  // ── ONNX gating (process-crash guard) ────────────────────────────────────
  //
  // A neural op that reaches the C++ bridge without a usable ONNX Runtime does
  // not throw — it ABORTS THE PROCESS (native access violation, see the sidecar
  // notes in `ffi/loader.ts`). `image.apply` is agent-callable, so that abort
  // takes the whole gateway down. Every neural op therefore has to be decided
  // in TypeScript, BEFORE any FFI call.
  //
  // This mirrors the existing `knownBroken` gate: one predicate consulted at
  // the same points, returning an honest reason string instead of dispatching.

  /** The ONNX spec for an op, or undefined when the op is pure C++. */
  private onnxSpec(opName: string): OnnxOpSpec | undefined {
    return this.mod.onnxOps?.get(opName);
  }

  /** True when the op runs model inference and so genuinely contends for VRAM. */
  isOnnxOp(opName: string): boolean {
    return this.onnxSpec(opName) !== undefined;
  }

  /**
   * Resolve where the C++ `OnnxModelHost` will look for an op's model.
   *
   * The host resolves `<env var>` when set and non-empty, else
   * `models/<file>` relative to THE LOADED MODULE's own directory (via
   * `GetModuleHandleExW`/`GetModuleFileNameW`), independent of the CWD — so the
   * directory to check is the one holding the resolved engine library.
   */
  private resolveModelPath(spec: OnnxOpSpec): string | undefined {
    const override = process.env[spec.modelEnvVar];
    if (override && override.length > 0) return override;
    if (!this.libPath) return undefined;
    return join(dirname(this.libPath), "models", spec.modelFile);
  }

  /**
   * Reason an op must not be dispatched, or undefined when it may run.
   * Covers both the `knownBroken` gate and the ONNX preconditions.
   */
  private gateReason(opName: string): string | undefined {
    if (this.mod.knownBroken.has(opName)) return `op '${opName}' is gated (known_broken)`;
    const spec = this.onnxSpec(opName);
    if (!spec) return undefined;

    const ortReason = onnxUnavailableReason();
    if (ortReason) {
      return `op '${opName}' is gated (onnx_unavailable): it runs the '${spec.modelId}' ONNX model, and ${ortReason} Calling it without a pre-loaded ONNX Runtime aborts the process, so it was not dispatched.`;
    }

    const modelPath = this.resolveModelPath(spec);
    if (!modelPath) {
      return `op '${opName}' is gated (onnx_model_unresolved): cannot resolve the '${spec.modelId}' model path because the engine library path is unknown.`;
    }
    if (!existsSync(modelPath)) {
      return `op '${opName}' is gated (onnx_model_missing): the '${spec.modelId}' model was not found at '${modelPath}'. Provision '${spec.modelFile}' there or point ${spec.modelEnvVar} at it — see binaries/README.md.`;
    }
    return undefined;
  }

  /**
   * Run `fn` under GPU cooperation when appropriate.
   *
   * ONNX ops go through `withGpuClaim` because they are the ops that can hold
   * VRAM; pure C++ ops take the direct path. Note the honest current state:
   * with `cufft64_11.dll` (CUDA 11 runtime) absent, ORT's CUDA execution
   * provider fails to load and every neural op actually runs on the CPU
   * provider, so no VRAM is claimed today. The claim is wired at the single
   * dispatch chokepoint so it is correct the moment the CUDA dependencies are
   * provisioned; it does not make GPU acceleration active by itself.
   *
   * With no broker published, `withGpuClaim` just runs `fn` (see gpu-coop.ts).
   */
  private runCooperatively<T>(usesOnnx: boolean, fn: () => Promise<T>): Promise<T> {
    return usesOnnx ? withGpuClaim(fn) : withoutGpuClaim(fn);
  }

  // ── Catalog ──────────────────────────────────────────────────────────────

  listOps(): OpCatalog {
    const ops: OpInfo[] = this.mod.ops
      .filter((op) => !this.mod.knownBroken.has(op.name))
      .map((op) => this.toOpInfo(op));
    return { engine: this.mod.engine, ops };
  }

  opInfo(name: string): OpInfo | undefined {
    const op = this.find(name);
    return op ? this.toOpInfo(op) : undefined;
  }

  private toOpInfo(op: OpBinding): OpInfo {
    return {
      id: op.name,
      name: op.name,
      description: op.description,
      supports_chain: op.chainable,
      params: op.params.map<OpParamDef>((p) => ({
        name: p.name,
        type: ffiTypeToParamType(p.type),
        required: false,
        default: p.default,
        description: p.description,
      })),
    };
  }

  // ── Apply ──────────────────────────────────────────────────────────────

  async applyOp(input: string, opName: string, output: string, params: Record<string, unknown>): Promise<ApplyResult> {
    const start = Date.now();
    const base: ApplyResult = { ok: false, output_path: output, engine_path: this.enginePath, duration_ms: 0 };
    if (!this.lib) return { ...base, reason: `engine '${this.mod.engine}' unavailable (native library not loaded)` };
    const gated = this.gateReason(opName);
    if (gated) return { ...base, reason: gated };
    const op = this.find(opName);
    if (!op) return { ...base, reason: `unknown op '${opName}' for engine '${this.mod.engine}'` };

    try {
      await this.runCooperatively(this.isOnnxOp(opName), async () => {
        switch (this.mod.engine) {
          case "image":
            await this.applyImage(op, input, output, params);
            break;
          case "audio":
            await this.applyAudio(op, input, output, params);
            break;
          case "video":
            await this.applyVideo(op, input, output, params);
            break;
          case "vector":
            await this.applyVector(op, input, output, params);
            break;
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ...base, reason: message, duration_ms: Date.now() - start };
    }
    return { ok: true, output_path: output, engine_path: this.enginePath, duration_ms: Date.now() - start };
  }

  async applyChain(input: string, steps: Step[], output: string): Promise<ApplyResult> {
    const start = Date.now();
    const base: ApplyResult = { ok: false, output_path: output, engine_path: this.enginePath, duration_ms: 0 };
    if (!this.lib) return { ...base, reason: `engine '${this.mod.engine}' unavailable (native library not loaded)` };
    if (steps.length === 0) return { ...base, reason: "empty chain" };

    // Gate the WHOLE chain up front. A chain that would abort the process on
    // step 3 must not run steps 1 and 2 and write a partial output first.
    for (const step of steps) {
      const gated = this.gateReason(step.op);
      if (gated) return { ...base, reason: gated };
    }
    // One claim for the whole chain rather than one per ONNX step: nested
    // claims are reference-counted by the broker handle, but a single
    // release/reclaim pair around the chain avoids evicting and reloading
    // Ollama models between steps.
    const usesOnnx = steps.some((step) => this.isOnnxOp(step.op));

    // Image and audio chains run entirely in-buffer (decode once, apply every
    // koffi op in-process, encode once) — no intermediate files.
    try {
      await this.runCooperatively(usesOnnx, async () => {
        if (this.mod.engine === "image") {
          await this.applyImageChain(input, steps, output);
        } else if (this.mod.engine === "audio") {
          await this.applyAudioChain(input, steps, output);
        } else {
          // Video/vector: sequential ops through short-lived temp files.
          await this.applySequentialChain(input, steps, output);
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ...base, reason: message, duration_ms: Date.now() - start };
    }
    return { ok: true, output_path: output, engine_path: this.enginePath, duration_ms: Date.now() - start };
  }

  // ── IMAGE ──────────────────────────────────────────────────────────────

  private ensureImageFilterable(op: OpBinding): void {
    if (op.kind === "special" || op.kind === "analysis") {
      throw new Error(`op '${op.name}' is not a single-input image filter (needs extra buffers/data)`);
    }
  }

  /**
   * Run one image op against an in-memory RGBA buffer. Returns the new buffer
   * plus its dimensions (which may differ for resizing/rotate/mask ops).
   */
  /**
   * Call a bound bridge function and enforce its status contract.
   *
   * Exports flagged `status: "bridgeOpStatus"` report their outcome as an int
   * (`BridgeOpStatus`). Ignoring it was silently wrong, not merely untidy: on
   * `OP_EXCEPTION` the C++ side sentinel-fills the output buffer with zeros and
   * returns 2, so a failed model load / failed ONNX session create / failed
   * inference produced a fully valid all-black image reported as `ok: true`.
   * Verified by pointing `OMNI_COLORIZE_MODEL` at a file that is not an ONNX
   * graph: `neural_colorize` returned `ok=true` before this check existed.
   */
  private callBridge(op: OpBinding, fn: BoundFn, args: unknown[]): void {
    const returned = fn(...args);
    if (op.status !== "bridgeOpStatus") {
      return;
    }
    const status = Number(returned);
    if (!Number.isFinite(status)) {
      throw new Error(
        `op '${op.name}' returned a non-numeric BridgeOpStatus (${String(returned)}); refusing to treat the output buffer as a real result`,
      );
    }
    if (!bridgeStatusIsUsable(status)) {
      throw new Error(`op '${op.name}' failed in the native bridge — ${describeBridgeStatus(status)}`);
    }
  }

  private runImageOp(
    op: OpBinding,
    data: Buffer,
    width: number,
    height: number,
    params: Record<string, unknown>,
  ): { data: Buffer; width: number; height: number; channels: number } {
    const fn = this.fn(op);
    const channels = 4;

    if (op.kind === "generator") {
      // Generators take (w, h, ...params, out) with no input pixels. On the
      // standalone apply path there is no source image, so `width`/`height`
      // arrive as 0 — fall through to the documented 512 default instead of
      // allocating a 0-byte buffer.
      const w = requirePositiveDim(op.name, "width", params.width, Number(params.width ?? (width > 0 ? width : 512)));
      const h = requirePositiveDim(op.name, "height", params.height, Number(params.height ?? (height > 0 ? height : 512)));
      const out = Buffer.alloc(w * h * 4);
      this.callBridge(op, fn, [w, h, ...scalarArgs(op, params), out]);
      return { data: out, width: w, height: h, channels: 4 };
    }

    if (op.kind === "mask" || MASK_FILTERS.has(op.name)) {
      const out = Buffer.alloc(width * height); // single channel
      if (op.name === "select_color_range") {
        // Special: RGB target color is a 3-byte buffer between the header and tolerance.
        const color = Buffer.from([Number(params.target_r ?? 0), Number(params.target_g ?? 0), Number(params.target_b ?? 0)]);
        const tolerance = Number(params.tolerance ?? 32);
        this.callBridge(op, fn, [data, width, height, channels, color, tolerance, out]);
      } else {
        this.callBridge(op, fn, [data, width, height, channels, ...scalarArgs(op, params), out]);
      }
      return { data: out, width, height, channels: 1 };
    }

    if (op.kind === "resizing" || RESIZING_FILTERS.has(op.name)) {
      // One resolution feeds BOTH the allocation and the C++ scalar args.
      const dims = resolveOutputDims(op, IMAGE_DIM_CONTRACTS[op.name], params, width, height);
      const out = Buffer.alloc(dims.width * dims.height * 4);
      this.callBridge(op, fn, [data, width, height, channels, ...scalarArgs(op, dims.params), out]);
      return { data: out, width: dims.width, height: dims.height, channels: 4 };
    }

    // Standard filter. rotate_90/rotate_270 keep the pixel count but swap dims.
    const out = Buffer.alloc(width * height * 4);
    this.callBridge(op, fn, [data, width, height, channels, ...scalarArgs(op, params), out]);
    if (DIMENSION_SWAP.has(op.name)) {
      return { data: out, width: height, height: width, channels: 4 };
    }
    return { data: out, width, height, channels: 4 };
  }

  private async applyImage(op: OpBinding, input: string, output: string, params: Record<string, unknown>): Promise<void> {
    this.ensureImageFilterable(op);
    let width = 0;
    let height = 0;
    // decodeImageRGBA yields Buffer<ArrayBufferLike>; widen the accumulator so
    // the decoded buffer assigns without narrowing to Buffer<ArrayBuffer>.
    let data: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    if (op.kind !== "generator") {
      const img = await decodeImageRGBA(input);
      data = img.data;
      width = img.width;
      height = img.height;
    }
    const result = this.runImageOp(op, data, width, height, params);
    if (result.channels === 1) {
      await encodeMaskPNG(result.data, result.width, result.height, output);
    } else {
      await encodeImageRGBA(result.data, result.width, result.height, output);
    }
  }

  private async applyImageChain(input: string, steps: Step[], output: string): Promise<void> {
    const img = await decodeImageRGBA(input);
    let buf = img.data;
    let width = img.width;
    let height = img.height;
    let channels = 4;
    for (const step of steps) {
      const op = this.find(step.op);
      if (!op) throw new Error(`unknown op '${step.op}'`);
      const gated = this.gateReason(op.name);
      if (gated) throw new Error(gated);
      this.ensureImageFilterable(op);
      if (channels !== 4) throw new Error(`op '${op.name}' cannot follow a mask-producing step in a chain`);
      const r = this.runImageOp(op, buf, width, height, step.params ?? {});
      buf = r.data;
      width = r.width;
      height = r.height;
      channels = r.channels;
    }
    if (channels === 1) await encodeMaskPNG(buf, width, height, output);
    else await encodeImageRGBA(buf, width, height, output);
  }

  // ── AUDIO ──────────────────────────────────────────────────────────────

  private ensureAudioFilterable(op: OpBinding): void {
    if (op.kind === "special" || op.kind === "analysis") {
      throw new Error(`op '${op.name}' needs stereo/byref handling and is not a mono file filter`);
    }
  }

  /** Run one audio op in place against a float32 sample buffer. */
  private runAudioOp(op: OpBinding, samples: Float32Array, sampleRate: number, params: Record<string, unknown>): Float32Array {
    const fn = this.fn(op);
    const withRate = { ...params, sample_rate: sampleRate };
    const args = scalarArgs(op, withRate);
    if (op.inPlace) {
      fn(samples, samples.length, ...args);
      return samples;
    }
    const out = new Float32Array(samples.length);
    fn(samples, samples.length, ...args, out);
    return out;
  }

  private async applyAudio(op: OpBinding, input: string, output: string, params: Record<string, unknown>): Promise<void> {
    this.ensureAudioFilterable(op);
    const { samples, sampleRate } = await decodeAudioF32(input, this.codec);
    const out = this.runAudioOp(op, samples, sampleRate, params);
    await encodeAudioF32(out, sampleRate, output, this.codec);
  }

  private async applyAudioChain(input: string, steps: Step[], output: string): Promise<void> {
    const decoded = await decodeAudioF32(input, this.codec);
    let samples = decoded.samples;
    for (const step of steps) {
      const op = this.find(step.op);
      if (!op) throw new Error(`unknown op '${step.op}'`);
      const gated = this.gateReason(op.name);
      if (gated) throw new Error(gated);
      this.ensureAudioFilterable(op);
      samples = this.runAudioOp(op, samples, decoded.sampleRate, step.params ?? {});
    }
    await encodeAudioF32(samples, decoded.sampleRate, output, this.codec);
  }

  // ── VIDEO (hybrid) ───────────────────────────────────────────────────────

  private async applyVideo(op: OpBinding, input: string, output: string, params: Record<string, unknown>): Promise<void> {
    if (op.kind === "ffmpeg") {
      await this.runFfmpegVideoOp(op, input, output, params);
      return;
    }
    if (op.kind === "analysis") {
      // Analysis ops don't produce media; the runtime surfaces their data via
      // listOps/op_info. For an apply call we run it and write nothing new.
      throw new Error(`op '${op.name}' is analysis-only; use the analysis path, not apply`);
    }
    if (op.kind === "special") {
      throw new Error(`op '${op.name}' needs multiple frames/handles and is not a single-frame filter`);
    }
    // Per-frame C++ op: decode → apply in-process to each frame → re-encode.
    const { frames, info } = await decodeVideoRGBA(input, this.codec);
    if (frames.length === 0) throw new Error("no frames decoded");
    const fn = this.fn(op);
    // Same contract as the image path: frame-resizing ops resolve their output
    // dimensions once, and that resolution feeds both the per-frame allocation
    // and the scalar args handed to C++.
    const dims: ResolvedDims =
      op.kind === "resizing"
        ? resolveOutputDims(op, VIDEO_DIM_CONTRACTS[op.name], params, info.width, info.height)
        : { params, width: info.width, height: info.height };
    const outFrames: Buffer[] = [];
    for (const frame of frames) {
      const out = Buffer.alloc(dims.width * dims.height * 4);
      fn(frame, info.width, info.height, 4, ...scalarArgs(op, dims.params), out);
      outFrames.push(out);
    }
    await encodeVideoRGBA(outFrames, dims.width, dims.height, info.fps, output, this.codec, input);
  }

  /** File-level ffmpeg pipeline ops (codec/container, not the effect itself). */
  private async runFfmpegVideoOp(op: OpBinding, input: string, output: string, params: Record<string, unknown>): Promise<void> {
    const ffmpeg = resolveFfmpeg(this.codec);
    const num = (k: string, d: number) => Number(params[k] ?? d);
    const str = (k: string, d: string) => String(params[k] ?? d);
    let args: string[];
    switch (op.name) {
      case "cut_clip": {
        const codecArgs = params.stream_copy === false ? ["-c:v", "libx264", "-c:a", "aac"] : ["-c", "copy"];
        args = ["-y", "-v", "error", "-ss", String(num("start_sec", 0)), "-to", String(num("end_sec", 0)), "-i", input, ...codecArgs, output];
        break;
      }
      case "remove_silence": {
        const nb = num("noise_db", -40);
        args = ["-y", "-v", "error", "-i", input, "-af", `silenceremove=stop_periods=-1:stop_duration=${num("min_duration", 0.5)}:stop_threshold=${nb}dB`, "-c:v", "libx264", output];
        break;
      }
      case "speed_ramp": {
        const f = num("factor", 2.0);
        const atempo = Math.min(2.0, Math.max(0.5, 1.0 / f));
        args = ["-y", "-v", "error", "-i", input, "-filter_complex", `[0:v]setpts=${1 / f}*PTS[v];[0:a]atempo=${atempo}[a]`, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-c:a", "aac", output];
        break;
      }
      case "add_subtitles":
        args = ["-y", "-v", "error", "-i", input, "-vf", `subtitles=${str("srt_path", "")}`, "-c:v", "libx264", "-c:a", "copy", output];
        break;
      case "extract_audio":
        args = ["-y", "-v", "error", "-i", input, "-vn", "-ar", "44100", "-ac", "2", output];
        break;
      case "replace_audio":
        args = ["-y", "-v", "error", "-i", input, "-i", str("audio_path", ""), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-shortest", output];
        break;
      case "thumbnail":
        args = ["-y", "-v", "error", "-ss", String(num("time_sec", 3)), "-i", input, "-frames:v", "1", output];
        break;
      case "stabilize":
        // Single-pass transform; a full two-pass detect/transform is available
        // via dedicated tooling. This applies deshake for a quick stabilize.
        args = ["-y", "-v", "error", "-i", input, "-vf", "deshake", "-c:v", "libx264", "-c:a", "copy", output];
        break;
      case "export_for_platform": {
        const size = { tiktok: "1080:1920", instagram: "1080:1920", youtube: "1920:1080", twitter: "1280:720", linkedin: "1920:1080" }[str("platform", "youtube")] ?? "1920:1080";
        args = ["-y", "-v", "error", "-i", input, "-vf", `scale=${size}:force_original_aspect_ratio=decrease,pad=${size}:(ow-iw)/2:(oh-ih)/2`, "-c:v", "libx264", "-crf", "23", "-preset", "fast", "-c:a", "aac", "-movflags", "+faststart", output];
        break;
      }
      default:
        throw new Error(`ffmpeg op '${op.name}' not implemented`);
    }
    await runCapture(ffmpeg, args);
  }

  // ── VECTOR (SVG) ─────────────────────────────────────────────────────────

  private async applyVector(op: OpBinding, input: string, output: string, params: Record<string, unknown>): Promise<void> {
    if (AFFINE_OPS.has(op.name)) {
      await this.applyVectorAffine(op, input, output, params);
      return;
    }
    if (RASTER_ONLY.has(op.name)) {
      await this.applyVectorRaster(op, output, params);
      return;
    }
    throw new Error(`op '${op.name}' operates on path arrays and is not a single SVG-file transform`);
  }

  /** Affine transform of an SVG's flattened points, re-serialized as SVG. */
  private async applyVectorAffine(op: OpBinding, input: string, output: string, params: Record<string, unknown>): Promise<void> {
    const { readFile, writeFile } = await import("node:fs/promises");
    const svg = await readFile(input, "utf8");
    const points = parseSvgPoints(svg);
    if (points.length === 0) throw new Error("no points parsed from SVG");
    const fn = this.fn(op);
    const inArr = Float32Array.from(points);
    const outArr = new Float32Array(points.length);
    const a = Number(params.a ?? 1), b = Number(params.b ?? 0), c = Number(params.c ?? 0), d = Number(params.d ?? 1);
    const tx = Number(params.tx ?? 0), ty = Number(params.ty ?? 0);
    fn(inArr, points.length, a, b, c, d, tx, ty, outArr);
    await writeFile(output, pointsToSvg(Array.from(outArr)), "utf8");
  }

  /** Rasterize a vector op (polygon/stroke/gradient) to a PNG. */
  private async applyVectorRaster(op: OpBinding, output: string, params: Record<string, unknown>): Promise<void> {
    const fn = this.fn(op);
    // Canvas size comes from the bindings' `w`/`h` params. Their binding
    // default is 0, which is not a canvas, so an omitted (or explicitly zero)
    // size falls back to 512 as before. `width` is NOT a canvas alias: on
    // `vector_rasterize_stroke` it is the STROKE width, and treating it as the
    // canvas width silently rasterized onto a tiny canvas.
    const w = requirePositiveDim(op.name, "w", params.w, Number(params.w ?? 512) || 512);
    const h = requirePositiveDim(op.name, "h", params.h, Number(params.h ?? 512) || 512);
    if (op.name === "gradient_linear") {
      const pixels = Buffer.alloc(w * h * 3);
      fn(pixels, w, h, 3, Number(params.r0 ?? 0), Number(params.g0 ?? 0), Number(params.b0 ?? 0), Number(params.r1 ?? 255), Number(params.g1 ?? 255), Number(params.b1 ?? 255), Number(params.angle_deg ?? 0));
      const sharp = (await import("sharp")).default;
      await sharp(pixels, { raw: { width: w, height: h, channels: 3 } }).png().toFile(output);
      return;
    }
    const pts = Array.isArray(params.points) ? (params.points as number[]) : [];
    if (pts.length === 0) throw new Error(`op '${op.name}' needs a 'points' array`);
    const inArr = Float32Array.from(pts);
    const mask = Buffer.alloc(w * h);
    if (op.name === "vector_rasterize_stroke") {
      fn(inArr, pts.length, Number(params.width ?? 2), w, h, mask);
    } else {
      fn(inArr, pts.length, w, h, mask);
    }
    await encodeMaskPNG(mask, w, h, output);
  }

  // ── Sequential (video/vector) chain via temp files ───────────────────────

  private async applySequentialChain(input: string, steps: Step[], output: string): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "creative-chain-"));
    try {
      let current = input;
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i]!;
        const isLast = i === steps.length - 1;
        const target = isLast ? output : join(dir, `step_${i}${extForOutput(output)}`);
        const res = await this.applyOp(current, step.op, target, step.params ?? {});
        if (!res.ok) throw new Error(res.reason ?? `step ${i} (${step.op}) failed`);
        current = target;
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Run an ffmpeg-analysis video op and return its structured data.
   *
   * Analysis output is read from the MERGED stdout+stderr stream. ffmpeg's
   * `showinfo` / `silencedetect` filters report through the log (stderr), and
   * `-f null -` throws stdout away, so a stdout-only capture returns 0 bytes on
   * a successful run and every regex below matches nothing. That is exactly how
   * `detect_scenes` came to report `{ cuts: [] }` for real footage that ffmpeg
   * had in fact cut — the old code only ever saw stderr on the FAILURE path,
   * via `.catch(e => Buffer.from(e.message))`, and then only its last 500
   * characters. See `RunCaptureOptions.includeStderr` in `codec.ts`.
   */
  async analyze(input: string, opName: string, params: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; reason?: string }> {
    const op = this.find(opName);
    if (!op || op.kind !== "analysis") return { ok: false, reason: `'${opName}' is not an analysis op` };
    if (this.mod.engine !== "video") return { ok: false, reason: "analysis only implemented for video" };
    const ffmpeg = resolveFfmpeg(this.codec);
    const capture = async (args: string[]): Promise<string> => {
      const out = await runCapture(ffmpeg, args, undefined, {
        includeStderr: true,
        allowNonZeroExit: true,
      }).catch((e: Error) => Buffer.from(e.message));
      return out.toString("utf8");
    };
    if (opName === "detect_scenes") {
      const threshold = Number(params.threshold ?? 0.3);
      const text = await capture(["-v", "info", "-i", input, "-vf", `select='gt(scene,${threshold})',showinfo`, "-f", "null", "-"]);
      const times = [...text.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
      return { ok: true, data: { cuts: [...new Set(times)].sort((a, b) => a - b) } };
    }
    if (opName === "detect_silence") {
      const nb = Number(params.noise_db ?? -40);
      const dur = Number(params.min_duration ?? 0.5);
      const text = await capture(["-v", "info", "-i", input, "-af", `silencedetect=noise=${nb}dB:d=${dur}`, "-f", "null", "-"]);
      const starts = [...text.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
      const ends = [...text.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
      const segments = starts.map((s, i) => ({ start: s, end: ends[i] ?? null }));
      return { ok: true, data: { segments } };
    }
    return { ok: false, reason: `analysis op '${opName}' not implemented` };
  }
}

// ── SVG helpers (lightweight, no external XML dep) ──────────────────────────

/** Extract a flat `[x0,y0,x1,y1,...]` point list from an SVG's polygon/polyline
 * `points` attributes and `path` `d` move/line commands. */
function parseSvgPoints(svg: string): number[] {
  const nums: number[] = [];
  for (const m of svg.matchAll(/points\s*=\s*"([^"]+)"/g)) {
    for (const n of m[1]!.split(/[\s,]+/).map(Number).filter((v) => Number.isFinite(v))) nums.push(n);
  }
  if (nums.length === 0) {
    for (const m of svg.matchAll(/[MLml]\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/g)) {
      nums.push(Number(m[1]), Number(m[2]));
    }
  }
  return nums;
}

/** Serialize a flat point list back to a minimal SVG polyline document. */
function pointsToSvg(points: number[]): string {
  const pairs: string[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) pairs.push(`${points[i]},${points[i + 1]}`);
  const xs = points.filter((_, i) => i % 2 === 0);
  const ys = points.filter((_, i) => i % 2 === 1);
  const w = Math.ceil(Math.max(1, ...xs));
  const h = Math.ceil(Math.max(1, ...ys));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n  <polyline fill="none" stroke="black" points="${pairs.join(" ")}"/>\n</svg>\n`;
}

function extForOutput(output: string): string {
  const dot = output.lastIndexOf(".");
  return dot >= 0 ? output.slice(dot) : "";
}
