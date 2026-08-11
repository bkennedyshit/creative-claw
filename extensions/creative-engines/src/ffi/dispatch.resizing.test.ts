/**
 * Resizing-op dimension contract — REAL native engine, no mocks.
 *
 * These tests pin the honesty invariant that `NativeDispatch.runImageOp` used
 * to violate: the OUT BUFFER size and the SCALAR dimension args handed to the
 * C++ bridge must come from the SAME resolved values. When they disagreed the
 * buffer was allocated for the inferred size while C++ was told to write a
 * 0-wide/0-tall image, so the op reported `ok: true` and wrote a fully blank
 * file.
 *
 * Every assertion drives the shipping `ImageEngineRuntime` against the bundled
 * `libomni_image_bridge`; the output is decoded with the real
 * `decodeImageRGBA` and its non-zero byte count is asserted (a blank/zeroed
 * buffer cannot pass).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { ImageEngineRuntime } from "../runtime/image.js";
import { VideoEngineRuntime } from "../runtime/video.js";
import { decodeImageRGBA, decodeVideoRGBA, probeVideo } from "./codec.js";
import { resolveBinaryPath } from "./loader.js";

const ENGINE_AVAILABLE = resolveBinaryPath("omni_image_bridge") !== undefined;
const VIDEO_ENGINE_AVAILABLE = resolveBinaryPath("omni_video_bridge") !== undefined;

function hasFfmpeg(): boolean {
  try {
    execSync(process.platform === "win32" ? "where ffmpeg" : "which ffmpeg", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
const FFMPEG_AVAILABLE = hasFfmpeg();

/** The same real 4x4 non-uniform RGBA PNG fixture the smoke suite uses. */
const PNG_4X4_RGBA_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAM0lEQVR4nBXIMREAQRDDsK8XWIAFWGqz8s+p1HeHOezhDr8LJtjg8qKYYovri2GGHW74A/xIKPGjpQFDAAAAAElFTkSuQmCC";

let tempDir: string;
let inputPng: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "creative-dispatch-dims-"));
  inputPng = join(tempDir, "input-4x4.png");
  writeFileSync(inputPng, Buffer.from(PNG_4X4_RGBA_BASE64, "base64"));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function countNonZero(data: Buffer): number {
  let n = 0;
  for (const byte of data) if (byte !== 0) n += 1;
  return n;
}

/** Decode an output file and report its dimensions + non-zero byte count. */
async function probe(label: string, path: string): Promise<{ width: number; height: number; nonZero: number; total: number }> {
  const decoded = await decodeImageRGBA(path);
  const nonZero = countNonZero(decoded.data);
  // eslint-disable-next-line no-console
  console.log(
    `[${label}] decoded ${decoded.width}x${decoded.height}, nonZeroBytes = ${nonZero}/${decoded.data.length}`,
  );
  return { width: decoded.width, height: decoded.height, nonZero, total: decoded.data.length };
}

describe.skipIf(!ENGINE_AVAILABLE)("image resizing ops — out buffer and C++ scalar args agree", () => {
  it("scale with only new_width produces a real 16x4 image (missing dim defaults to the source dim)", async () => {
    const runtime = new ImageEngineRuntime();
    await runtime.start();
    try {
      const output = join(tempDir, "scale-w-only.png");
      const result = await runtime.apply(inputPng, "scale", output, { new_width: 16 });
      // eslint-disable-next-line no-console
      console.log(`[scale {new_width:16}] ok=${result.ok} reason=${result.reason ?? "-"}`);
      expect(result.ok, `scale failed: ${result.reason}`).toBe(true);

      const p = await probe("scale {new_width:16}", output);
      expect(p.width).toBe(16);
      expect(p.height).toBe(4); // source height carried through
      expect(p.nonZero).toBeGreaterThan(0);
    } finally {
      await runtime.shutdown();
    }
  });

  it("scale with only new_height produces a real 4x8 image", async () => {
    const runtime = new ImageEngineRuntime();
    await runtime.start();
    try {
      const output = join(tempDir, "scale-h-only.png");
      const result = await runtime.apply(inputPng, "scale", output, { new_height: 8 });
      // eslint-disable-next-line no-console
      console.log(`[scale {new_height:8}] ok=${result.ok} reason=${result.reason ?? "-"}`);
      expect(result.ok, `scale failed: ${result.reason}`).toBe(true);

      const p = await probe("scale {new_height:8}", output);
      expect(p.width).toBe(4);
      expect(p.height).toBe(8);
      expect(p.nonZero).toBeGreaterThan(0);
    } finally {
      await runtime.shutdown();
    }
  });

  it("scale with an explicit zero dimension is rejected instead of writing a blank file", async () => {
    const runtime = new ImageEngineRuntime();
    await runtime.start();
    try {
      const output = join(tempDir, "scale-zero.png");
      const result = await runtime.apply(inputPng, "scale", output, { new_width: 0, new_height: 8 });
      // eslint-disable-next-line no-console
      console.log(`[scale {new_width:0}] ok=${result.ok} reason=${result.reason ?? "-"}`);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/new_width/);
      expect(existsSync(output)).toBe(false);
    } finally {
      await runtime.shutdown();
    }
  });

  it("crop without a rectangle size is rejected with a reason naming the missing params", async () => {
    const runtime = new ImageEngineRuntime();
    await runtime.start();
    try {
      const output = join(tempDir, "crop-no-size.png");
      const result = await runtime.apply(inputPng, "crop", output, { crop_x: 0, crop_y: 0 });
      // eslint-disable-next-line no-console
      console.log(`[crop {crop_x:0,crop_y:0}] ok=${result.ok} reason=${result.reason ?? "-"}`);
      if (existsSync(output)) await probe("crop {crop_x:0,crop_y:0}", output);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/crop_width/);
      expect(existsSync(output)).toBe(false);
    } finally {
      await runtime.shutdown();
    }
  });

  it("crop with a full rectangle produces a real 2x2 image", async () => {
    const runtime = new ImageEngineRuntime();
    await runtime.start();
    try {
      const output = join(tempDir, "crop-2x2.png");
      const result = await runtime.apply(inputPng, "crop", output, {
        crop_x: 1,
        crop_y: 1,
        crop_width: 2,
        crop_height: 2,
      });
      // eslint-disable-next-line no-console
      console.log(`[crop 1,1,2x2] ok=${result.ok} reason=${result.reason ?? "-"}`);
      expect(result.ok, `crop failed: ${result.reason}`).toBe(true);

      const p = await probe("crop 1,1,2x2", output);
      expect(p.width).toBe(2);
      expect(p.height).toBe(2);
      expect(p.nonZero).toBeGreaterThan(0);
    } finally {
      await runtime.shutdown();
    }
  });

  it("crop outside the source bounds is rejected instead of reading past the input buffer", async () => {
    const runtime = new ImageEngineRuntime();
    await runtime.start();
    try {
      const output = join(tempDir, "crop-oob.png");
      const result = await runtime.apply(inputPng, "crop", output, {
        crop_x: 2,
        crop_y: 2,
        crop_width: 4,
        crop_height: 4,
      });
      // eslint-disable-next-line no-console
      console.log(`[crop 2,2,4x4 (OOB)] ok=${result.ok} reason=${result.reason ?? "-"}`);
      if (existsSync(output)) await probe("crop 2,2,4x4 (OOB)", output);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/bounds/i);
    } finally {
      await runtime.shutdown();
    }
  });

  it("seam_carving with only new_width carves for real (same source fallback as scale)", async () => {
    const runtime = new ImageEngineRuntime();
    await runtime.start();
    try {
      const output = join(tempDir, "seam-3x4.png");
      const result = await runtime.apply(inputPng, "seam_carving", output, { new_width: 3 });
      // eslint-disable-next-line no-console
      console.log(`[seam_carving {new_width:3}] ok=${result.ok} reason=${result.reason ?? "-"}`);
      expect(result.ok, `seam_carving failed: ${result.reason}`).toBe(true);

      const p = await probe("seam_carving {new_width:3}", output);
      expect(p.width).toBe(3);
      expect(p.height).toBe(4);
      expect(p.nonZero).toBeGreaterThan(0);
    } finally {
      await runtime.shutdown();
    }
  });

  it("a chained resizing step with one dimension still resizes for real", async () => {
    const runtime = new ImageEngineRuntime();
    await runtime.start();
    try {
      const output = join(tempDir, "chain-partial-scale.png");
      const result = await runtime.applyChain(
        inputPng,
        [
          { op: "grayscale", params: {} },
          { op: "scale", params: { new_width: 12 } },
        ],
        output,
      );
      // eslint-disable-next-line no-console
      console.log(`[chain grayscale→scale{new_width:12}] ok=${result.ok} reason=${result.reason ?? "-"}`);
      expect(result.ok, `chain failed: ${result.reason}`).toBe(true);

      const p = await probe("chain grayscale→scale{new_width:12}", output);
      expect(p.width).toBe(12);
      expect(p.height).toBe(4);
      expect(p.nonZero).toBeGreaterThan(0);
    } finally {
      await runtime.shutdown();
    }
  });
});

/**
 * The video engine has the same class of params-sized ops
 * (`video_transform_resize` / `video_transform_crop`) and had the same
 * disagreement: the per-frame buffer was sized from `params.dw ?? params.cw ??
 * info.width` (note the cross-op `cw` fallback) while C++ got the binding
 * default of 0.
 */
describe.skipIf(!VIDEO_ENGINE_AVAILABLE || !FFMPEG_AVAILABLE)(
  "video per-frame resizing ops — out buffer and C++ scalar args agree",
  () => {
    let inputMp4: string;

    beforeAll(() => {
      inputMp4 = join(tempDir, "input-8x8.mp4");
      execSync(
        `ffmpeg -y -v error -f lavfi -i testsrc=size=8x8:rate=10:duration=0.5 -pix_fmt yuv420p "${inputMp4}"`,
        { stdio: "pipe" },
      );
    });

    it("video_transform_resize with only dw produces real 16x8 frames", async () => {
      const runtime = new VideoEngineRuntime();
      await runtime.start();
      try {
        const output = join(tempDir, "video-resize-w-only.mp4");
        const result = await runtime.apply(inputMp4, "video_transform_resize", output, { dw: 16 });
        // eslint-disable-next-line no-console
        console.log(`[video_transform_resize {dw:16}] ok=${result.ok} reason=${result.reason ?? "-"}`);
        expect(result.ok, `video resize failed: ${result.reason}`).toBe(true);

        const info = await probeVideo(output, undefined);
        const { frames } = await decodeVideoRGBA(output, undefined);
        const nonZero = frames.length > 0 ? countNonZero(frames[0]!) : 0;
        // eslint-disable-next-line no-console
        console.log(
          `[video_transform_resize {dw:16}] decoded ${info.width}x${info.height}, frames=${frames.length}, frame0 nonZeroBytes = ${nonZero}/${frames[0]?.length ?? 0}`,
        );
        expect(info.width).toBe(16);
        expect(info.height).toBe(8);
        expect(nonZero).toBeGreaterThan(0);
      } finally {
        await runtime.shutdown();
      }
    });

    it("video_transform_crop without a rectangle size is rejected", async () => {
      const runtime = new VideoEngineRuntime();
      await runtime.start();
      try {
        const output = join(tempDir, "video-crop-no-size.mp4");
        const result = await runtime.apply(inputMp4, "video_transform_crop", output, { x: 0, y: 0 });
        // eslint-disable-next-line no-console
        console.log(`[video_transform_crop {x:0,y:0}] ok=${result.ok} reason=${result.reason ?? "-"}`);
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/'cw'/);
        expect(existsSync(output)).toBe(false);
      } finally {
        await runtime.shutdown();
      }
    });
  },
);
