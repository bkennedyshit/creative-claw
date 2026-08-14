/**
 * Unit coverage for the creative-engines keyframe video-understanding provider.
 *
 * These tests use fake engine/vision seams on purpose: they pin the CONTRACT
 * (which config resolves the vision model, which timestamps are sampled, that
 * timestamps survive into the output, that every missing precondition throws a
 * named failure instead of returning a fabricated description, and that temp
 * frames are removed on both the success and throw paths). The real
 * engine/ffmpeg/Ollama path is covered by `video-understanding.live.test.ts`,
 * which is env-gated.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { VideoDescriptionRequest } from "openclaw/plugin-sdk/media-understanding";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createVideoUnderstandingProvider,
  formatVideoDescription,
  parseVisionModelRef,
  planKeyframeTimestamps,
  resolveVisionModelRef,
  trimNarrationText,
  type VideoUnderstandingDeps,
} from "./video-understanding.js";

function cfg(partial: Record<string, unknown> = {}): OpenClawConfig {
  return partial as unknown as OpenClawConfig;
}

function videoRequest(overrides: Partial<VideoDescriptionRequest> = {}): VideoDescriptionRequest {
  return {
    buffer: Buffer.from("not-a-real-container-but-never-decoded-by-the-fakes"),
    fileName: "clip.mp4",
    mime: "video/mp4",
    apiKey: "openclaw-local-no-auth",
    timeoutMs: 120_000,
    ...overrides,
  } as VideoDescriptionRequest;
}

/** Records which temp dirs the provider created so cleanup can be asserted. */
function trackedTempDirs(before: Set<string>): string[] {
  const root = tmpdir();
  return readdirSync(root)
    .filter((entry) => entry.startsWith("creative-engines-video-understanding-"))
    .filter((entry) => !before.has(entry))
    .map((entry) => join(root, entry));
}

function tempSnapshot(): Set<string> {
  return new Set(
    readdirSync(tmpdir()).filter((entry) =>
      entry.startsWith("creative-engines-video-understanding-"),
    ),
  );
}

type FakeDeps = VideoUnderstandingDeps & {
  applyCalls: Array<{ op: string; output: string; params: Record<string, unknown> }>;
  describeCalls: Array<{ filePath: string; provider: string; model: string }>;
};

type FakeOptions = Omit<Partial<VideoUnderstandingDeps>, "videoEngine"> & {
  /** Overrides merged over the default engine seam; call recording is kept. */
  engine?: Partial<VideoUnderstandingDeps["videoEngine"]>;
};

/**
 * Build fake deps whose call recorders always belong to the returned object.
 * Overrides are merged INSIDE so a partial engine/vision override cannot
 * silently detach the recording arrays.
 */
function fakeDeps(options: FakeOptions = {}): FakeDeps {
  const applyCalls: FakeDeps["applyCalls"] = [];
  const describeCalls: FakeDeps["describeCalls"] = [];
  const { engine, describeImage: describeImageOverride, ...rest } = options;
  const defaultApply: VideoUnderstandingDeps["videoEngine"]["apply"] = async (
    _input,
    _op,
    output,
  ) => {
    // Write a non-empty file: the provider rejects 0-byte "frames".
    const { writeFile } = await import("node:fs/promises");
    await writeFile(output, Buffer.alloc(64, 7));
    return { ok: true };
  };
  const apply = engine?.apply ?? defaultApply;
  const defaultDescribe: VideoUnderstandingDeps["describeImage"] = async (params) => ({
    text: `frame at ${params.filePath}`,
    model: params.model,
  });
  const describeFrame = describeImageOverride ?? defaultDescribe;
  const deps: VideoUnderstandingDeps = {
    videoEngine: {
      ensureStarted: async () => {},
      isAvailable: () => true,
      reason: () => undefined,
      analyze: async () => ({ ok: true, data: { cuts: [] } }),
      ...engine,
      apply: async (input, op, output, params) => {
        applyCalls.push({ op, output, params });
        return await apply(input, op, output, params);
      },
    },
    resolveConfig: () => cfg(),
    probeDuration: async () => 12,
    pluginConfig: { visionModel: "ollama/qwen2.5vl:7b", maxFrames: 3 },
    ...rest,
    describeImage: async (params) => {
      describeCalls.push({
        filePath: params.filePath,
        provider: params.provider,
        model: params.model,
      });
      return await describeFrame(params);
    },
  };
  return Object.assign(deps, { applyCalls, describeCalls });
}

describe("parseVisionModelRef", () => {
  it("splits provider/model and keeps the tag colon inside the model id", () => {
    expect(parseVisionModelRef("ollama/qwen2.5vl:7b", "x", "src")).toEqual({
      provider: "ollama",
      model: "qwen2.5vl:7b",
      source: "src",
    });
  });

  it("applies the default provider when there is no prefix", () => {
    expect(parseVisionModelRef("qwen2.5vl:7b", "ollama", "src")).toEqual({
      provider: "ollama",
      model: "qwen2.5vl:7b",
      source: "src",
    });
  });

  it("returns null for empty input", () => {
    expect(parseVisionModelRef(undefined, "ollama", "src")).toBeNull();
    expect(parseVisionModelRef("   ", "ollama", "src")).toBeNull();
  });
});

describe("resolveVisionModelRef", () => {
  it("prefers the model the host passed from tools.media.video.models", () => {
    const ref = resolveVisionModelRef({
      requestModel: "ollama/qwen2.5vl:32b",
      pluginConfig: { visionModel: "ollama/qwen2.5vl:7b" },
      cfg: cfg(),
    });
    expect(ref).toMatchObject({ provider: "ollama", model: "qwen2.5vl:32b" });
    expect(ref?.source).toContain("tools.media.video.models");
  });

  it("ignores a request model that points back at this provider", () => {
    // `{ provider: "creative-engines", model: "creative-engines/x" }` would be a
    // self-reference; fall through to real config instead of recursing.
    const ref = resolveVisionModelRef({
      requestModel: "creative-engines/whatever",
      pluginConfig: { visionModel: "ollama/qwen2.5vl:7b" },
      cfg: cfg(),
    });
    expect(ref).toMatchObject({ provider: "ollama", model: "qwen2.5vl:7b" });
  });

  it("falls back to tools.media.image.models before agents.defaults.imageModel", () => {
    const ref = resolveVisionModelRef({
      pluginConfig: {},
      cfg: cfg({
        tools: { media: { image: { models: [{ provider: "ollama", model: "gemma4:12b" }] } } },
        agents: { defaults: { imageModel: "openai/gpt-5.5" } },
      }),
    });
    expect(ref).toMatchObject({ provider: "ollama", model: "gemma4:12b" });
    expect(ref?.source).toBe("tools.media.image.models[0]");
  });

  it("uses agents.defaults.imageModel as the last resort", () => {
    const ref = resolveVisionModelRef({
      cfg: cfg({ agents: { defaults: { imageModel: { primary: "ollama/qwen2.5vl:3b" } } } }),
    });
    expect(ref).toMatchObject({
      provider: "ollama",
      model: "qwen2.5vl:3b",
      source: "agents.defaults.imageModel",
    });
  });

  it("returns null when nothing is configured", () => {
    expect(resolveVisionModelRef({ cfg: cfg() })).toBeNull();
  });

  it("skips cli-typed media model entries", () => {
    expect(
      resolveVisionModelRef({
        cfg: cfg({
          tools: { media: { image: { models: [{ type: "cli", command: "llava" }] } } },
        }),
      }),
    ).toBeNull();
  });
});

describe("planKeyframeTimestamps", () => {
  it("samples evenly across the clip when there are no scene cuts", () => {
    const plan = planKeyframeTimestamps({ durationSec: 20, sceneCuts: [], maxFrames: 4 });
    expect(plan.sampling).toBe("even");
    expect(plan.timestamps).toEqual([2.5, 7.5, 12.5, 17.5]);
  });

  it("samples just after each scene cut so the frame is in the new shot", () => {
    const plan = planKeyframeTimestamps({
      durationSec: 30,
      sceneCuts: [5, 12, 22],
      maxFrames: 4,
      sceneLeadInSec: 0.15,
    });
    expect(plan.sampling).toBe("scene-cuts");
    expect(plan.timestamps).toEqual([0.5, 5.15, 12.15, 22.15]);
  });

  it("tops a single-cut clip up to the frame cap with even samples", () => {
    const plan = planKeyframeTimestamps({ durationSec: 18, sceneCuts: [7.925], maxFrames: 4 });
    expect(plan.sampling).toBe("scene-cuts+even");
    expect(plan.timestamps).toHaveLength(4);
    expect(plan.timestamps).toContain(8.075);
    expect(plan.timestamps).toEqual(plan.timestamps.toSorted((a, b) => a - b));
  });

  it("never exceeds the frame cap even with many cuts", () => {
    const plan = planKeyframeTimestamps({
      durationSec: 60,
      sceneCuts: Array.from({ length: 40 }, (_v, i) => i + 1),
      maxFrames: 5,
    });
    expect(plan.timestamps).toHaveLength(5);
  });

  it("keeps every sample inside the clip", () => {
    const plan = planKeyframeTimestamps({ durationSec: 1, sceneCuts: [0.9], maxFrames: 6 });
    for (const timestamp of plan.timestamps) {
      expect(timestamp).toBeGreaterThanOrEqual(0);
      expect(timestamp).toBeLessThanOrEqual(0.95);
    }
  });

  it("falls back to one frame when the duration is unknown and there are no cuts", () => {
    const plan = planKeyframeTimestamps({ sceneCuts: [], maxFrames: 6 });
    expect(plan).toEqual({ timestamps: [0], sampling: "single-frame" });
  });

  it("uses cuts alone when the duration is unknown", () => {
    const plan = planKeyframeTimestamps({ sceneCuts: [3, 9], maxFrames: 6 });
    expect(plan).toEqual({ timestamps: [3.15, 9.15], sampling: "scene-cuts" });
  });
});

describe("formatVideoDescription", () => {
  it("keeps every observation timestamp in seconds and names the model source", () => {
    const text = formatVideoDescription({
      fileName: "clip.mp4",
      durationSec: 18.02,
      modelRef: { provider: "ollama", model: "qwen2.5vl:7b", source: "plugin config" },
      plannedFrames: 2,
      sampling: "scene-cuts+even",
      sceneCuts: [7.925],
      observations: [
        { timeSec: 0.5, text: "A white house." },
        { timeSec: 8.075, text: "A rider on a rail." },
      ],
      failures: [],
    });
    expect(text).toContain("clip.mp4 (18.02s)");
    expect(text).toContain("2/2 by ollama/qwen2.5vl:7b (model from plugin config");
    expect(text).toContain("Scene cuts at: 7.925s");
    expect(text).toContain("[t=0.5s | 00:00.500] A white house.");
    expect(text).toContain("[t=8.075s | 00:08.075] A rider on a rail.");
    expect(text).toContain("cut_clip {start_sec,end_sec}");
  });

  it("reports per-frame failures instead of hiding them", () => {
    const text = formatVideoDescription({
      fileName: "clip.mp4",
      modelRef: { provider: "ollama", model: "m", source: "s" },
      plannedFrames: 2,
      sampling: "even",
      sceneCuts: [],
      observations: [{ timeSec: 1, text: "ok" }],
      failures: [{ timeSec: 2, stage: "describe", reason: "connect ECONNREFUSED" }],
      budgetExhausted: true,
    });
    expect(text).toContain("1/2");
    expect(text).toContain("[t=2s] NOT DESCRIBED (describe failed): connect ECONNREFUSED");
    expect(text).toContain("time budget was exhausted");
  });
});

describe("trimNarrationText", () => {
  it("keeps segment line breaks, which carry the transcript's timing", () => {
    expect(trimNarrationText("  [t=1s] a \n\n  [t=2s] b  ", 0)).toBe("[t=1s] a\n[t=2s] b");
  });

  it("trims to the cap with an ellipsis rather than dropping whole segments", () => {
    expect(trimNarrationText("abcdefghij", 5)).toBe("abcd…");
  });

  it("collapses to empty for whitespace-only input so it can never pass as a transcript", () => {
    expect(trimNarrationText("  \n \r\n ", 0)).toBe("");
  });
});

describe("formatVideoDescription with narration", () => {
  const base = {
    fileName: "clip.mp4",
    durationSec: 18.02,
    modelRef: { provider: "ollama", model: "qwen2.5vl:7b", source: "plugin config" },
    plannedFrames: 1,
    sampling: "even" as const,
    sceneCuts: [],
    observations: [{ timeSec: 9, text: "A rider on a rail." }],
    failures: [],
  };

  it("puts the verbatim transcript before the inferred keyframe prose", () => {
    const text = formatVideoDescription({
      ...base,
      narration: {
        ok: true,
        text: "[t=8.53s | 00:08.530] Shift your weight back.",
        provider: "cli",
        model: "python",
      },
    });
    expect(text).toContain("Narration: transcribed by cli/python (verbatim, see SPOKEN below)");
    expect(text).toContain("SPOKEN (transcript, verbatim):");
    expect(text).toContain("[t=8.53s | 00:08.530] Shift your weight back.");
    expect(text).toContain("SEEN (keyframe descriptions, model-inferred):");
    expect(text.indexOf("SPOKEN")).toBeLessThan(text.indexOf("SEEN"));
    // Both blocks stay on the same timeline unit.
    expect(text).toContain("[t=9s | 00:09.000] A rider on a rail.");
  });

  it("names the narration failure in the header instead of omitting it silently", () => {
    const text = formatVideoDescription({
      ...base,
      narration: { ok: false, stage: "transcribe", reason: "no transcriber configured" },
    });
    expect(text).toContain(
      "Narration: NOT transcribed (transcribe failed): no transcriber configured",
    );
    expect(text).not.toContain("SPOKEN");
  });

  it("says nothing about narration when narration was not attempted", () => {
    expect(formatVideoDescription(base)).not.toContain("Narration");
  });
});

describe("createVideoUnderstandingProvider", () => {
  let before: Set<string>;

  beforeEach(() => {
    before = tempSnapshot();
  });

  afterEach(() => {
    for (const dir of trackedTempDirs(before)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("claims only the video capability and no credential", () => {
    const provider = createVideoUnderstandingProvider(fakeDeps())!;
    expect(provider.id).toBe("creative-engines");
    expect(provider.capabilities).toEqual(["video"]);
    expect(provider.describeVideo).toBeTypeOf("function");
    // No image/audio hooks: claiming image capability would graft the generic
    // model-backed image path onto this id (provider-registry.ts).
    expect(provider.describeImage).toBeUndefined();
    expect(provider.describeImages).toBeUndefined();
    expect(provider.transcribeAudio).toBeUndefined();
    expect(provider.resolveAuth?.({ provider: "creative-engines" })).toMatchObject({
      kind: "none",
    });
  });

  it("registers nothing when the plugin config disables it", () => {
    expect(
      createVideoUnderstandingProvider(fakeDeps({ pluginConfig: { enabled: false } })),
    ).toBeNull();
  });

  it("extracts a thumbnail per planned timestamp and preserves them in the result", async () => {
    const deps = fakeDeps();
    const provider = createVideoUnderstandingProvider(deps)!;
    const result = await provider.describeVideo!(videoRequest());

    expect(deps.applyCalls.map((call) => call.op)).toEqual(["thumbnail", "thumbnail", "thumbnail"]);
    expect(deps.applyCalls.map((call) => call.params.time_sec)).toEqual([2, 6, 10]);
    expect(deps.describeCalls).toHaveLength(3);
    expect(deps.describeCalls[0]).toMatchObject({ provider: "ollama", model: "qwen2.5vl:7b" });
    expect(result.text).toContain("[t=2s |");
    expect(result.text).toContain("[t=6s |");
    expect(result.text).toContain("[t=10s |");
    expect(result.model).toBe("ollama/qwen2.5vl:7b");
  });

  it("uses real scene cuts when detect_scenes returns them", async () => {
    const deps = fakeDeps({
      engine: { analyze: async () => ({ ok: true, data: { cuts: [4.5] } }) },
    });
    const provider = createVideoUnderstandingProvider(deps)!;
    const result = await provider.describeVideo!(videoRequest());
    expect(result.text).toContain("Scene cuts at: 4.5s");
    expect(deps.applyCalls.map((call) => call.params.time_sec)).toContain(4.65);
  });

  it("removes its temp working directory on success", async () => {
    const deps = fakeDeps();
    const provider = createVideoUnderstandingProvider(deps)!;
    await provider.describeVideo!(videoRequest());
    expect(trackedTempDirs(before)).toEqual([]);
    for (const call of deps.applyCalls) {
      expect(existsSync(call.output)).toBe(false);
    }
  });

  it("starts the engine before the availability gate, so it works standalone", async () => {
    // The engine `start()` is a gateway SERVICE, so in a standalone process the
    // library is unloaded until something asks. This double reproduces exactly
    // that: unavailable until ensureStarted() runs. If the provider checks
    // isAvailable() first, it throws "not loaded" on a healthy install.
    let started = false;
    const deps = fakeDeps({
      engine: {
        ensureStarted: async () => {
          started = true;
        },
        isAvailable: () => started,
        reason: () => (started ? undefined : "libomni_video_bridge not loaded yet"),
      },
    });
    const provider = createVideoUnderstandingProvider(deps)!;

    const result = await provider.describeVideo!(videoRequest());

    expect(started).toBe(true);
    expect(result.text.length).toBeGreaterThan(0);
  });

  it("fails with a named reason when the native video engine is not loaded", async () => {
    const provider = createVideoUnderstandingProvider(
      fakeDeps({
        engine: {
          isAvailable: () => false,
          reason: () => "libomni_video_bridge.dll not found",
        },
      }),
    )!;
    await expect(provider.describeVideo!(videoRequest())).rejects.toThrow(
      /native video engine .* is not loaded — libomni_video_bridge\.dll not found/,
    );
  });

  it("fails with a named reason when no vision model is configured", async () => {
    const provider = createVideoUnderstandingProvider(
      fakeDeps({ pluginConfig: {}, resolveConfig: () => cfg() }),
    )!;
    await expect(provider.describeVideo!(videoRequest())).rejects.toThrow(
      /no vision model is configured/,
    );
  });

  it("fails with a named reason when ffprobe cannot be run", async () => {
    const provider = createVideoUnderstandingProvider(
      fakeDeps({
        probeDuration: async () => {
          throw new Error("spawn ffprobe ENOENT");
        },
      }),
    )!;
    await expect(provider.describeVideo!(videoRequest())).rejects.toThrow(
      /ffprobe could not be run \(spawn ffprobe ENOENT\)/,
    );
  });

  it("fails rather than returning an empty description when every vision call fails", async () => {
    const deps = fakeDeps({
      describeImage: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
      },
    });
    const provider = createVideoUnderstandingProvider(deps)!;
    await expect(provider.describeVideo!(videoRequest())).rejects.toThrow(
      /described 0 of 3 keyframes .* connect ECONNREFUSED 127\.0\.0\.1:11434/s,
    );
    // and the temp dir is still gone
    expect(trackedTempDirs(before)).toEqual([]);
  });

  it("fails rather than succeeding when the vision model returns empty text", async () => {
    const provider = createVideoUnderstandingProvider(
      fakeDeps({ describeImage: async () => ({ text: "   " }) }),
    )!;
    await expect(provider.describeVideo!(videoRequest())).rejects.toThrow(/returned no text/);
  });

  it("fails when every thumbnail extraction fails", async () => {
    const provider = createVideoUnderstandingProvider(
      fakeDeps({ engine: { apply: async () => ({ ok: false, reason: "ffmpeg exited 1" }) } }),
    )!;
    await expect(provider.describeVideo!(videoRequest())).rejects.toThrow(
      /extract: ffmpeg exited 1/,
    );
  });

  it("rejects an empty thumbnail file instead of sending it to the vision model", async () => {
    const deps = fakeDeps({
      engine: {
        apply: async (_input, _op, output) => {
          const { writeFile } = await import("node:fs/promises");
          await writeFile(output, Buffer.alloc(0));
          return { ok: true };
        },
      },
    });
    const provider = createVideoUnderstandingProvider(deps)!;
    await expect(provider.describeVideo!(videoRequest())).rejects.toThrow(
      /thumbnail produced an empty file/,
    );
    expect(deps.describeCalls).toEqual([]);
  });

  it("keeps partial results and reports the frames that failed", async () => {
    let call = 0;
    const deps = fakeDeps({
      describeImage: async (params) => {
        call += 1;
        if (call === 2) {
          throw new Error("model timeout");
        }
        return { text: `frame ${call}`, model: params.model };
      },
    });
    const provider = createVideoUnderstandingProvider(deps)!;
    const result = await provider.describeVideo!(videoRequest());
    expect(result.text).toContain("2/3");
    expect(result.text).toContain("NOT DESCRIBED (describe failed): model timeout");
    expect(result.text).toContain("frame 1");
    expect(result.text).toContain("frame 3");
  });

  it("stops sampling once the host time budget is spent", async () => {
    const deps = fakeDeps({
      describeImage: async (params) => {
        // Burn most of the 5s budget on the first frame.
        vi.setSystemTime(Date.now() + 4_000);
        return { text: "slow frame", model: params.model };
      },
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const provider = createVideoUnderstandingProvider(deps)!;
      const result = await provider.describeVideo!(videoRequest({ timeoutMs: 5_000 }));
      expect(deps.describeCalls).toHaveLength(1);
      expect(result.text).toContain("1/3");
      expect(result.text).toContain("time budget was exhausted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still works when detect_scenes fails, falling back to even sampling", async () => {
    const deps = fakeDeps({
      engine: {
        analyze: async () => ({ ok: false, reason: "analysis only implemented for video" }),
      },
    });
    const provider = createVideoUnderstandingProvider(deps)!;
    const result = await provider.describeVideo!(videoRequest());
    expect(result.text).toContain("sampling: even");
    expect(deps.describeCalls).toHaveLength(3);
  });

  it("writes the request buffer to a real file for ffmpeg/ffprobe to seek", async () => {
    const seen: string[] = [];
    const deps = fakeDeps({
      probeDuration: async (path) => {
        seen.push(path);
        return 12;
      },
    });
    const provider = createVideoUnderstandingProvider(deps)!;
    await provider.describeVideo!(videoRequest({ fileName: "ride.mov", mime: "video/quicktime" }));
    expect(seen[0]).toMatch(/creative-engines-video-understanding-.*[\\/]source\.mov$/);
  });
});

/**
 * Narration fold-in.
 *
 * The transcript always arrives from the injected HOST seam, never from a
 * plugin-owned ASR path — these tests pin that, plus the rule that a missing or
 * empty transcript is REPORTED and never dressed up as content.
 */
describe("createVideoUnderstandingProvider narration", () => {
  let before: Set<string>;

  beforeEach(() => {
    before = tempSnapshot();
  });

  afterEach(() => {
    for (const dir of trackedTempDirs(before)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("demuxes with extract_audio and folds the host transcript into the same answer", async () => {
    const calls: Array<Parameters<NonNullable<VideoUnderstandingDeps["transcribeAudio"]>>[0]> = [];
    const deps = fakeDeps({
      transcribeAudio: async (params) => {
        calls.push(params);
        return {
          text: "[t=8.53s | 00:08.530] Shift your weight back.",
          provider: "cli",
          model: "python",
        };
      },
    });
    const provider = createVideoUnderstandingProvider(deps)!;
    const result = await provider.describeVideo!(videoRequest());

    // The engine op does the demux; the host does the model call.
    expect(deps.applyCalls.filter((call) => call.op === "extract_audio")).toHaveLength(1);
    expect(deps.applyCalls[0]?.output).toMatch(/narration\.wav$/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.filePath).toMatch(/narration\.wav$/);
    expect(calls[0]?.mime).toBe("audio/wav");
    expect(result.text).toContain("SPOKEN (transcript, verbatim):");
    expect(result.text).toContain("Shift your weight back.");
    expect(result.text).toContain("SEEN (keyframe descriptions, model-inferred):");
  });

  it("bounds the host audio timeout to its slice of the request budget, never raising the user's value", async () => {
    const seen: number[] = [];
    const deps = fakeDeps({
      resolveConfig: () => cfg({ tools: { media: { audio: { timeoutSeconds: 600 } } } }),
      pluginConfig: { visionModel: "ollama/qwen2.5vl:7b", maxFrames: 1 },
      transcribeAudio: async (params) => {
        seen.push(params.cfg.tools?.media?.audio?.timeoutSeconds as number);
        return { text: "spoken" };
      },
    });
    const provider = createVideoUnderstandingProvider(deps)!;
    await provider.describeVideo!(videoRequest({ timeoutMs: 100_000 }));
    // 40% of the ~100s budget, and well below the configured 600s.
    expect(seen[0]).toBeGreaterThan(30);
    expect(seen[0]).toBeLessThanOrEqual(40);
  });

  it("attempts nothing and claims nothing when the host exposes no audio pipeline", async () => {
    const deps = fakeDeps();
    const provider = createVideoUnderstandingProvider(deps)!;
    const result = await provider.describeVideo!(videoRequest());
    expect(deps.applyCalls.some((call) => call.op === "extract_audio")).toBe(false);
    expect(result.text).not.toContain("Narration");
  });

  it("attempts nothing when the plugin config opts out", async () => {
    const transcribeAudio = vi.fn(async () => ({ text: "should never run" }));
    const deps = fakeDeps({
      transcribeAudio,
      pluginConfig: {
        visionModel: "ollama/qwen2.5vl:7b",
        maxFrames: 1,
        transcribeNarration: false,
      },
    });
    const provider = createVideoUnderstandingProvider(deps)!;
    const result = await provider.describeVideo!(videoRequest());
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(deps.applyCalls.some((call) => call.op === "extract_audio")).toBe(false);
    expect(result.text).not.toContain("Narration");
  });

  it("reports an empty transcript as a named failure and never as content", async () => {
    const deps = fakeDeps({
      transcribeAudio: async () => ({
        text: "   ",
        decision: {
          outcome: "skipped",
          attachments: [{ attempts: [{ outcome: "skipped", reason: "empty output" }] }],
        },
      }),
    });
    const provider = createVideoUnderstandingProvider(deps)!;
    const result = await provider.describeVideo!(videoRequest());
    expect(result.text).toContain("Narration: NOT transcribed (transcribe failed):");
    expect(result.text).toContain("returned no transcript");
    expect(result.text).toContain("empty output");
    expect(result.text).toContain("tools.media.audio.models[]");
    expect(result.text).not.toContain("SPOKEN");
  });

  it("reports a transcriber error without losing the keyframe description", async () => {
    const deps = fakeDeps({
      transcribeAudio: async () => {
        throw new Error("spawn whisper ENOENT");
      },
    });
    const provider = createVideoUnderstandingProvider(deps)!;
    const result = await provider.describeVideo!(videoRequest());
    expect(result.text).toContain(
      "Narration: NOT transcribed (transcribe failed): spawn whisper ENOENT",
    );
    expect(result.text).toContain("SEEN (keyframe descriptions, model-inferred):");
  });

  it("reports a container with no audio track instead of inventing speech", async () => {
    const deps = fakeDeps({
      engine: {
        apply: async (_input, op, output) => {
          const { writeFile } = await import("node:fs/promises");
          // extract_audio "succeeds" writing nothing, exactly as ffmpeg does for
          // a video-only container.
          await writeFile(output, op === "extract_audio" ? Buffer.alloc(0) : Buffer.alloc(64, 7));
          return { ok: true };
        },
      },
      transcribeAudio: async () => ({ text: "should never be reached" }),
    });
    const provider = createVideoUnderstandingProvider(deps)!;
    const result = await provider.describeVideo!(videoRequest());
    expect(result.text).toContain("Narration: NOT transcribed (extract failed)");
    expect(result.text).toContain("no audio track");
    expect(result.text).not.toContain("should never be reached");
  });

  it("reports an extract_audio failure without failing the whole description", async () => {
    const deps = fakeDeps({
      engine: {
        apply: async (_input, op, output) => {
          if (op === "extract_audio") {
            return { ok: false, reason: "ffmpeg exited 1" };
          }
          const { writeFile } = await import("node:fs/promises");
          await writeFile(output, Buffer.alloc(64, 7));
          return { ok: true };
        },
      },
      transcribeAudio: async () => ({ text: "unreachable" }),
    });
    const provider = createVideoUnderstandingProvider(deps)!;
    const result = await provider.describeVideo!(videoRequest());
    expect(result.text).toContain("Narration: NOT transcribed (extract failed): ffmpeg exited 1");
  });

  it("returns a transcript-only answer when every vision call fails, instead of throwing", async () => {
    const deps = fakeDeps({
      describeImage: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
      },
      transcribeAudio: async () => ({ text: "Shift your weight back.", provider: "cli" }),
    });
    const provider = createVideoUnderstandingProvider(deps)!;
    const result = await provider.describeVideo!(videoRequest());
    expect(result.text).toContain("Keyframes described: 0/3");
    expect(result.text).toContain("Shift your weight back.");
    expect(result.text).toContain("NOT DESCRIBED (describe failed): connect ECONNREFUSED");
    expect(result.text).not.toContain("SEEN (keyframe");
  });

  it("throws naming BOTH failures when neither speech nor vision produced anything", async () => {
    const deps = fakeDeps({
      describeImage: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
      },
      transcribeAudio: async () => {
        throw new Error("spawn whisper ENOENT");
      },
    });
    const provider = createVideoUnderstandingProvider(deps)!;
    await expect(provider.describeVideo!(videoRequest())).rejects.toThrow(
      /described 0 of 3 keyframes[\s\S]*ECONNREFUSED[\s\S]*narration transcribe failed: spawn whisper ENOENT/,
    );
  });

  it("skips narration when too little of the budget is left, and says so", async () => {
    const transcribeAudio = vi.fn(async () => ({ text: "never" }));
    const deps = fakeDeps({ transcribeAudio });
    const provider = createVideoUnderstandingProvider(deps)!;
    // 40% of 10s is 4s, below the 5s narration floor.
    const result = await provider.describeVideo!(videoRequest({ timeoutMs: 10_000 }));
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(result.text).toContain("of the media-understanding budget remained");
    expect(result.text).toContain("tools.media.video.timeoutSeconds");
  });

  it("removes the demuxed WAV along with the rest of its temp dir", async () => {
    let wavPath = "";
    const deps = fakeDeps({
      transcribeAudio: async (params) => {
        wavPath = params.filePath;
        expect(existsSync(wavPath)).toBe(true);
        return { text: "spoken" };
      },
    });
    const provider = createVideoUnderstandingProvider(deps)!;
    await provider.describeVideo!(videoRequest());
    expect(wavPath).toMatch(/narration\.wav$/);
    expect(existsSync(wavPath)).toBe(false);
    expect(trackedTempDirs(before)).toEqual([]);
  });
});

describe("temp-dir hygiene helper", () => {
  it("does not report unrelated temp dirs", () => {
    const dir = mkdtempSync(join(tmpdir(), "unrelated-"));
    try {
      expect(trackedTempDirs(tempSnapshot())).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
