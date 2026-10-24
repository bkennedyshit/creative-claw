import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import sharp from "sharp";
import { AI_CAPABILITIES } from "../ai-capabilities.js";
import { decodeImageRGBA, encodeImageRGBA, type CodecConfig } from "../ffi/codec.js";
import { transformVideoFrames } from "../ffi/video-stream.js";
import type { ApplyResult } from "../types.js";
import type { ExecutionContext } from "./execution.js";
import type { ImageEngineRuntime } from "./image.js";

export class AiEngineRuntime {
  constructor(
    private image: ImageEngineRuntime,
    private codec?: CodecConfig,
  ) {}
  async ensureStarted() {
    await this.image.ensureStarted();
  }
  isAvailable() {
    return this.image.isAvailable() && !this.image.segmentationReason();
  }
  reason() {
    return this.image.segmentationReason();
  }

  async apply(
    input: string,
    operation: string,
    output: string,
    params: Record<string, unknown>,
    context: ExecutionContext = {},
  ): Promise<ApplyResult> {
    const descriptor = AI_CAPABILITIES.find((capability) => capability.id === `ai.${operation}`);
    if (!descriptor) {
      throw new Error("Unknown AI operation");
    }
    context.signal?.throwIfAborted();
    const started = Date.now();
    let enginePath = "";
    let provider = "";
    let modelPath = "";
    let previousMask: Buffer | undefined;
    await this.image.withForegroundSegmenter(async (segment) => {
      const process = async (frame: Buffer, width: number, height: number) => {
        context.signal?.throwIfAborted();
        const result = await segment(frame, width, height);
        context.signal?.throwIfAborted();
        enginePath = result.enginePath;
        provider = result.provider;
        modelPath = result.modelPath ?? "";
        const mask = result.mask;
        if (operation.startsWith("video_") && previousMask) {
          const weight = Number(params.temporal_smoothing ?? 0.25);
          for (let pixel = 0; pixel < mask.length; pixel++) {
            mask[pixel] = Math.round(mask[pixel] * (1 - weight) + previousMask[pixel] * weight);
          }
        }
        previousMask = mask;
        const background = operation.endsWith("background_blur")
          ? await sharp(frame, { raw: { width, height, channels: 4 } })
              .blur(Number(params.blur_sigma ?? 12))
              .raw()
              .toBuffer()
          : undefined;
        const color = [
          Number(params.red ?? 30),
          Number(params.green ?? 180),
          Number(params.blue ?? 30),
        ];
        for (let pixel = 0; pixel < mask.length; pixel++) {
          const offset = pixel * 4;
          if (operation.endsWith("matte")) {
            frame[offset] = frame[offset + 1] = frame[offset + 2] = mask[pixel];
            frame[offset + 3] = 255;
          } else if (operation.endsWith("cutout")) {
            frame[offset + 3] = Math.round((frame[offset + 3] * mask[pixel]) / 255);
          } else {
            const alpha = ((mask[pixel] / 255) * frame[offset + 3]) / 255;
            for (let channel = 0; channel < 3; channel++) {
              frame[offset + channel] = Math.round(
                frame[offset + channel] * alpha +
                  (background?.[offset + channel] ?? color[channel]) * (1 - alpha),
              );
            }
            frame[offset + 3] = 255;
          }
        }
        return frame;
      };
      if (operation.startsWith("video_")) {
        await transformVideoFrames(input, output, process, this.codec, context);
      } else {
        const image = await decodeImageRGBA(input);
        const result = await process(image.data, image.width, image.height);
        const temp = join(dirname(output), `.${basename(output)}.${randomUUID()}.partial.png`);
        try {
          await encodeImageRGBA(result, image.width, image.height, temp);
          context.signal?.throwIfAborted();
          await copyFile(temp, output, constants.COPYFILE_EXCL);
        } finally {
          await rm(temp, { force: true });
        }
        context.onProgress?.({ stage: "processing", frames: 1, totalFrames: 1 });
      }
    });
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(modelPath)) {
      hash.update(chunk);
    }
    return {
      ok: true,
      output_path: output,
      engine_path: enginePath,
      duration_ms: Date.now() - started,
      metadata: {
        modelId: "u2net",
        modelPath,
        modelHash: `sha256:${hash.digest("hex")}`,
        executionProvider: provider,
        temporalMethod: operation.startsWith("video_") ? "per-frame EMA" : "single image",
      },
    };
  }
}
