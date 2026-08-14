import { spawnSync } from "node:child_process";
/**
 * REAL end-to-end keyframe video understanding — real native video engine, real
 * ffmpeg/ffprobe, real local vision model over Ollama, real video file.
 * No mocks.
 *
 * This is the counterpart to `video-understanding.test.ts`, which pins the
 * contract with fake seams. This one pins the WORKING path, and is env-gated on
 * every piece it needs so it skips cleanly (never fails) on a machine that lacks
 * one:
 *
 *   CREATIVE_ENGINES_VIDEO_FIXTURE  path to a real video file (REQUIRED to run)
 *   CREATIVE_ENGINES_VISION_MODEL   Ollama vision model tag, default qwen2.5vl:7b
 *   CREATIVE_ENGINES_FFMPEG_DIR     ffmpeg/ffprobe directory, default: PATH
 *   OLLAMA_BASE_URL                 default http://127.0.0.1:11434
 *
 * Example (PowerShell):
 *   $env:CREATIVE_ENGINES_VIDEO_FIXTURE="D:\clips\ride.mp4"
 *   node scripts/run-vitest.mjs run --config test/vitest/vitest.extensions.config.ts `
 *     extensions/creative-engines/src/media/video-understanding.live.test.ts
 *
 * What it proves:
 *   1. Keyframes are extracted at REAL timestamps derived from the real clip
 *      duration and real `detect_scenes` output.
 *   2. Each keyframe is described by the LOCAL vision model through the host's
 *      `describeImageFileWithModel`, not by a plugin-owned HTTP client.
 *   3. The aggregated result keeps every observation's timestamp in seconds, so
 *      the orchestrator can turn "at Ns …" into a `cut_clip` / `thumbnail` call.
 *   4. The temp working directory is removed.
 */
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describeImageFileWithModel } from "openclaw/plugin-sdk/media-understanding-runtime";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBinaryPath } from "../ffi/loader.ts";
import { VideoEngineRuntime } from "../runtime/video.ts";
import { createVideoUnderstandingProvider } from "./video-understanding.ts";

const FIXTURE = process.env.CREATIVE_ENGINES_VIDEO_FIXTURE?.trim();
const VISION_MODEL = process.env.CREATIVE_ENGINES_VISION_MODEL?.trim() || "qwen2.5vl:7b";
const FFMPEG_DIR = process.env.CREATIVE_ENGINES_FFMPEG_DIR?.trim();
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434";
const CODEC = FFMPEG_DIR ? { ffmpegPath: FFMPEG_DIR } : undefined;

const TEMP_PREFIX = "creative-engines-video-understanding-";

function ffprobeRunnable(): boolean {
  const bin = FFMPEG_DIR ? join(FFMPEG_DIR, "ffprobe") : "ffprobe";
  const result = spawnSync(bin, ["-version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

/**
 * Ollama readiness, with the REASON preserved.
 *
 * This used to collapse every outcome into `false`, so a transport failure
 * (Ollama busy loading another model, connection reset while the rest of the
 * lane hammers it) printed the same "has no model X" line as a genuinely
 * unpulled model. A suite that skips for a reason that is not true is worse than
 * one that fails: it was observed skipping inside the full lane while passing
 * when run alone, and the lane still reported a green 26 files / 276 tests.
 */
async function ollamaModelStatus(
  model: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let response: Response;
  try {
    response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
  } catch (err) {
    return {
      ok: false,
      reason: `Ollama at ${OLLAMA_BASE_URL} could not be queried (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: `Ollama at ${OLLAMA_BASE_URL} answered /api/tags with HTTP ${response.status}`,
    };
  }
  const body = (await response.json()) as { models?: Array<{ name?: string }> };
  const names = (body.models ?? []).map((entry) => entry.name).filter(Boolean);
  if (names.includes(model)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `Ollama at ${OLLAMA_BASE_URL} has no model "${model}" (it lists ${names.length}: ${names.slice(0, 8).join(", ")})`,
  };
}

function missingPrerequisites(): string[] {
  const missing: string[] = [];
  if (!FIXTURE) {
    missing.push("CREATIVE_ENGINES_VIDEO_FIXTURE not set");
  } else if (!existsSync(FIXTURE)) {
    missing.push(`fixture not found: ${FIXTURE}`);
  }
  if (!resolveBinaryPath("omni_video_bridge")) {
    missing.push("omni_video_bridge not provisioned (see binaries/README.md)");
  }
  if (!ffprobeRunnable()) {
    missing.push("ffprobe not runnable");
  }
  return missing;
}

const MISSING = missingPrerequisites();
if (MISSING.length === 0) {
  const status = await ollamaModelStatus(VISION_MODEL);
  if (!status.ok) {
    MISSING.push(status.reason);
  }
}
const READY = MISSING.length === 0;

if (!READY) {
  // eslint-disable-next-line no-console
  console.log(`[video-understanding.live] skipping: ${MISSING.join("; ")}`);
}

/**
 * Config with the local Ollama provider declared explicitly.
 *
 * An explicit `models` list is used rather than relying on live discovery: the
 * host only auto-discovers Ollama models when `models.providers.ollama` carries
 * a meaningful signal (see `extensions/ollama/src/discovery-shared.ts`
 * `resolveOllamaDiscoveryResult`), and ambient discovery is deliberately skipped
 * under VITEST. Declaring the one model keeps this test hermetic apart from the
 * Ollama server itself.
 */
function liveConfig(): OpenClawConfig {
  return {
    models: {
      providers: {
        ollama: {
          api: "ollama",
          baseUrl: OLLAMA_BASE_URL,
          apiKey: "ollama-local",
          models: [
            {
              id: VISION_MODEL,
              name: VISION_MODEL,
              reasoning: false,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32768,
              maxTokens: 1024,
            },
          ],
        },
      },
    },
    tools: {
      media: {
        video: {
          enabled: true,
          maxChars: 8000,
          timeoutSeconds: 900,
          models: [
            { type: "provider", provider: "creative-engines", model: `ollama/${VISION_MODEL}` },
          ],
        },
      },
    },
  } as unknown as OpenClawConfig;
}

const engine = new VideoEngineRuntime({}, CODEC);
let started = false;

/**
 * Wire the provider's progress log to stdout.
 *
 * Real local vision inference on a keyframe takes minutes. Without output this
 * suite is silent for its whole duration, and `scripts/run-vitest.mjs` SIGKILLs
 * a run that goes quiet for longer than its watchdog window — which killed
 * healthy runs of this lane (measured: 3/3 runs killed at ~137s, exit 1, no
 * Vitest summary, `afterAll` cleanup skipped). The progress is also the only way
 * to see which keyframe a slow call is on.
 */
const progressLogger = {
  debug: (message: string) => {
    // eslint-disable-next-line no-console
    console.log(`[video-understanding.live] ${message}`);
  },
  warn: (message: string) => {
    // eslint-disable-next-line no-console
    console.warn(`[video-understanding.live] ${message}`);
  },
};

/**
 * Heartbeat for the stretch INSIDE a single model call, where the provider has
 * nothing new to report yet. Returns a stop function.
 */
function startHeartbeat(label: string): () => void {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    progressLogger.debug(
      `${label} still running after ${Math.round((Date.now() - startedAt) / 1000)}s`,
    );
  }, 30_000);
  timer.unref?.();
  return () => {
    clearInterval(timer);
  };
}

afterAll(async () => {
  if (started) {
    await engine.shutdown();
  }
});

describe.skipIf(!READY)("creative-engines describeVideo (live)", () => {
  it("extracts real keyframes and describes them with the local vision model, timestamps intact", async () => {
    await engine.start();
    started = true;
    expect(engine.isAvailable()).toBe(true);

    const cfg = liveConfig();
    const provider = createVideoUnderstandingProvider({
      videoEngine: engine,
      ...(CODEC ? { codec: CODEC } : {}),
      resolveConfig: () => cfg,
      describeImage: (params) => describeImageFileWithModel(params),
      logger: progressLogger,
      pluginConfig: { maxFrames: 3, frameTimeoutMs: 600_000 },
    })!;

    const before = new Set(readdirSync(tmpdir()).filter((entry) => entry.startsWith(TEMP_PREFIX)));

    const stopHeartbeat = startHeartbeat("describeVideo");
    let result: Awaited<ReturnType<NonNullable<typeof provider.describeVideo>>>;
    try {
      result = await provider.describeVideo!({
        buffer: await readFile(FIXTURE!),
        fileName: basename(FIXTURE!),
        mime: "video/mp4",
        apiKey: "openclaw-local-no-auth",
        auth: { kind: "none", source: "live test" },
        model: `ollama/${VISION_MODEL}`,
        timeoutMs: 900_000,
      });
    } finally {
      stopHeartbeat();
    }

    // eslint-disable-next-line no-console
    console.log(`[video-understanding.live] result:\n${result.text}`);

    expect(result.model).toContain(VISION_MODEL);
    expect(result.text).toContain(basename(FIXTURE!));
    expect(result.text).toContain(`by ollama/${VISION_MODEL}`);

    // Real timestamped observations, each with real model prose behind it.
    const observations = [...result.text.matchAll(/^\[t=([\d.]+)s \| [\d:.]+\] (.+)$/gmu)];
    expect(observations.length).toBeGreaterThanOrEqual(2);
    const seconds = observations.map((match) => Number(match[1]));
    expect(seconds).toEqual(seconds.toSorted((a, b) => a - b));
    expect(new Set(seconds).size).toBe(seconds.length);
    for (const match of observations) {
      // A real description, not a placeholder.
      const text = match[2]!;
      expect(text.length).toBeGreaterThan(40);
      expect(text).not.toMatch(/^(?:n\/a|unknown|no description)$/iu);
    }

    // Timestamps are inside the clip and directly usable as engine params.
    const duration = Number(/\((\d+(?:\.\d+)?)s\)/u.exec(result.text)?.[1] ?? Number.NaN);
    expect(Number.isFinite(duration)).toBe(true);
    for (const second of seconds) {
      expect(second).toBeGreaterThanOrEqual(0);
      expect(second).toBeLessThan(duration);
    }
    expect(result.text).toContain("cut_clip {start_sec,end_sec}");

    // Temp frames cleaned up.
    const after = readdirSync(tmpdir()).filter(
      (entry) => entry.startsWith(TEMP_PREFIX) && !before.has(entry),
    );
    expect(after).toEqual([]);
  }, 900_000);

  it("fails explicitly instead of fabricating a description when the vision endpoint is unreachable", async () => {
    await engine.start();
    started = true;
    const cfg = liveConfig();
    // Point the provider at a closed port: the frames are still real, the
    // vision call cannot succeed, and the provider must throw naming it.
    const unreachable = structuredClone(cfg);
    (unreachable.models!.providers as Record<string, { baseUrl: string }>).ollama.baseUrl =
      "http://127.0.0.1:1";
    const provider = createVideoUnderstandingProvider({
      videoEngine: engine,
      ...(CODEC ? { codec: CODEC } : {}),
      resolveConfig: () => unreachable,
      describeImage: (params) => describeImageFileWithModel(params),
      logger: progressLogger,
      pluginConfig: { maxFrames: 2, frameTimeoutMs: 20_000 },
    })!;

    const stopHeartbeat = startHeartbeat("describeVideo (unreachable endpoint)");
    try {
      await expect(
        provider.describeVideo!({
          buffer: await readFile(FIXTURE!),
          fileName: basename(FIXTURE!),
          mime: "video/mp4",
          apiKey: "openclaw-local-no-auth",
          model: `ollama/${VISION_MODEL}`,
          timeoutMs: 120_000,
        }),
      ).rejects.toThrow(/described 0 of \d+ keyframes/u);
    } finally {
      stopHeartbeat();
    }
  }, 300_000);
});
