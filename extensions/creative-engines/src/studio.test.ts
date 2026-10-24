import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreativeAssetSchema,
  CreativeArtifactSchema,
  CreativeGraphSchema,
  CreativeProjectSchema,
  type CreativeProject,
} from "@openclaw/creative-contracts";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import sharp from "sharp";
import { Check } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeDurationSec, resolveFfmpeg, runCapture } from "./ffi/codec.js";
import { ImageEngineRuntime } from "./runtime/image.js";
import { VideoEngineRuntime } from "./runtime/video.js";
import { CreativeStudio } from "./studio.js";

describe("Creative Studio native slice", () => {
  let directory: string;
  let studio: CreativeStudio;
  let reopen: () => CreativeStudio;
  let image: ImageEngineRuntime;
  let video: VideoEngineRuntime;

  beforeEach(async () => {
    image = new ImageEngineRuntime();
    video = new VideoEngineRuntime();
    directory = await mkdtemp(join(tmpdir(), "creative-studio-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: directory };
    reopen = () =>
      new CreativeStudio(
        join(directory, "project"),
        createPluginStateKeyedStoreForTests("creative-engines", {
          namespace: "studio-sources",
          maxEntries: 10000,
          env,
        }),
        createPluginStateKeyedStoreForTests("creative-engines", {
          namespace: "studio-runs",
          maxEntries: 10000,
          env,
        }),
        { image, video },
        undefined,
        createPluginStateKeyedStoreForTests<CreativeProject>("creative-engines", {
          namespace: "studio-projects",
          maxEntries: 100,
          env,
        }),
      );
    studio = reopen();
  });
  afterEach(async () => {
    await image.shutdown();
    await video.shutdown();
    resetPluginStateStoreForTests();
    await rm(directory, { recursive: true, force: true });
  });

  it("calls native invert, preserves source pixels, records lineage, and recovers after reopening SQLite", async () => {
    const input = join(directory, "source.png");
    await sharp({
      create: { width: 4, height: 4, channels: 4, background: { r: 20, g: 60, b: 110, alpha: 1 } },
    })
      .png()
      .toFile(input);
    const original = await readFile(input);
    const result = await studio.run({ engine: "image", input, op: "invert", params: {} });
    expect(result.ok).toBe(true);
    expect(Check(CreativeGraphSchema, result.graph)).toBe(true);
    expect(Check(CreativeArtifactSchema, result.artifact)).toBe(true);
    const pixels = await sharp(result.output).raw().toBuffer();
    expect([...pixels.subarray(0, 3)]).toEqual([235, 195, 145]);
    expect(await readFile(input)).toEqual(original);
    const snapshot = await studio.snapshot();
    expect(Check(CreativeProjectSchema, snapshot.project)).toBe(true);
    expect(Check(CreativeAssetSchema, snapshot.assets[0].asset)).toBe(true);
    expect(result.artifact.sourceAssetIds).toEqual([snapshot.assets[0].asset.id]);
    resetPluginStateStoreForTests();
    const recovered = await reopen().snapshot();
    expect(recovered.runs[0]).toEqual(snapshot.runs[0]);
    expect(await readFile(recovered.runs[0].output)).toEqual(await readFile(result.output));
    await expect(
      reopen().run({ engine: "image", input, output: input, op: "invert" }),
    ).rejects.toThrow("already exists");
    expect(await readFile(input)).toEqual(original);
  });

  it("passes explicit resize dimensions to native C++", async () => {
    const input = join(directory, "source.png");
    await sharp({ create: { width: 4, height: 4, channels: 4, background: "red" } })
      .png()
      .toFile(input);
    const result = await studio.run({
      engine: "image",
      input,
      op: "scale",
      params: { new_width: 8, new_height: 6 },
    });
    const metadata = await sharp(result.output).metadata();
    expect([metadata.width, metadata.height]).toEqual([8, 6]);
    expect(result.artifact.operation?.parameters).toEqual({ new_width: 8, new_height: 6 });
  });

  it("trims a real video using requested times and rejects an invalid interval", async () => {
    const input = join(directory, "source.mp4");
    await runCapture(resolveFfmpeg(undefined), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=64x48:rate=10",
      "-t",
      "4",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      input,
    ]);
    const result = await studio.run({
      engine: "video",
      input,
      op: "cut_clip",
      params: { start_sec: 1, end_sec: 3, stream_copy: false },
    });
    const duration = await probeDurationSec(result.output, undefined);
    expect(duration).toBeGreaterThan(1.8);
    expect(duration).toBeLessThan(2.3);
    expect(result.artifact.operation?.parameters).toEqual({
      start_sec: 1,
      end_sec: 3,
      stream_copy: false,
    });
    await expect(
      studio.run({ engine: "video", input, op: "cut_clip", params: { start_sec: 3, end_sec: 1 } }),
    ).rejects.toThrow("end_sec");
    expect((await studio.snapshot()).runs).toHaveLength(1);
    const throughEnd = await studio.run({
      engine: "video",
      input,
      op: "cut_clip",
      params: { start_sec: 1, stream_copy: false },
    });
    expect(await probeDurationSec(throughEnd.output, undefined)).toBeCloseTo(3, 0);
  }, 30000);
});
