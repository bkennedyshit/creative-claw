import type { CreativeCapabilityDescriptor } from "@openclaw/creative-contracts";
import { decodeImageRGBA, encodeImageRGBA, type CodecConfig } from "../ffi/codec.js";
import { loadEngine, unloadEngine, type KoffiLib } from "../ffi/loader.js";
import { transformVideoFrames } from "../ffi/video-stream.js";
import type { ApplyResult } from "../types.js";
import type { ExecutionContext } from "./execution.js";

const gradeProperties = {
  exposure: {
    type: "number",
    default: 0,
    minimum: -8,
    maximum: 8,
    description: "Exposure in stops",
  },
  saturation: { type: "number", default: 1, minimum: 0, maximum: 4 },
  contrast: { type: "number", default: 1, minimum: 0, maximum: 4 },
  temperature: { type: "number", default: 0, minimum: -1, maximum: 1 },
  tint: { type: "number", default: 0, minimum: -1, maximum: 1 },
};
const toneProperties = {
  mode: {
    type: "integer",
    default: 1,
    minimum: 0,
    maximum: 1,
    description: "0: Reinhard, 1: ACES filmic",
  },
  white_point: { type: "number", default: 1, minimum: 0.001, maximum: 16 },
};

/** C ABI owned by video-agent-ai/engine-src/bridge/omni_agent_bridge.cpp. */
export const VFX_CAPABILITIES: CreativeCapabilityDescriptor[] = ["image", "video"].flatMap((kind) =>
  ["color_grade", "tonemap"].map((operation) => ({
    id: `vfx.${kind}_${operation}`,
    version: "1.0.0",
    family: "video-vfx",
    label: `${kind === "video" ? "Video" : "Image"} ${operation === "color_grade" ? "Color Grade" : "Tone Map"}`,
    description: `Native ${operation === "color_grade" ? "ASC-CDL color grading" : "Reinhard/ACES tone mapping"} from the Video AI/VFX engine.`,
    inputs: { source: { dataType: kind, required: true } },
    outputs: { result: { dataType: kind, required: true } },
    parametersSchema: {
      type: "object",
      properties: operation === "color_grade" ? gradeProperties : toneProperties,
      additionalProperties: false,
    },
    execution: {
      runtime: "native",
      supportsProgress: false,
      supportsCancellation: false,
      deterministic: true,
      cacheable: true,
    },
    requirements: { gpu: "none", ...(kind === "video" ? { binaries: ["ffmpeg", "ffprobe"] } : {}) },
    risk: { writesFiles: true, mayOverwrite: false, externalUpload: false, publishes: false },
  })),
);

export class VfxEngineRuntime {
  private adapterLib?: KoffiLib;
  private unavailable = "Video AI/VFX bridge not loaded";
  private started = false;
  private grade?: (...args: unknown[]) => unknown;
  private tone?: (...args: unknown[]) => unknown;
  private resolvedPath = "";

  constructor(
    private binaryPath?: string,
    private codec?: CodecConfig,
  ) {}

  async ensureStarted() {
    if (this.started) {
      return;
    }
    this.started = true;
    const loaded = loadEngine("omni_vfx_bridge", this.binaryPath);
    if (!loaded.available) {
      this.unavailable = loaded.reason;
      return;
    }
    try {
      // The sibling ABI mutates RGB8, returns 0 on success, and does not accept RGBA.
      // Keep its prototypes separate from the existing RGBA video bridge.
      this.grade = loaded.lib.func(
        "int bridge_color_grade(uint8_t *rgb, int pixels, float lr, float lg, float lb, float gr, float gg, float gb, float ar, float ag, float ab, float saturation, float contrast, float exposure, float temperature, float tint)",
      );
      this.tone = loaded.lib.func(
        "int bridge_tonemap(uint8_t *rgb, int pixels, int mode, float white_point)",
      );
      this.adapterLib = loaded.lib;
      this.resolvedPath = loaded.path;
    } catch (error) {
      this.unavailable = `Video AI/VFX bridge ABI mismatch: ${String(error)}`;
      unloadEngine(loaded.lib);
    }
  }

  isAvailable() {
    return this.adapterLib !== undefined;
  }
  reason() {
    return this.isAvailable() ? undefined : this.unavailable;
  }
  async shutdown() {
    const lib = this.adapterLib;
    this.adapterLib = undefined;
    this.grade = undefined;
    this.tone = undefined;
    unloadEngine(lib);
  }

  private processRgba(rgba: Buffer, operation: string, params: Record<string, unknown>) {
    const pixels = rgba.length / 4;
    if (!Number.isInteger(pixels) || pixels <= 0 || pixels > 2147483647) {
      throw new Error("Invalid VFX frame dimensions");
    }
    const rgb = Buffer.alloc(pixels * 3);
    for (let p = 0; p < pixels; p++) {
      rgb[p * 3] = rgba[p * 4];
      rgb[p * 3 + 1] = rgba[p * 4 + 1];
      rgb[p * 3 + 2] = rgba[p * 4 + 2];
    }
    const status = operation.endsWith("color_grade")
      ? this.grade?.(
          rgb,
          pixels,
          0,
          0,
          0,
          1,
          1,
          1,
          1,
          1,
          1,
          params.saturation ?? 1,
          params.contrast ?? 1,
          params.exposure ?? 0,
          params.temperature ?? 0,
          params.tint ?? 0,
        )
      : this.tone?.(rgb, pixels, params.mode ?? 1, params.white_point ?? 1);
    if (status !== 0) {
      throw new Error(`Native Video AI/VFX operation returned status ${String(status)}`);
    }
    for (let p = 0; p < pixels; p++) {
      rgba[p * 4] = rgb[p * 3];
      rgba[p * 4 + 1] = rgb[p * 3 + 1];
      rgba[p * 4 + 2] = rgb[p * 3 + 2];
    }
  }

  async apply(
    input: string,
    operation: string,
    output: string,
    params: Record<string, unknown>,
    context: ExecutionContext = {},
  ): Promise<ApplyResult> {
    await this.ensureStarted();
    if (!this.isAvailable()) {
      throw new Error(this.unavailable);
    }
    if (!VFX_CAPABILITIES.some((cap) => cap.id === `vfx.${operation}`)) {
      throw new Error("Unknown Video AI/VFX operation");
    }
    const startedAt = Date.now();
    if (operation.startsWith("video_")) {
      await transformVideoFrames(
        input,
        output,
        async (frame) => {
          this.processRgba(frame, operation, params);
          return frame;
        },
        this.codec,
        context,
      );
    } else {
      const image = await decodeImageRGBA(input);
      this.processRgba(image.data, operation, params);
      await encodeImageRGBA(image.data, image.width, image.height, output);
    }
    return {
      ok: true,
      output_path: output,
      engine_path: this.resolvedPath,
      duration_ms: Date.now() - startedAt,
    };
  }
}
