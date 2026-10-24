import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AI_CAPABILITIES } from "../ai-capabilities.js";
import { probeDurationSec, resolveFfmpeg, resolveFfprobe, runCapture } from "../ffi/codec.js";
import { resolveBinaryPath, configureCudaProviderDependencies } from "../ffi/loader.js";
import { AiEngineRuntime } from "./ai.js";
import { ImageEngineRuntime } from "./image.js";

const binary = resolveBinaryPath("omni_image_bridge");
const model = binary && join(binary, "..", "models", "u2net.onnx");
describe.skipIf(!binary || !model || !existsSync(model))(
  "Real native AI image/video segmentation",
  () => {
    let directory: string;
    let image: ImageEngineRuntime;
    let ai: AiEngineRuntime;
    let photo: string;
    let video: string;
    beforeAll(async () => {
      configureCudaProviderDependencies({
        enabled: process.env.CREATIVE_ENGINES_EXPECT_CUDA === "1",
      });
      directory = await mkdtemp(join(tmpdir(), "creative-real-ai-"));
      image = new ImageEngineRuntime();
      ai = new AiEngineRuntime(image);
      await ai.ensureStarted();
      expect(ai.reason()).toBeUndefined();
      photo = join(directory, "source.png");
      await sharp(
        Buffer.from(
          '<svg width="96" height="72"><rect width="96" height="72" fill="#204060"/><circle cx="48" cy="22" r="12" fill="#efc590"/><path d="M30 70L34 38Q48 28 62 38L68 70Z" fill="#b03040"/></svg>',
        ),
      )
        .png()
        .toFile(photo);
      video = join(directory, "source.mp4");
      await runCapture(resolveFfmpeg(undefined), [
        "-v",
        "error",
        "-loop",
        "1",
        "-i",
        photo,
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=44100",
        "-t",
        "1",
        "-r",
        "2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        video,
      ]);
    }, 30000);
    afterAll(async () => {
      await image?.shutdown();
      if (directory) {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it.each(AI_CAPABILITIES)(
      "runs model-backed $id with real provenance",
      async (capability) => {
        const isVideo = capability.id.includes("video_");
        const output = join(directory, `${capability.id}${isVideo ? ".mp4" : ".png"}`);
        const result = await ai.apply(isVideo ? video : photo, capability.id.slice(3), output, {
          temporal_smoothing: 0.25,
        });
        expect(result.ok).toBe(true);
        if (process.env.CREATIVE_ENGINES_EXPECT_CUDA === "1") {
          expect(result.metadata?.executionProvider).toBe("cuda");
        }
        expect(result.metadata).toMatchObject({
          modelId: "u2net",
          modelHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          executionProvider: expect.stringMatching(/^(cpu|cuda)$/),
        });
        expect((await readFile(output)).length).toBeGreaterThan(0);
        if (isVideo) {
          expect(await probeDurationSec(output, undefined)).toBeCloseTo(1, 0);
          const streams = JSON.parse(
            (
              await runCapture(resolveFfprobe(undefined), [
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type",
                "-of",
                "json",
                output,
              ])
            ).toString("utf8"),
          ) as { streams: { codec_type: string }[] };
          expect(streams.streams.map((stream) => stream.codec_type)).toEqual(["video", "audio"]);
        } else if (capability.id.endsWith("cutout")) {
          const source = await sharp(photo).ensureAlpha().raw().toBuffer();
          const pixels = await sharp(output).ensureAlpha().raw().toBuffer();
          const alphas: number[] = [];
          for (let offset = 0; offset < pixels.length; offset += 4) {
            expect(pixels.subarray(offset, offset + 3)).toEqual(
              source.subarray(offset, offset + 3),
            );
            alphas.push(pixels[offset + 3]);
          }
          expect(Math.min(...alphas)).toBeLessThan(40);
          expect(Math.max(...alphas)).toBeGreaterThan(220);
        }
      },
      30000,
    );
  },
);
