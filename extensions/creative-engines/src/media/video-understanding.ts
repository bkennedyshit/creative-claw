/**
 * REAL video understanding for creative-engines.
 *
 * WHAT THIS IS
 * ------------
 * A `MediaUnderstandingProvider.describeVideo` implementation
 * (host contract: `src/media-understanding/types.ts:247-267`) that gives a
 * text-only orchestrator model eyes on a video by:
 *
 *   1. probing the container duration with ffprobe (`format=duration`),
 *   2. asking the native video engine for scene-cut timestamps
 *      (`detect_scenes`, an `analysis` op — see `EngineRuntime.analyze`),
 *   3. extracting real keyframes at those timestamps with the engine's
 *      `thumbnail` op (`P.float("time_sec")`),
 *   4. describing each keyframe through the HOST's configured vision model via
 *      `describeImageFileWithModel` (`src/media-understanding/runtime.ts:229`),
 *      so the user's provider registry, auth, base URL, and timeouts apply, and
 *   5. aggregating the per-frame answers with THE TIMESTAMP OF EACH OBSERVATION
 *      preserved, in seconds, which is the same unit `video.apply cut_clip`
 *      (`start_sec` / `end_sec`) and `thumbnail` (`time_sec`) take. The
 *      timestamp linkage is the point: "at 7.9s the rider hits the rail" is
 *      directly actionable as an engine command.
 *
 * NARRATION (SPOKEN CONTENT)
 * --------------------------
 * When the host has an audio-transcription path configured, the clip's SPOKEN
 * content is folded into the same answer: the engine's `extract_audio` op demuxes
 * a WAV and the HOST's `transcribeAudioFile`
 * (`src/media-understanding/runtime.ts:354`) transcribes it through whatever the
 * user configured under `tools.media.audio.models[]` — a local CLI transcriber,
 * a hosted provider, anything. The split of responsibility is identical to the
 * keyframe path: the ENGINE does the mechanical media work, the HOST owns the
 * model call, and this module owns neither an ASR implementation nor an HTTP
 * client.
 *
 * They are folded into ONE result rather than left separate because a keyframe
 * and the sentence spoken over it are the same moment on the same timeline, and
 * the orchestrator is choosing cut points on that one timeline. For instructional
 * footage the narration usually carries the intent ("now shift your weight back")
 * that no still frame shows. The two blocks stay separately labelled so an
 * inferred visual description is never mistaken for a verbatim quote.
 *
 * A missing or failing transcriber is NOT fatal: the keyframe description is
 * still a real answer, so the narration failure is reported as one named line
 * inside the output instead of throwing.
 *
 * WHAT IT IS NOT
 * --------------
 * It does not implement its own HTTP client for Ollama or any other provider,
 * and it never invents content. Every precondition failure (engine not loaded,
 * ffmpeg/ffprobe not runnable, no vision model resolvable, no frame extracted,
 * no frame described) THROWS with the missing piece named, which the host runner
 * records as `outcome: "failed"` (`runner.entries.ts` -> `runAttachmentEntries`).
 * There is no empty-string or placeholder success path.
 *
 * NO GPU CLAIM — DELIBERATE
 * -------------------------
 * `withGpuClaim` (../gpu-coop.ts) is NOT used around the vision call, and must
 * not be. `withGpuClaim` calls `broker.release()`, and `GpuBroker.release()`
 * runs `evictAllModels()`, which POSTs `keep_alive: 0` to every resident Ollama
 * model (extensions/gpu-broker/src/broker.ts). The vision model is an Ollama
 * model. Claiming around this call would therefore evict the exact model the
 * call is about to use, forcing a cold reload per frame — measured here at
 * ~6s warm versus a multi-second-to-minutes cold load. The claim exists to hand
 * VRAM to a NON-Ollama consumer (the ONNX ops in `ffi/dispatch.ts`); an Ollama
 * consumer is already inside the thing the broker arbitrates for, so the honest
 * behaviour is to take no claim and let Ollama's own scheduler manage residency.
 * The frame cap (`maxFrames`) is the VRAM-pressure control here, not a lease.
 */

import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  ImageDescriptionResult,
  MediaUnderstandingProvider,
  VideoDescriptionRequest,
  VideoDescriptionResult,
} from "openclaw/plugin-sdk/media-understanding";
import type { CodecConfig } from "../ffi/codec.js";
import { probeDurationSec } from "../ffi/codec.js";

/** Provider id this plugin owns; must match manifest `contracts.mediaUnderstandingProviders`. */
export const CREATIVE_ENGINES_MEDIA_PROVIDER_ID = "creative-engines";

/** Default vision provider when a model ref carries no `provider/` prefix. */
const DEFAULT_VISION_PROVIDER = "ollama";

const DEFAULT_MAX_FRAMES = 6;
const HARD_MAX_FRAMES = 24;
const DEFAULT_SCENE_THRESHOLD = 0.3;
/** Sampled slightly AFTER a cut so the frame belongs to the new shot. */
const DEFAULT_SCENE_LEAD_IN_SEC = 0.15;
/** Two keyframes closer than this describe the same moment; keep one. */
const MIN_FRAME_SPACING_SEC = 0.4;
const DEFAULT_FRAME_PROMPT =
  "This is a single frame from a video. Reply with at most two short sentences: the main " +
  "subject, what it is doing, and the setting. No preamble, no list, no speculation about " +
  "what happens next.";
/**
 * Per-frame trim.
 *
 * Budgeted against the HOST's `tools.media.video.maxChars`, which defaults to
 * 500 for the whole aggregated answer (`DEFAULT_MAX_CHARS_BY_CAPABILITY` in
 * packages/media-understanding-common/src/defaults.ts) and would otherwise cut
 * the tail off a multi-frame result. Raise `tools.media.video.maxChars` (e.g.
 * 8000) to keep every frame; see this plugin's README notes.
 */
const DEFAULT_MAX_CHARS_PER_FRAME = 480;
/** Leave room to still aggregate and return once the budget is nearly gone. */
const BUDGET_FLOOR_MS = 2_000;
/**
 * Trim for the folded transcript.
 *
 * Generous compared with `DEFAULT_MAX_CHARS_PER_FRAME` because the transcript is
 * VERBATIM: trimming it discards facts, whereas trimming a frame description
 * discards restatement. Still bounded so one long clip cannot crowd the
 * keyframes out of the host's `tools.media.video.maxChars` budget entirely.
 */
const DEFAULT_MAX_CHARS_NARRATION = 4_000;
/**
 * Share of the remaining budget the narration pass may consume.
 *
 * Transcription is fast relative to per-frame vision (measured: ~1.5s on GPU /
 * ~5s on CPU for a 19s clip with faster-whisper base, versus ~6s PER FRAME for a
 * warm 7B vision model), so a minority slice is enough in practice and a slow or
 * hung transcriber cannot eat the keyframe pass.
 */
const NARRATION_BUDGET_SHARE = 0.4;
/** Below this there is no point starting a transcription at all. */
const NARRATION_BUDGET_FLOOR_MS = 5_000;

/** Plugin config block: `plugins.entries["creative-engines"].mediaUnderstanding`. */
export interface VideoUnderstandingPluginConfig {
  /** Set false to not register `describeVideo` at all (no capability claimed). */
  enabled?: boolean;
  /** Vision model ref, e.g. `ollama/qwen2.5vl:7b`. */
  visionModel?: string;
  /** Provider used when `visionModel` has no `provider/` prefix. */
  visionProvider?: string;
  /** Max keyframes to extract and describe. Default 6, hard cap 24. */
  maxFrames?: number;
  /** ffmpeg scene-cut sensitivity (0-1). Default 0.3. */
  sceneThreshold?: number;
  /** Prompt sent with each keyframe. */
  framePrompt?: string;
  /** Per-frame vision timeout (ms). Bounded by the host's overall budget. */
  frameTimeoutMs?: number;
  /** Trim each frame description to this many chars. 0 disables trimming. */
  maxCharsPerFrame?: number;
  /**
   * Fold the clip's spoken content into the description by demuxing a WAV with
   * the engine's `extract_audio` op and transcribing it through the HOST's audio
   * pipeline (`tools.media.audio.models[]`). Default true; a host with no
   * transcriber configured just reports one "not transcribed" line.
   */
  transcribeNarration?: boolean;
  /** Language hint handed to the host audio pipeline, e.g. `en`. */
  narrationLanguage?: string;
  /** Trim the folded transcript to this many chars. 0 disables trimming. */
  maxCharsNarration?: number;
}

/** Structural view of the video engine seams this module uses. */
export interface VideoEngineSeam {
  /**
   * Load the native library if it is not loaded yet. Required, not optional:
   * `describeVideo` is reachable outside the gateway, where the engine service
   * never ran, and an optional hook here is how the "not loaded" bug survived.
   */
  ensureStarted(): Promise<void>;
  isAvailable(): boolean;
  reason(): string | undefined;
  apply(
    input: string,
    op: string,
    output: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: boolean; reason?: string }>;
  analyze(
    input: string,
    op: string,
    params?: Record<string, unknown>,
  ): Promise<{ ok: boolean; data?: unknown; reason?: string }>;
}

/**
 * Structural view of the host's `describeImageFileWithModel`
 * (`src/media-understanding/runtime-types.ts:56-69`). Injected rather than
 * imported so tests can drive this module without the host runtime, and so the
 * real registration can hand over `api.runtime.mediaUnderstanding.*`.
 */
export type DescribeImageFileWithModelFn = (params: {
  filePath: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  mime?: string;
  provider: string;
  model: string;
  prompt: string;
  maxTokens?: number;
  timeoutMs?: number;
}) => Promise<ImageDescriptionResult>;

/**
 * Structural view of the host's `transcribeAudioFile`
 * (`src/media-understanding/runtime.ts:354`, re-exported for plugins from
 * `openclaw/plugin-sdk/media-understanding-runtime` and reachable at
 * `api.runtime.mediaUnderstanding.transcribeAudioFile`).
 *
 * Declared structurally for the same reasons as {@link DescribeImageFileWithModelFn}:
 * tests drive this module without the host runtime, and the plugin never binds
 * to an ASR implementation of its own. Whatever the user configured under
 * `tools.media.audio.models[]` is what runs — CLI transcriber or provider.
 *
 * OPTIONAL on purpose. A host build without the hook simply gets no narration,
 * reported as such, rather than a crash or a silent omission.
 */
export type TranscribeAudioFileFn = (params: {
  filePath: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  mime?: string;
  language?: string;
}) => Promise<{
  text: string | undefined;
  provider?: string;
  model?: string;
  decision?: {
    outcome?: string;
    attachments?: ReadonlyArray<{
      attempts?: ReadonlyArray<{ outcome?: string; reason?: string }>;
    }>;
  };
}>;

export interface VideoUnderstandingDeps {
  videoEngine: VideoEngineSeam;
  codec?: CodecConfig;
  /** Live config read; `api.runtime.config.current()` in the real registration. */
  resolveConfig: () => OpenClawConfig;
  /** Agent dir for auth-profile/model resolution inside the host image call. */
  resolveAgentDir?: (cfg: OpenClawConfig) => string | undefined;
  describeImage: DescribeImageFileWithModelFn;
  /** Host audio pipeline. Absent means no narration is attempted or claimed. */
  transcribeAudio?: TranscribeAudioFileFn;
  pluginConfig?: VideoUnderstandingPluginConfig;
  /** Overridable for tests; defaults to the real ffprobe duration probe. */
  probeDuration?: (path: string, codec: CodecConfig | undefined) => Promise<number | undefined>;
  logger?: { warn?: (message: string) => void; debug?: (message: string) => void };
}

export type VisionModelRef = {
  provider: string;
  model: string;
  /** Where the ref came from, surfaced in the output so it is never invisible. */
  source: string;
};

export type FrameObservation = {
  timeSec: number;
  text: string;
  model?: string;
};

export type FrameFailure = {
  timeSec: number;
  stage: "extract" | "describe";
  reason: string;
};

/**
 * Outcome of the narration pass.
 *
 * `ok: false` is a REPORTED outcome, not a thrown one: it is rendered as a named
 * line in the description so the caller learns the clip's speech was not heard
 * and why. There is deliberately no third "empty transcript" success state — an
 * empty transcript is a failure with reason "no transcript".
 */
export type NarrationResult =
  | { ok: true; text: string; provider?: string; model?: string }
  | { ok: false; stage: "extract" | "transcribe"; reason: string };

/** Parses `provider/model`, `model`, or `provider/model:tag` into a ref. */
export function parseVisionModelRef(
  raw: string | undefined,
  defaultProvider: string,
  source: string,
): VisionModelRef | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    // No provider prefix: `qwen2.5vl:7b`. The tag colon is NOT a separator.
    return { provider: defaultProvider, model: trimmed, source };
  }
  return {
    provider: trimmed.slice(0, slash),
    model: trimmed.slice(slash + 1),
    source,
  };
}

function firstConfiguredMediaModel(
  entries: ReadonlyArray<{ type?: string; provider?: string; model?: string }> | undefined,
  source: string,
): VisionModelRef | null {
  for (const [index, entry] of (entries ?? []).entries()) {
    if (entry.type === "cli") {
      continue;
    }
    const provider = entry.provider?.trim();
    const model = entry.model?.trim();
    if (!provider || !model || provider === CREATIVE_ENGINES_MEDIA_PROVIDER_ID) {
      continue;
    }
    return { provider, model, source: `${source}[${index}]` };
  }
  return null;
}

function agentImageModelRef(cfg: OpenClawConfig, defaultProvider: string): VisionModelRef | null {
  const raw = cfg.agents?.defaults?.imageModel;
  const value =
    typeof raw === "string"
      ? raw
      : typeof (raw as { primary?: unknown } | undefined)?.primary === "string"
        ? (raw as { primary: string }).primary
        : undefined;
  return parseVisionModelRef(value, defaultProvider, "agents.defaults.imageModel");
}

/**
 * Resolve which vision model describes the keyframes.
 *
 * Order, most specific first — every step reads config the USER already owns
 * rather than duplicating it:
 *   1. `req.model` — the model on the `tools.media.video.models[]` entry that
 *      selected this provider. The host hands it to `describeVideo` as
 *      `entry.model` (`runner.entries.ts` video branch), so
 *      `{ provider: "creative-engines", model: "ollama/qwen2.5vl:7b" }` needs no
 *      plugin config at all.
 *   2. plugin config `mediaUnderstanding.visionModel`.
 *   3. `tools.media.video.models[]` — first provider entry that is not this
 *      provider (a genuine vision provider listed as a fallback).
 *   4. `tools.media.image.models[]` — the user's existing image-understanding
 *      model.
 *   5. `agents.defaults.imageModel`.
 * A ref with no `provider/` prefix uses `visionProvider` (default `ollama`,
 * the bundled keyless local vision provider).
 */
export function resolveVisionModelRef(params: {
  requestModel?: string;
  pluginConfig?: VideoUnderstandingPluginConfig;
  cfg: OpenClawConfig;
}): VisionModelRef | null {
  const defaultProvider = params.pluginConfig?.visionProvider?.trim() || DEFAULT_VISION_PROVIDER;
  const media = params.cfg.tools?.media;
  const fromRequest = parseVisionModelRef(
    params.requestModel,
    defaultProvider,
    "tools.media.video.models[].model",
  );
  if (fromRequest && fromRequest.provider !== CREATIVE_ENGINES_MEDIA_PROVIDER_ID) {
    return fromRequest;
  }
  return (
    parseVisionModelRef(
      params.pluginConfig?.visionModel,
      defaultProvider,
      "plugin config creative-engines.mediaUnderstanding.visionModel",
    ) ??
    firstConfiguredMediaModel(media?.video?.models, "tools.media.video.models") ??
    firstConfiguredMediaModel(media?.image?.models, "tools.media.image.models") ??
    agentImageModelRef(params.cfg, defaultProvider)
  );
}

function roundSec(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function pushSpaced(target: number[], candidate: number, minSpacing: number): void {
  if (target.some((existing) => Math.abs(existing - candidate) < minSpacing)) {
    return;
  }
  target.push(candidate);
}

export type KeyframePlan = {
  timestamps: number[];
  /** How the timestamps were chosen; reported in the aggregated output. */
  sampling: "scene-cuts" | "scene-cuts+even" | "even" | "single-frame";
};

/**
 * Choose keyframe timestamps.
 *
 * Scene cuts come first because they are where the CONTENT changes, then even
 * samples top the list up to `maxFrames` so a single-shot clip (very common —
 * the verified BMX clip has exactly one cut in 18s) still gets coverage instead
 * of one frame. Every timestamp is clamped inside the clip and kept
 * `MIN_FRAME_SPACING_SEC` apart so two calls never describe the same moment.
 */
export function planKeyframeTimestamps(params: {
  durationSec?: number;
  sceneCuts?: readonly number[];
  maxFrames: number;
  sceneLeadInSec?: number;
  minSpacingSec?: number;
}): KeyframePlan {
  const maxFrames = Math.max(1, Math.min(HARD_MAX_FRAMES, Math.floor(params.maxFrames)));
  const leadIn = params.sceneLeadInSec ?? DEFAULT_SCENE_LEAD_IN_SEC;
  const minSpacing = params.minSpacingSec ?? MIN_FRAME_SPACING_SEC;
  const duration = params.durationSec;
  const cuts = (params.sceneCuts ?? []).filter((cut) => Number.isFinite(cut) && cut >= 0);

  if (!duration || duration <= 0) {
    // Duration unknown: even sampling is impossible, so use the cuts we have,
    // else a single frame at the head. Never guess a length.
    if (cuts.length === 0) {
      return { timestamps: [0], sampling: "single-frame" };
    }
    const picked: number[] = [];
    for (const cut of cuts.toSorted((a, b) => a - b)) {
      pushSpaced(picked, roundSec(cut + leadIn), minSpacing);
      if (picked.length >= maxFrames) {
        break;
      }
    }
    return { timestamps: picked, sampling: "scene-cuts" };
  }

  // Stay off the very last frame: `-ss <duration>` seeks past EOF.
  const lastSampleable = Math.max(0, duration - 0.05);
  const clamp = (value: number) => roundSec(Math.min(Math.max(value, 0), lastSampleable));

  const evenSamples = (count: number): number[] =>
    Array.from({ length: count }, (_unused, index) => clamp((duration * (index + 0.5)) / count));

  if (cuts.length === 0) {
    return { timestamps: evenSamples(maxFrames), sampling: "even" };
  }

  const picked: number[] = [];
  // A frame from the opening shot, which precedes the first cut by definition.
  pushSpaced(picked, clamp(Math.min(0.5, duration / 2)), minSpacing);
  for (const cut of cuts.toSorted((a, b) => a - b)) {
    if (picked.length >= maxFrames) {
      break;
    }
    pushSpaced(picked, clamp(cut + leadIn), minSpacing);
  }
  let sampling: KeyframePlan["sampling"] = "scene-cuts";
  if (picked.length < maxFrames) {
    for (const sample of evenSamples(maxFrames)) {
      if (picked.length >= maxFrames) {
        break;
      }
      const before = picked.length;
      pushSpaced(picked, sample, minSpacing);
      if (picked.length > before) {
        sampling = "scene-cuts+even";
      }
    }
  }
  return { timestamps: picked.toSorted((a, b) => a - b), sampling };
}

function formatClock(timeSec: number): string {
  const minutes = Math.floor(timeSec / 60);
  const seconds = timeSec - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${seconds.toFixed(3).padStart(6, "0")}`;
}

function trimFrameText(text: string, maxChars: number): string {
  const collapsed = text.trim().replace(/\s*\n\s*/g, " ");
  if (maxChars <= 0 || collapsed.length <= maxChars) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/**
 * Trim the transcript WITHOUT collapsing newlines.
 *
 * A transcriber that emits one line per spoken segment (the host's CLI seam
 * templating encourages exactly that) carries its timing in the line breaks.
 * Collapsing them the way {@link trimFrameText} does would destroy the segment
 * boundaries that make a transcript actionable.
 */
export function trimNarrationText(text: string, maxChars: number): string {
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  if (maxChars <= 0 || normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/**
 * Render the aggregated description.
 *
 * The header goes first and each observation carries its timestamp inline, so
 * if the host trims the text to `tools.media.video.maxChars` (default 500) the
 * surviving prefix is still a valid, timestamped, actionable answer rather than
 * a headless fragment.
 */
export function formatVideoDescription(params: {
  fileName: string;
  durationSec?: number;
  modelRef: VisionModelRef;
  plannedFrames: number;
  sampling: KeyframePlan["sampling"];
  sceneCuts: readonly number[];
  observations: readonly FrameObservation[];
  failures: readonly FrameFailure[];
  narration?: NarrationResult;
  budgetExhausted?: boolean;
}): string {
  const lines: string[] = [];
  const duration =
    typeof params.durationSec === "number" ? `${params.durationSec.toFixed(2)}s` : "unknown length";
  lines.push(`Video: ${params.fileName} (${duration})`);
  lines.push(
    `Keyframes described: ${params.observations.length}/${params.plannedFrames} ` +
      `by ${params.modelRef.provider}/${params.modelRef.model} ` +
      `(model from ${params.modelRef.source}; sampling: ${params.sampling})`,
  );
  if (params.narration) {
    // Announced in the HEADER so a result trimmed to `tools.media.video.maxChars`
    // still tells the caller whether the clip's speech was heard at all.
    lines.push(
      params.narration.ok
        ? `Narration: transcribed by ${params.narration.provider ?? "the host audio pipeline"}` +
            `${params.narration.model ? `/${params.narration.model}` : ""} (verbatim, see SPOKEN below)`
        : `Narration: NOT transcribed (${params.narration.stage} failed): ${params.narration.reason}`,
    );
  }
  if (params.sceneCuts.length > 0) {
    lines.push(`Scene cuts at: ${params.sceneCuts.map((cut) => `${roundSec(cut)}s`).join(", ")}`);
  }
  // Kept in the HEADER, not the footer: if the host trims to
  // `tools.media.video.maxChars` the actionability hint must survive.
  lines.push(
    "Timestamps below are seconds into the source. Pass them straight to the video engine: " +
      "video.apply thumbnail {time_sec} or video.apply cut_clip {start_sec,end_sec}.",
  );
  if (params.narration?.ok) {
    // SPOKEN precedes SEEN deliberately. The transcript is verbatim ground truth
    // and cannot mislead; the keyframe prose is model INFERENCE about a still
    // frame. When the host's char cap forces a cut, keep the ground truth.
    lines.push("");
    lines.push("SPOKEN (transcript, verbatim):");
    lines.push(params.narration.text);
  }
  lines.push("");
  if (params.observations.length > 0) {
    lines.push("SEEN (keyframe descriptions, model-inferred):");
  }
  for (const observation of params.observations) {
    lines.push(
      `[t=${observation.timeSec}s | ${formatClock(observation.timeSec)}] ${observation.text}`,
    );
  }
  if (params.failures.length > 0) {
    lines.push("");
    for (const failure of params.failures) {
      lines.push(
        `[t=${failure.timeSec}s] NOT DESCRIBED (${failure.stage} failed): ${failure.reason}`,
      );
    }
  }
  if (params.budgetExhausted) {
    lines.push("");
    lines.push(
      "Stopped early: the media-understanding time budget was exhausted. " +
        "Raise tools.media.video.timeoutSeconds or lower the creative-engines maxFrames.",
    );
  }
  return lines.join("\n");
}

function safeVideoExtension(fileName: string | undefined, mime: string | undefined): string {
  const fromName = extname(fileName ?? "").toLowerCase();
  if (/^\.[a-z0-9]{2,5}$/.test(fromName)) {
    return fromName;
  }
  const subtype = mime?.split("/")[1]?.toLowerCase();
  if (subtype && /^[a-z0-9]{2,5}$/.test(subtype)) {
    return `.${subtype}`;
  }
  return ".mp4";
}

function resolveMaxFrames(pluginConfig: VideoUnderstandingPluginConfig | undefined): number {
  const raw = pluginConfig?.maxFrames;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_MAX_FRAMES;
  }
  return Math.min(HARD_MAX_FRAMES, Math.floor(raw));
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read scene cuts, tolerating an analysis failure.
 *
 * A failed `detect_scenes` is NOT fatal: even sampling still produces real
 * frames. It is logged rather than swallowed silently, and the chosen sampling
 * mode is reported in the output so the caller can tell which path ran.
 */
async function readSceneCuts(deps: VideoUnderstandingDeps, videoPath: string): Promise<number[]> {
  const threshold = deps.pluginConfig?.sceneThreshold ?? DEFAULT_SCENE_THRESHOLD;
  try {
    const result = await deps.videoEngine.analyze(videoPath, "detect_scenes", { threshold });
    if (!result.ok) {
      deps.logger?.debug?.(`creative-engines detect_scenes unavailable: ${result.reason ?? "?"}`);
      return [];
    }
    const cuts = (result.data as { cuts?: unknown } | undefined)?.cuts;
    return Array.isArray(cuts) ? cuts.filter((cut): cut is number => Number.isFinite(cut)) : [];
  } catch (err) {
    deps.logger?.debug?.(`creative-engines detect_scenes threw: ${describeError(err)}`);
    return [];
  }
}

/** First non-empty attempt reason from a host media-understanding decision. */
function firstDecisionReason(
  decision: Awaited<ReturnType<TranscribeAudioFileFn>>["decision"],
): string | undefined {
  for (const attachment of decision?.attachments ?? []) {
    for (const attempt of attachment.attempts ?? []) {
      const reason = attempt.reason?.trim();
      if (reason) {
        return reason;
      }
    }
  }
  return undefined;
}

/**
 * Bound the host audio pipeline to the slice of budget narration may use.
 *
 * `transcribeAudioFile` takes no timeout argument — it reads
 * `tools.media.audio.timeoutSeconds` (default 60s, see
 * `DEFAULT_TIMEOUT_SECONDS` in packages/media-understanding-common/src/defaults.ts).
 * Narrowing that one key on a request-scoped COPY is therefore the only way to
 * keep a slow transcriber from consuming the keyframe budget. The user's own
 * value is never raised, only lowered.
 */
function withNarrationTimeout(cfg: OpenClawConfig, budgetMs: number): OpenClawConfig {
  const audio = cfg.tools?.media?.audio;
  const configuredSeconds = audio?.timeoutSeconds;
  const boundedSeconds = Math.max(1, Math.floor(budgetMs / 1000));
  const timeoutSeconds =
    typeof configuredSeconds === "number" && configuredSeconds > 0
      ? Math.min(configuredSeconds, boundedSeconds)
      : boundedSeconds;
  return {
    ...cfg,
    tools: {
      ...cfg.tools,
      media: {
        ...cfg.tools?.media,
        audio: { ...audio, timeoutSeconds },
      },
    },
  } as OpenClawConfig;
}

/**
 * Demux the audio track with the engine and transcribe it through the HOST.
 *
 * Returns null when narration was not attempted (opted out, or the host build
 * exposes no audio pipeline) so the output claims nothing, and a
 * `{ ok: false, reason }` record when it was attempted and did not produce a
 * transcript. It never returns an empty transcript as a success.
 */
export async function readNarration(params: {
  deps: VideoUnderstandingDeps;
  cfg: OpenClawConfig;
  videoPath: string;
  workDir: string;
  budgetMs: number;
}): Promise<NarrationResult | null> {
  const { deps } = params;
  if (deps.pluginConfig?.transcribeNarration === false) {
    return null;
  }
  const transcribeAudio = deps.transcribeAudio;
  if (!transcribeAudio) {
    return null;
  }
  if (params.budgetMs < NARRATION_BUDGET_FLOOR_MS) {
    return {
      ok: false,
      stage: "transcribe",
      reason:
        `only ${params.budgetMs}ms of the media-understanding budget remained ` +
        `(minimum ${NARRATION_BUDGET_FLOOR_MS}ms); raise tools.media.video.timeoutSeconds`,
    };
  }

  const wavPath = join(params.workDir, "narration.wav");
  let extracted: { ok: boolean; reason?: string };
  try {
    extracted = await deps.videoEngine.apply(params.videoPath, "extract_audio", wavPath, {});
  } catch (err) {
    extracted = { ok: false, reason: describeError(err) };
  }
  if (!extracted.ok) {
    return { ok: false, stage: "extract", reason: extracted.reason ?? "unknown" };
  }
  const bytes = await stat(wavPath)
    .then((info) => info.size)
    .catch(() => 0);
  if (bytes <= 0) {
    // ffmpeg exits 0 having written nothing when the container has no audio
    // stream at all, which is a real and common case for screen captures.
    return {
      ok: false,
      stage: "extract",
      reason: "extract_audio produced an empty WAV (the container has no audio track?)",
    };
  }

  try {
    const result = await transcribeAudio({
      filePath: wavPath,
      cfg: withNarrationTimeout(params.cfg, params.budgetMs),
      ...(deps.resolveAgentDir?.(params.cfg)
        ? { agentDir: deps.resolveAgentDir(params.cfg) as string }
        : {}),
      mime: "audio/wav",
      ...(deps.pluginConfig?.narrationLanguage
        ? { language: deps.pluginConfig.narrationLanguage }
        : {}),
    });
    const text = trimNarrationText(
      result.text ?? "",
      deps.pluginConfig?.maxCharsNarration ?? DEFAULT_MAX_CHARS_NARRATION,
    );
    if (!text) {
      const detail = firstDecisionReason(result.decision);
      return {
        ok: false,
        stage: "transcribe",
        reason:
          `the host audio pipeline returned no transcript for a ${bytes}-byte WAV` +
          `${detail ? ` — ${detail}` : ""}. Configure a transcriber under ` +
          'tools.media.audio.models[] (a local type:"cli" entry needs no API key).',
      };
    }
    return {
      ok: true,
      text,
      ...(result.provider ? { provider: result.provider } : {}),
      ...(result.model ? { model: result.model } : {}),
    };
  } catch (err) {
    return { ok: false, stage: "transcribe", reason: describeError(err) };
  }
}

/** Builds the creative-engines media-understanding provider, or null when disabled. */
export function createVideoUnderstandingProvider(
  deps: VideoUnderstandingDeps,
): MediaUnderstandingProvider | null {
  if (deps.pluginConfig?.enabled === false) {
    // Honest opt-out: claim nothing rather than register a hook that refuses.
    return null;
  }

  const describeVideo = async (req: VideoDescriptionRequest): Promise<VideoDescriptionResult> => {
    // Load on demand before the gate. The engines' `start()` is a gateway
    // service, so a standalone caller (or any host that resolves this provider
    // before services run) used to hit the throw below with the DLL sitting
    // right there on disk.
    await deps.videoEngine.ensureStarted();
    if (!deps.videoEngine.isAvailable()) {
      throw new Error(
        "creative-engines cannot describe video: the native video engine " +
          `(libomni_video_bridge) is not loaded — ${deps.videoEngine.reason() ?? "unknown reason"}. ` +
          "Provision the engine library or set the plugin config video.binaryPath.",
      );
    }

    const cfg = deps.resolveConfig();
    const modelRef = resolveVisionModelRef({
      requestModel: req.model,
      pluginConfig: deps.pluginConfig,
      cfg,
    });
    if (!modelRef) {
      throw new Error(
        "creative-engines cannot describe video: no vision model is configured. " +
          'Set one of: tools.media.video.models[].model as "<provider>/<model>" ' +
          '(e.g. "ollama/qwen2.5vl:7b"), the creative-engines plugin config ' +
          "mediaUnderstanding.visionModel, tools.media.image.models[], or " +
          "agents.defaults.imageModel.",
      );
    }

    const startedAt = Date.now();
    const budgetMs = Number.isFinite(req.timeoutMs) && req.timeoutMs > 0 ? req.timeoutMs : 120_000;
    const remainingMs = () => budgetMs - (Date.now() - startedAt);

    const probe = deps.probeDuration ?? probeDurationSec;
    const maxFrames = resolveMaxFrames(deps.pluginConfig);
    const prompt =
      deps.pluginConfig?.framePrompt?.trim() || req.prompt?.trim() || DEFAULT_FRAME_PROMPT;
    const maxCharsPerFrame = deps.pluginConfig?.maxCharsPerFrame ?? DEFAULT_MAX_CHARS_PER_FRAME;
    const agentDir = deps.resolveAgentDir?.(cfg);

    const workDir = await mkdtemp(join(tmpdir(), "creative-engines-video-understanding-"));
    const videoPath = join(workDir, `source${safeVideoExtension(req.fileName, req.mime)}`);
    try {
      // The host hands providers a BUFFER (VideoDescriptionRequest.buffer), and
      // both ffprobe and the engine's ffmpeg ops need a seekable file.
      await writeFile(videoPath, req.buffer);

      let durationSec: number | undefined;
      try {
        durationSec = await probe(videoPath, deps.codec);
      } catch (err) {
        throw new Error(
          "creative-engines cannot describe video: ffprobe could not be run " +
            `(${describeError(err)}). Install ffmpeg/ffprobe or set the plugin config ` +
            "codec.ffmpegPath / codec.ffprobePath.",
          { cause: err },
        );
      }

      // Narration BEFORE keyframes. It is the cheaper pass (one transcription
      // versus N vision calls) and the higher-value one for instructional
      // footage, so if the budget runs out it must not be the part that is lost.
      const narration = await readNarration({
        deps,
        cfg,
        videoPath,
        workDir,
        budgetMs: Math.floor(Math.max(0, remainingMs()) * NARRATION_BUDGET_SHARE),
      });

      const sceneCuts = await readSceneCuts(deps, videoPath);
      const plan = planKeyframeTimestamps({
        durationSec,
        sceneCuts,
        maxFrames,
        sceneLeadInSec: DEFAULT_SCENE_LEAD_IN_SEC,
      });

      const observations: FrameObservation[] = [];
      const failures: FrameFailure[] = [];
      let budgetExhausted = false;

      for (const [index, timeSec] of plan.timestamps.entries()) {
        if (remainingMs() <= BUDGET_FLOOR_MS) {
          budgetExhausted = true;
          break;
        }
        const framePath = join(workDir, `frame_${index}_${timeSec.toFixed(3)}.jpg`);
        let extracted: { ok: boolean; reason?: string };
        try {
          extracted = await deps.videoEngine.apply(videoPath, "thumbnail", framePath, {
            time_sec: timeSec,
          });
        } catch (err) {
          extracted = { ok: false, reason: describeError(err) };
        }
        if (!extracted.ok) {
          failures.push({ timeSec, stage: "extract", reason: extracted.reason ?? "unknown" });
          continue;
        }
        // ffmpeg can exit 0 having written nothing when the seek lands past the
        // last decodable frame; a 0-byte "frame" must not reach the vision model.
        const bytes = await stat(framePath)
          .then((info) => info.size)
          .catch(() => 0);
        if (bytes <= 0) {
          failures.push({
            timeSec,
            stage: "extract",
            reason: "thumbnail produced an empty file (seek past the last decodable frame?)",
          });
          continue;
        }

        const frameTimeoutMs = Math.max(
          BUDGET_FLOOR_MS,
          Math.min(deps.pluginConfig?.frameTimeoutMs ?? 120_000, remainingMs()),
        );
        // Progress, not decoration. A local vision model can take minutes per
        // keyframe, and with nothing reported this loop is indistinguishable
        // from a hang: the repo's Vitest wrapper SIGKILLs a run that produces no
        // output for its watchdog window, which killed HEALTHY runs of the
        // creative-engines lane before this existed. One line per keyframe
        // boundary also tells an operator which frame a slow call is stuck on.
        const frameStartedAt = Date.now();
        deps.logger?.debug?.(
          `creative-engines describing keyframe ${index + 1}/${plan.timestamps.length} ` +
            `at t=${timeSec}s with ${modelRef.provider}/${modelRef.model} ` +
            `(frame budget ${frameTimeoutMs}ms, ${Math.max(0, remainingMs())}ms left overall)`,
        );
        try {
          const described = await deps.describeImage({
            filePath: framePath,
            cfg,
            ...(agentDir ? { agentDir } : {}),
            mime: "image/jpeg",
            provider: modelRef.provider,
            model: modelRef.model,
            prompt,
            timeoutMs: frameTimeoutMs,
          });
          const text = trimFrameText(described.text ?? "", maxCharsPerFrame);
          if (!text) {
            failures.push({
              timeSec,
              stage: "describe",
              reason: `${modelRef.provider}/${modelRef.model} returned no text`,
            });
            continue;
          }
          deps.logger?.debug?.(
            `creative-engines described keyframe ${index + 1}/${plan.timestamps.length} ` +
              `at t=${timeSec}s in ${Date.now() - frameStartedAt}ms (${text.length} chars)`,
          );
          observations.push({ timeSec, text, model: described.model });
        } catch (err) {
          deps.logger?.debug?.(
            `creative-engines failed keyframe ${index + 1}/${plan.timestamps.length} ` +
              `at t=${timeSec}s after ${Date.now() - frameStartedAt}ms`,
          );
          failures.push({ timeSec, stage: "describe", reason: describeError(err) });
        }
      }

      // A verbatim transcript alone IS a real, non-fabricated answer about the
      // clip, so it is not thrown away because the vision model failed. Only a
      // result with NOTHING real in it fails.
      if (observations.length === 0 && !narration?.ok) {
        const detail =
          failures.length > 0
            ? failures
                .map((failure) => `t=${failure.timeSec}s ${failure.stage}: ${failure.reason}`)
                .join("; ")
            : "no keyframes were planned";
        const narrationDetail = narration
          ? `; narration ${narration.stage} failed: ${narration.reason}`
          : "";
        throw new Error(
          `creative-engines described 0 of ${plan.timestamps.length} keyframes from ` +
            `${req.fileName} using ${modelRef.provider}/${modelRef.model} — ${detail}${narrationDetail}`,
        );
      }

      return {
        text: formatVideoDescription({
          fileName: req.fileName,
          durationSec,
          modelRef,
          plannedFrames: plan.timestamps.length,
          sampling: plan.sampling,
          sceneCuts,
          observations,
          failures,
          ...(narration ? { narration } : {}),
          budgetExhausted,
        }),
        model: `${modelRef.provider}/${observations[0]?.model ?? modelRef.model}`,
      };
    } finally {
      // Temp frames and the temp copy of the source always go away, including
      // on the throw paths above.
      await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
        (err: unknown) => {
          deps.logger?.warn?.(
            `creative-engines could not remove ${workDir}: ${describeError(err)}`,
          );
        },
      );
    }
  };

  return {
    id: CREATIVE_ENGINES_MEDIA_PROVIDER_ID,
    capabilities: ["video"],
    /**
     * Keyless: the work is local ffmpeg plus a host-routed call to whatever
     * vision provider the user configured (that provider resolves its own
     * credentials). Without this the runner's `hasProviderAuthAvailable` gate
     * (`runner.ts:98`) would skip the provider for want of an API key it does
     * not need. Mirrors the accepted local-provider shape asserted in
     * `src/media-understanding/runner.local-no-auth.test.ts`.
     */
    resolveAuth: () => ({
      kind: "none",
      source: "creative-engines local video keyframe understanding (no credential)",
    }),
    describeVideo,
  };
}
