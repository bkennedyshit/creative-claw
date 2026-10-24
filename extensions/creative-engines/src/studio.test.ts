import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CreativeAssetSchema,
  CreativeArtifactSchema,
  CreativeGraphSchema,
  CreativeProjectSchema,
  type CreativeProject,
  type CreativeGraph,
} from "@openclaw/creative-contracts";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import sharp from "sharp";
import { Check } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeDurationSec, resolveFfmpeg, resolveFfprobe, runCapture } from "./ffi/codec.js";
import { AudioEngineRuntime } from "./runtime/audio.js";
import { ImageEngineRuntime } from "./runtime/image.js";
import { VfxEngineRuntime } from "./runtime/vfx.js";
import { VideoEngineRuntime } from "./runtime/video.js";
import { buildStudioRecipe, STUDIO_RECIPES } from "./studio-recipes.js";
import { CreativeStudio } from "./studio.js";

const vfxBinary =
  process.env.VFX_NATIVE_TEST_BINARY ||
  fileURLToPath(
    new URL(
      `../../../../video-agent-ai/engine-src/lib/${process.platform === "win32" ? "omni_video_bridge.dll" : "libomni_video_bridge.so"}`,
      import.meta.url,
    ),
  );

describe("Creative Studio native slice", () => {
  let directory: string;
  let studio: CreativeStudio;
  let reopen: () => CreativeStudio;
  let image: ImageEngineRuntime;
  let audio: AudioEngineRuntime;
  let video: VideoEngineRuntime;
  let vfx: VfxEngineRuntime;

  beforeEach(async () => {
    image = new ImageEngineRuntime();
    audio = new AudioEngineRuntime();
    video = new VideoEngineRuntime();
    vfx = new VfxEngineRuntime(vfxBinary);
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
        { image, audio, video, vfx },
        undefined,
        createPluginStateKeyedStoreForTests<CreativeProject>("creative-engines", {
          namespace: "studio-projects",
          maxEntries: 100,
          env,
        }),
        createPluginStateKeyedStoreForTests<CreativeGraph>("creative-engines", {
          namespace: "studio-graphs",
          maxEntries: 1000,
          env,
        }),
      );
    studio = reopen();
  });
  afterEach(async () => {
    await image.shutdown();
    await audio.shutdown();
    await video.shutdown();
    await vfx.shutdown();
    resetPluginStateStoreForTests();
    await rm(directory, { recursive: true, force: true });
  });

  it.skipIf(!existsSync(vfxBinary))(
    "executes a reordered native/VFX workflow, records each node's lineage, and atomically saves revisions",
    async () => {
      const input = join(directory, "source.png");
      await sharp({
        create: {
          width: 4,
          height: 4,
          channels: 4,
          background: { r: 20, g: 60, b: 110, alpha: 1 },
        },
      })
        .png()
        .toFile(input);
      const original = await readFile(input);
      const first = await studio.run({ engine: "image", input, op: "invert" });
      const graph: CreativeGraph = {
        ...first.graph,
        id: "mixed-workflow",
        name: "Native and VFX",
        revision: 0,
        nodes: [
          {
            id: "resize",
            capability: "image.scale",
            parameters: { new_width: 8, new_height: 6 },
            position: { x: 600, y: 100 },
          },
          {
            id: "grade",
            capability: "vfx.image_color_grade",
            parameters: { saturation: 0 },
            position: { x: 350, y: 100 },
          },
          {
            id: "invert",
            capability: "image.invert",
            parameters: {},
            position: { x: 100, y: 100 },
          },
        ],
        edges: [
          {
            id: "source",
            sourceNodeId: "mixed-workflow",
            sourcePort: "source",
            targetNodeId: "invert",
            targetPort: "source",
          },
          {
            id: "grade",
            sourceNodeId: "invert",
            sourcePort: "output",
            targetNodeId: "grade",
            targetPort: "source",
          },
          {
            id: "resize",
            sourceNodeId: "grade",
            sourcePort: "result",
            targetNodeId: "resize",
            targetPort: "source",
          },
          {
            id: "result",
            sourceNodeId: "resize",
            sourcePort: "output",
            targetNodeId: "mixed-workflow",
            targetPort: "result",
          },
        ],
      };
      const saved = await studio.saveGraph(graph);
      expect(saved.graph.revision).toBe(1);
      expect(saved.validation.valid).toBe(true);
      const result = await studio.runGraph(saved.graph, input);
      expect(result.nodes.map((node) => node.node_id)).toEqual(["invert", "grade", "resize"]);
      const pixels = await sharp(result.output)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect([pixels.info.width, pixels.info.height]).toEqual([8, 6]);
      expect([...pixels.data.subarray(0, 3)]).toEqual([
        pixels.data[0],
        pixels.data[0],
        pixels.data[0],
      ]);
      expect(await readFile(input)).toEqual(original);
      const rows = (await studio.snapshot()).runs.filter((run) => run.graph.id === graph.id);
      expect(rows).toHaveLength(3);
      const grade = rows.find((run) => run.artifact.nodeId === "grade")!;
      const resize = rows.find((run) => run.artifact.nodeId === "resize")!;
      expect(resize.artifact.parentArtifactIds).toEqual([grade.artifact.id]);
      expect(grade.artifact.metadata.enginePath).toBe(vfxBinary);
      const updated = await studio.saveGraph({ ...saved.graph, name: "Revised workflow" });
      expect(updated.graph.revision).toBe(2);
      await expect(studio.saveGraph({ ...saved.graph, name: "Stale overwrite" })).rejects.toThrow(
        "changed elsewhere",
      );
      resetPluginStateStoreForTests();
      expect((await reopen().getGraph(graph.id)).name).toBe("Revised workflow");
      expect((await reopen().getGraph(graph.id)).nodes[0].position).toEqual({ x: 600, y: 100 });
      const cyclic = structuredClone(updated.graph);
      cyclic.edges[0] = { ...cyclic.edges[0], sourceNodeId: "resize", sourcePort: "output" };
      const draft = await reopen().saveGraph(cyclic);
      expect(draft.validation.valid).toBe(false);
      await expect(reopen().runGraph(draft.graph, "missing-file.png")).rejects.toThrow(/cycle/i);
    },
  );

  it.skipIf(!existsSync(vfxBinary))(
    "executes every demo recipe against real media and preserves independent copies",
    async () => {
      const input = join(directory, "demo.mp4");
      const png = join(directory, "demo.png");
      await sharp({
        create: {
          width: 64,
          height: 48,
          channels: 4,
          background: { r: 40, g: 100, b: 180, alpha: 1 },
        },
      })
        .png()
        .toFile(png);
      await runCapture(resolveFfmpeg(undefined), [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=64x48:rate=12",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=44100",
        "-t",
        "1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        input,
      ]);
      for (const recipe of STUDIO_RECIPES) {
        try {
          const graph = buildStudioRecipe(recipe.id);
          const result = await studio.runGraph(graph, recipe.sourceType === "image" ? png : input);
          expect(result.ok).toBe(true);
          expect((await readFile(result.output)).byteLength).toBeGreaterThan(0);
          expect(result.nodes.every((node) => node.status === "ok")).toBe(true);
          if (result.artifact.kind === "image") {
            expect((await sharp(result.output).metadata()).width).toBeGreaterThan(0);
          } else {
            expect(await probeDurationSec(result.output, undefined)).toBeGreaterThan(0.2);
          }
        } catch (error) {
          throw new Error(`Recipe failed: ${recipe.id}`, { cause: error });
        }
      }
      const saved = await studio.saveGraph(buildStudioRecipe("cinematic"));
      const copied = await studio.copyGraph(saved.graph);
      expect(copied.graph.id).not.toBe(saved.graph.id);
      expect(copied.graph.revision).toBe(1);
      expect(copied.validation.valid).toBe(true);
      expect((await studio.getGraph(saved.graph.id)).name).toBe("Cinematic warm film");
      await expect(studio.copyGraph({ nodes: [] })).rejects.toThrow("canonical workflow JSON");
    },
    120000,
  );

  it("changes video speed with matching audio tempo and supports silent clips", async () => {
    for (const sound of [true, false]) {
      const input = join(directory, `speed-${sound}.mp4`);
      await runCapture(resolveFfmpeg(undefined), [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=64x48:rate=24",
        ...(sound ? ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100"] : []),
        "-t",
        "2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        ...(sound ? ["-c:a", "aac"] : []),
        input,
      ]);
      for (const factor of [0.5, 2, 4]) {
        const result = await studio.run({
          engine: "video",
          input,
          op: "speed_ramp",
          params: { factor },
        });
        const metadata = JSON.parse(
          (
            await runCapture(resolveFfprobe(undefined), [
              "-v",
              "error",
              "-show_entries",
              "stream=codec_type,duration:format=duration",
              "-of",
              "json",
              result.output,
            ])
          ).toString("utf8"),
        ) as { streams: { codec_type: string; duration: string }[]; format: { duration: string } };
        const videoStream = metadata.streams.find((stream) => stream.codec_type === "video")!;
        expect(Number(videoStream.duration)).toBeCloseTo(2 / factor, 0);
        const audioStream = metadata.streams.find((stream) => stream.codec_type === "audio");
        expect(Boolean(audioStream)).toBe(sound);
        if (audioStream) {
          expect(
            Math.abs(Number(audioStream.duration) - Number(videoStream.duration)),
          ).toBeLessThan(0.2);
        }
      }
    }
  }, 30000);

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

  it.skipIf(!existsSync(vfxBinary))(
    "preserves image alpha and video audio through the sibling VFX bridge",
    async () => {
      const input = join(directory, "alpha.png");
      await sharp({
        create: {
          width: 4,
          height: 4,
          channels: 4,
          background: { r: 20, g: 60, b: 110, alpha: 0.5 },
        },
      })
        .png()
        .toFile(input);
      const imageResult = await studio.run({
        engine: "vfx",
        input,
        op: "image_color_grade",
        params: { saturation: 0 },
      });
      const pixels = await sharp(imageResult.output).ensureAlpha().raw().toBuffer();
      expect(pixels[0]).toBe(pixels[1]);
      expect(pixels[1]).toBe(pixels[2]);
      expect(pixels[3]).toBe(128);
      const videoInput = join(directory, "audio-video.mp4");
      await runCapture(resolveFfmpeg(undefined), [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=64x48:rate=10",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=44100",
        "-t",
        "1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        videoInput,
      ]);
      const result = await studio.run({
        engine: "vfx",
        input: videoInput,
        op: "video_tonemap",
        params: { mode: 1 },
      });
      const probe = JSON.parse(
        (
          await runCapture(resolveFfprobe(undefined), [
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,width,height:format=duration",
            "-of",
            "json",
            result.output,
          ])
        ).toString("utf8"),
      ) as {
        streams: { codec_type: string; width?: number; height?: number }[];
        format: { duration: string };
      };
      expect(probe.streams.map((stream) => stream.codec_type)).toEqual(["video", "audio"]);
      expect(probe.streams[0]).toMatchObject({ width: 64, height: 48 });
      expect(Number(probe.format.duration)).toBeCloseTo(1, 0);
      expect(result.artifact.metadata.enginePath).toBe(vfxBinary);
    },
    30000,
  );

  it("blocks invalid parameters, disconnected or disabled nodes and wrong media connections before file IO", async () => {
    const input = join(directory, "source.png");
    await sharp({ create: { width: 4, height: 4, channels: 4, background: "red" } })
      .png()
      .toFile(input);
    const { graph } = await studio.run({ engine: "image", input, op: "invert" });
    await expect(studio.saveGraph({ ...graph, inputs: [] })).rejects.toThrow("one source file");
    const wrongType = structuredClone(graph);
    wrongType.inputs[0].dataType = "video";
    await expect(studio.runGraph(wrongType, "missing.png")).rejects.toThrow(
      "Cannot connect video output to image input",
    );
    const disconnected = structuredClone(graph);
    disconnected.edges = disconnected.edges.filter((edge) => edge.targetNodeId === graph.id);
    await expect(studio.runGraph(disconnected, "missing.png")).rejects.toThrow(/input|source/i);
    const disabled = structuredClone(graph);
    disabled.nodes[0].disabled = true;
    await expect(studio.runGraph(disabled, "missing.png")).rejects.toThrow(/enabled|disabled/i);
    const invalidParameters = structuredClone(graph);
    invalidParameters.nodes[0].parameters = { bogus: 1 };
    const draft = await studio.saveGraph(invalidParameters);
    expect(draft.validation.valid).toBe(false);
    expect(draft.validation.issues[0].message).toContain("bogus");
    await expect(
      studio.run({ engine: "vfx", input: "missing.png", op: "image_tonemap", params: { mode: 2 } }),
    ).rejects.toThrow(/mode/);
    expect((await studio.snapshot()).runs).toHaveLength(1);
  });

  it("reports a missing VFX bridge without fabricating success or importing the source", async () => {
    const unavailable = new VfxEngineRuntime(join(directory, "missing-vfx.dll"));
    const result = await unavailable
      .apply("missing.png", "image_tonemap", join(directory, "output.png"), {})
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(unavailable.isAvailable()).toBe(false);
    await unavailable.shutdown();
    expect((await studio.snapshot()).runs).toEqual([]);
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
