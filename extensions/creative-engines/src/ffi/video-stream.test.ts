import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeDurationSec, resolveFfmpeg, runCapture } from "./codec.js";
import { probeVideoStream, transformVideoFrames } from "./video-stream.js";

describe("Bounded video frame streaming", () => {
  let directory: string;
  let input: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "creative-stream-"));
    input = join(directory, "source.mp4");
    await runCapture(resolveFfmpeg(undefined), [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=64x48:rate=12",
      "-t",
      "2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      input,
    ]);
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  it("processes frames sequentially with progress and duration intact", async () => {
    const output = join(directory, "processed.mp4");
    const progress: number[] = [];
    let active = 0;
    const result = await transformVideoFrames(
      input,
      output,
      async (frame) => {
        expect(++active).toBe(1);
        expect(frame.length).toBe(64 * 48 * 4);
        await Promise.resolve();
        active--;
        return frame;
      },
      undefined,
      {
        onProgress: (value) => {
          if (value.frames) {
            progress.push(value.frames);
          }
        },
      },
    );
    expect(result.frames).toBe(24);
    expect(progress.at(-1)).toBe(24);
    expect(await probeDurationSec(output, undefined)).toBeCloseTo(2, 0);
  });
  it("cancels between frames, terminates codecs and removes temporary output", async () => {
    const output = join(directory, "cancelled.mp4");
    const controller = new AbortController();
    await expect(
      transformVideoFrames(input, output, async (frame) => frame, undefined, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.frames === 3) {
            controller.abort(new Error("User cancelled"));
          }
        },
      }),
    ).rejects.toThrow("User cancelled");
    expect((await readdir(directory)).some((name) => name.includes("cancelled"))).toBe(false);
  });
  it("preserves an existing output file and rejects invalid destinations", async () => {
    const output = join(directory, "existing.mp4");
    await writeFile(output, "user-owned bytes");
    await expect(transformVideoFrames(input, output, async (frame) => frame)).rejects.toThrow();
    expect(await readFile(output, "utf8")).toBe("user-owned bytes");
    await expect(
      transformVideoFrames(input, join(directory, "missing", "output.mp4"), async (frame) => frame),
    ).rejects.toThrow();
    expect((await readdir(directory)).some((name) => name.includes("partial"))).toBe(false);
  });
  it("accounts for rotation metadata in decoded geometry", async () => {
    const rotated = join(directory, "rotated.mp4");
    await runCapture(resolveFfmpeg(undefined), [
      "-v",
      "error",
      "-display_rotation:v:0",
      "90",
      "-i",
      input,
      "-c",
      "copy",
      rotated,
    ]);
    expect(await probeVideoStream(rotated)).toMatchObject({ width: 48, height: 64, fps: 12 });
    const output = join(directory, "rotation-output.mp4");
    await transformVideoFrames(rotated, output, async (frame) => frame);
    expect(await probeVideoStream(output)).toMatchObject({ width: 48, height: 64 });
  });
});
