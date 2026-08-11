/**
 * REAL end-to-end AUDIO perception — real native video engine, real ffmpeg, real
 * local transcriber, real narrated video. No mocks on the audio path.
 *
 * WHAT IT PROVES
 * --------------
 *   1. The HOST's CLI audio seam transcribes a real WAV with nothing but
 *      `tools.media.audio.models[{ type: "cli", … }]` config — no plugin code and
 *      no API key (`transcribeAudioFile`, src/media-understanding/runtime.ts:354).
 *   2. `describeVideo` folds that transcript into its timestamped answer after
 *      demuxing the track with the engine's own `extract_audio` op.
 *   3. A transcriber that is not installed produces a NAMED failure line, never a
 *      fabricated or empty transcript.
 *   4. `detect_silence` returns real silent-segment timestamps.
 *   5. The demuxed WAV and every other temp artefact are removed.
 *
 * ENV GATES — every one of them skips cleanly instead of failing:
 *   CREATIVE_ENGINES_ASR_LIVE=1        explicit opt-in (REQUIRED). Without it this
 *                                      file always skips, because a single run
 *                                      costs minutes of host cold start (see the
 *                                      cold-start warning below) and would
 *                                      otherwise ambush anyone running the lane.
 *   CREATIVE_ENGINES_VIDEO_FIXTURE     any video file (REQUIRED to run anything)
 *   CREATIVE_ENGINES_NARRATED_FIXTURE  a video the operator DECLARES has speech.
 *                                      Only the transcript-CONTENT assertions
 *                                      need it, and they skip without it. A
 *                                      speechless clip must not be asserted to
 *                                      produce words — that is how a test starts
 *                                      demanding a fabricated transcript.
 *   CREATIVE_ENGINES_ASR_COMMAND       transcriber binary, default `python`
 *   CREATIVE_ENGINES_ASR_SCRIPT        default: ../../scripts/faster-whisper-cli.py
 *   CREATIVE_ENGINES_WHISPER_MODEL     faster-whisper model size, default `base`
 *   CREATIVE_ENGINES_FFMPEG_DIR        ffmpeg/ffprobe directory, default: PATH
 *
 * Example (PowerShell):
 *   $env:CREATIVE_ENGINES_NARRATED_FIXTURE="C:\path\to\a\narrated-clip.mp4"
 *   node scripts/run-vitest.mjs run --config test/vitest/vitest.extensions.config.ts `
 *     extensions/creative-engines/src/media/audio-narration.integration.test.ts
 *
 * COLD-START WARNING (measured, not theoretical)
 * ----------------------------------------------
 * The first host media call in a fresh worker spends MINUTES inside
 * `buildProviderRegistry` -> `resolvePluginCapabilityProviders`
 * (src/media-understanding/provider-registry.ts:57), which resolves every
 * plugin's media-understanding capability. Measured on the verification machine:
 * 351s for that one call in a standalone transformed-TS process, ~345s for the
 * first `transcribeAudioFile` under vitest, versus ~5s for the next call in the
 * same process. The transcription itself is ~1.5s on GPU / ~5s on CPU for a 19s
 * clip, so this is provider-graph resolution, not ASR.
 *
 * This is HOST-side and pre-existing: `describeImageFileWithModel` — the seam the
 * keyframe path already uses — builds the same registry. It is why this file is
 * opt-in: `scripts/run-vitest.mjs` terminates a run with no output for long
 * enough, and a cold run here trips it. Run it directly through vitest when
 * verifying, or expect to re-run.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { transcribeAudioFile } from "openclaw/plugin-sdk/media-understanding-runtime";
import { afterAll, describe, expect, it } from "vitest";
import { probeDurationSec } from "../ffi/codec.ts";
import { resolveBinaryPath } from "../ffi/loader.ts";
import { VideoEngineRuntime } from "../runtime/video.ts";
import { createVideoUnderstandingProvider } from "./video-understanding.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ASR_SCRIPT = resolve(HERE, "..", "..", "scripts", "faster-whisper-cli.py");

const FIXTURE = process.env.CREATIVE_ENGINES_VIDEO_FIXTURE?.trim();
const NARRATED_RAW = process.env.CREATIVE_ENGINES_NARRATED_FIXTURE?.trim();
const NARRATED = NARRATED_RAW && existsSync(NARRATED_RAW) ? NARRATED_RAW : undefined;
const ASR_COMMAND = process.env.CREATIVE_ENGINES_ASR_COMMAND?.trim() || "python";
const ASR_SCRIPT = process.env.CREATIVE_ENGINES_ASR_SCRIPT?.trim() || DEFAULT_ASR_SCRIPT;
const WHISPER_MODEL = process.env.CREATIVE_ENGINES_WHISPER_MODEL?.trim() || "base";
const FFMPEG_DIR = process.env.CREATIVE_ENGINES_FFMPEG_DIR?.trim();
const CODEC = FFMPEG_DIR ? { ffmpegPath: FFMPEG_DIR } : undefined;

const TEMP_PREFIX = "creative-engines-video-understanding-";

/** ASR args for the host CLI entry. `{{MediaPath}}` is templated by the host. */
const ASR_ARGS = [ASR_SCRIPT, "--model", WHISPER_MODEL, "--language", "en", "{{MediaPath}}"];

function ffprobeRunnable(): boolean {
  const bin = FFMPEG_DIR ? join(FFMPEG_DIR, "ffprobe") : "ffprobe";
  const result = spawnSync(bin, ["-version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

/**
 * Probe the transcriber the same way an operator would: run it with `--help`.
 * This deliberately does NOT import faster-whisper or inspect a model cache —
 * anything that answers `--help` and prints a transcript on stdout works here.
 */
function asrRunnable(): boolean {
  if (!existsSync(ASR_SCRIPT)) {
    return false;
  }
  const result = spawnSync(ASR_COMMAND, [ASR_SCRIPT, "--help"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

function missingPrerequisites(): string[] {
  const missing: string[] = [];
  if (process.env.CREATIVE_ENGINES_ASR_LIVE?.trim() !== "1") {
    missing.push("CREATIVE_ENGINES_ASR_LIVE is not 1 (opt-in; a cold run costs minutes)");
  }
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
  if (!asrRunnable()) {
    missing.push(`transcriber not runnable: ${ASR_COMMAND} ${ASR_SCRIPT} --help`);
  }
  return missing;
}

const MISSING = missingPrerequisites();
const READY = MISSING.length === 0;
const NARRATION_READY = READY && Boolean(NARRATED);

if (!READY) {
  // eslint-disable-next-line no-console
  console.log(`[audio-narration.integration] skipping: ${MISSING.join("; ")}`);
} else if (!NARRATION_READY) {
  // eslint-disable-next-line no-console
  console.log(
    "[audio-narration.integration] transcript-content checks skipped: " +
      "set CREATIVE_ENGINES_NARRATED_FIXTURE to a clip that contains speech",
  );
}

/**
 * Config with ONLY a local CLI audio entry — no API key, no provider registry
 * entry, nothing but the command. This is the whole point of the test: the host
 * already supports local transcription through configuration alone.
 *
 * `maxBytes` is raised because `extract_audio` writes 44.1 kHz STEREO
 * (`dispatch.ts` `-ar 44100 -ac 2`), i.e. ~176 kB/s, and the host's audio default
 * is 20 MB — about 113 seconds of demuxed audio.
 */
function audioCliConfig(command: string, args: string[]): OpenClawConfig {
  return {
    tools: {
      media: {
        audio: {
          enabled: true,
          timeoutSeconds: 600,
          maxBytes: 256 * 1024 * 1024,
          models: [{ type: "cli", command, args }],
        },
        video: { enabled: true, maxChars: 20_000, timeoutSeconds: 900 },
      },
    },
  } as unknown as OpenClawConfig;
}

const engine = new VideoEngineRuntime({}, CODEC);
let started = false;

async function ensureEngine(): Promise<VideoEngineRuntime> {
  if (!started) {
    await engine.start();
    started = true;
  }
  return engine;
}

afterAll(async () => {
  if (started) {
    await engine.shutdown();
  }
});

/** A stub vision seam. The narration path is what is under test here. */
const stubDescribeImage = async (params: { model: string }) => ({
  text: "STUB VISION OUTPUT (this test exercises the audio path, not the vision path)",
  model: params.model,
});

describe.skipIf(!READY)("creative-engines audio perception (live)", () => {
  it(
    "demuxes a real WAV with the engine and reaches the HOST's CLI audio seam with config alone",
    async () => {
      const video = await ensureEngine();
      const workDir = await mkdtemp(join(tmpdir(), "creative-engines-asr-live-"));
      try {
        const wavPath = join(workDir, "narration.wav");
        const extracted = await video.apply(FIXTURE!, "extract_audio", wavPath, {});
        expect(extracted.ok).toBe(true);
        const bytes = (await stat(wavPath)).size;
        expect(bytes).toBeGreaterThan(1024);

        const result = await transcribeAudioFile({
          filePath: wavPath,
          cfg: audioCliConfig(ASR_COMMAND, ASR_ARGS),
          mime: "audio/wav",
        });

        // eslint-disable-next-line no-console
        console.log(
          `[audio-narration.integration] ${basename(FIXTURE!)} transcript: ${JSON.stringify(result.text)}`,
        );

        const text = (result.text ?? "").trim();
        if (text) {
          // The clip had speech: the transcript must come from the CLI entry.
          expect(result.provider).toBe("cli");
          expect(result.model).toBe(ASR_COMMAND);
          expect(text).not.toMatch(/^(?:n\/a|unknown|no transcript|error)$/iu);
        } else {
          // The clip had no speech. That is a legitimate outcome and the host must
          // record it as an empty-output SKIP, never as a successful transcript.
          expect(result.decision?.outcome).not.toBe("success");
          const attempts = result.decision?.attachments?.flatMap((a) => a.attempts ?? []) ?? [];
          expect(attempts.length).toBeGreaterThan(0);
          expect(attempts.every((attempt) => attempt.outcome !== "success")).toBe(true);
        }
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    900_000,
  );

  it.skipIf(!NARRATION_READY)(
    "folds the real transcript into describeVideo with timestamps inside the clip",
    async () => {
      const video = await ensureEngine();
      const cfg = audioCliConfig(ASR_COMMAND, ASR_ARGS);
      const durationSec = await probeDurationSec(NARRATED!, CODEC);
      expect(durationSec).toBeGreaterThan(0);

      const provider = createVideoUnderstandingProvider({
        videoEngine: video,
        ...(CODEC ? { codec: CODEC } : {}),
        resolveConfig: () => cfg,
        describeImage: stubDescribeImage,
        transcribeAudio: (params) => transcribeAudioFile(params),
        pluginConfig: { visionModel: "ollama/stub-vision", maxFrames: 1 },
      })!;

      const before = new Set(
        readdirSync(tmpdir()).filter((entry) => entry.startsWith(TEMP_PREFIX)),
      );

      const result = await provider.describeVideo!({
        buffer: await readFile(NARRATED!),
        fileName: basename(NARRATED!),
        mime: "video/mp4",
        apiKey: "openclaw-local-no-auth",
        auth: { kind: "none", source: "live test" },
        timeoutMs: 900_000,
      });

      // eslint-disable-next-line no-console
      console.log(`[audio-narration.integration] describeVideo result:\n${result.text}`);

      expect(result.text).toContain("Narration: transcribed by cli");
      expect(result.text).toContain("SPOKEN (transcript, verbatim):");
      expect(result.text).toContain("SEEN (keyframe descriptions, model-inferred):");
      // The transcript block precedes the inferred keyframe prose.
      expect(result.text.indexOf("SPOKEN")).toBeLessThan(result.text.indexOf("SEEN"));

      // Every transcript timestamp is a real offset inside the clip, i.e. usable
      // straight away as `video.apply cut_clip {start_sec,end_sec}`.
      const spoken = result.text.split("SPOKEN (transcript, verbatim):")[1]?.split("SEEN")[0] ?? "";
      const stamps = [...spoken.matchAll(/\[t=([\d.]+)s \|/gu)].map((match) => Number(match[1]));
      expect(stamps.length).toBeGreaterThan(0);
      for (const stamp of stamps) {
        expect(stamp).toBeGreaterThanOrEqual(0);
        expect(stamp).toBeLessThanOrEqual(durationSec! + 1);
      }
      expect(stamps).toEqual(stamps.toSorted((a, b) => a - b));

      // Temp dir, including the demuxed WAV, is gone.
      const after = readdirSync(tmpdir()).filter(
        (entry) => entry.startsWith(TEMP_PREFIX) && !before.has(entry),
      );
      expect(after).toEqual([]);
    },
    900_000,
  );

  it(
    "names the missing transcriber instead of fabricating narration",
    async () => {
      const video = await ensureEngine();
      // A command that cannot exist: the WAV is real, the transcription cannot
      // happen, and the output must say so.
      const cfg = audioCliConfig("openclaw-no-such-transcriber-binary", ["{{MediaPath}}"]);
      const provider = createVideoUnderstandingProvider({
        videoEngine: video,
        ...(CODEC ? { codec: CODEC } : {}),
        resolveConfig: () => cfg,
        describeImage: stubDescribeImage,
        transcribeAudio: (params) => transcribeAudioFile(params),
        pluginConfig: { visionModel: "ollama/stub-vision", maxFrames: 1 },
      })!;

      const result = await provider.describeVideo!({
        buffer: await readFile(FIXTURE!),
        fileName: basename(FIXTURE!),
        mime: "video/mp4",
        apiKey: "openclaw-local-no-auth",
        timeoutMs: 300_000,
      });

      expect(result.text).toContain("Narration: NOT transcribed");
      expect(result.text).not.toContain("SPOKEN");
      // The keyframe half of the answer is unaffected.
      expect(result.text).toContain("SEEN (keyframe descriptions, model-inferred):");
    },
    600_000,
  );

  it(
    "detect_silence returns real silent-segment timestamps inside the clip",
    async () => {
      const video = await ensureEngine();
      const durationSec = (await probeDurationSec(FIXTURE!, CODEC)) ?? 0;
      const result = await video.analyze(FIXTURE!, "detect_silence", {
        noise_db: -40,
        min_duration: 0.5,
      });

      // eslint-disable-next-line no-console
      console.log(`[audio-narration.integration] detect_silence: ${JSON.stringify(result.data)}`);

      expect(result.ok).toBe(true);
      const segments = (result.data as { segments?: Array<{ start: number; end: number | null }> })
        .segments;
      expect(Array.isArray(segments)).toBe(true);
      for (const segment of segments ?? []) {
        expect(Number.isFinite(segment.start)).toBe(true);
        expect(segment.start).toBeGreaterThanOrEqual(0);
        expect(segment.start).toBeLessThanOrEqual(durationSec + 1);
        if (segment.end !== null) {
          expect(segment.end).toBeGreaterThan(segment.start);
          expect(segment.end).toBeLessThanOrEqual(durationSec + 1);
        }
      }
    },
    300_000,
  );
});
