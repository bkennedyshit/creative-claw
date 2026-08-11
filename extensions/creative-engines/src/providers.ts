import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { CodecConfig } from "./ffi/codec.js";
import type { AudioEngineRuntime } from "./runtime/audio.js";
import type { ImageEngineRuntime } from "./runtime/image.js";
import type { VideoEngineRuntime } from "./runtime/video.js";
import {
  createVideoUnderstandingProvider,
  type VideoUnderstandingPluginConfig,
} from "./media/video-understanding.js";

/**
 * Subset of the plugin API this module is allowed to touch. Kept as the
 * declared surface so every registration here is type-checked against the real
 * host `*ProviderPlugin` contracts (no `unknown`).
 */
export type ProviderApi = Pick<
  OpenClawPluginApi,
  | "registerImageGenerationProvider"
  | "registerMediaUnderstandingProvider"
  | "registerMusicGenerationProvider"
  | "registerVideoGenerationProvider"
  | "runtime"
  | "config"
  | "logger"
>;

/**
 * Media provider registration for creative-engines.
 *
 * WHAT IS REGISTERED
 * ------------------
 * Exactly one thing: a media-understanding provider implementing
 * `describeVideo` (see `./media/video-understanding.ts`). It extracts real
 * keyframes with the native video engine and describes them through the host's
 * configured vision model, returning timestamped observations. Declared in the
 * manifest as `contracts.mediaUnderstandingProviders: ["creative-engines"]`,
 * which is what `resolveCapabilityPluginIds`
 * (`src/plugins/capability-provider-runtime.ts`) matches on when the runner
 * resolves a provider outside the already-loaded registry.
 *
 * WHAT IS NOT REGISTERED, AND WHY
 * -------------------------------
 * No `describeImage` / `describeImages`. Declaring image capability would make
 * `hydrateModelBackedMediaProvider` (`src/media-understanding/provider-registry.ts:32`)
 * graft the generic model-backed image path onto this provider id, giving the
 * user a second name for a call the real vision provider already serves — and
 * letting this id shadow that provider in auto-selection. There is nothing the
 * engines add to a still image the vision model does not already do.
 *
 * No `transcribeAudio` — RE-VERIFIED, CONCLUSION UNCHANGED. The audio engine
 * exposes 45 ops (`audio.list_ops`) and not one of them is ASR: they are DSP
 * transforms (`noise_gate`, `eq_parametric`, `time_stretch`, `beat_detect`,
 * `lufs_measure`, …). The only audio-adjacent op anywhere in these engines is the
 * VIDEO engine's `extract_audio`, which demuxes a 44.1 kHz stereo WAV and
 * understands nothing. Registering `transcribeAudio` here would mean shelling out
 * to somebody else's speech model and presenting it as an engine capability — the
 * exact pattern that produced the id-only provider removed from this file.
 *
 * The host already owns this seam properly. `tools.media.audio.models[]` accepts
 * `type: "cli"` entries (`MediaUnderstandingModelConfig`,
 * `src/config/types.tools.ts`), executed by `runCliEntry`
 * (`src/media-understanding/runner.entries.ts`) with `{{MediaPath}}` /
 * `{{Language}}` / `{{OutputDir}}` templating, per-command output extraction for
 * `whisper`, `whisper-cli`, `parakeet-mlx` and `sherpa-onnx-offline`, automatic
 * 16 kHz mono WAV conversion for whisper.cpp, and PATH auto-discovery of those
 * binaries (`resolveLocalAudioEntry`, `runner.ts:554`). A local transcriber is
 * therefore a CONFIGURATION task, not a plugin task. See
 * `scripts/faster-whisper-cli.py` in this extension for a ready-made local
 * entry point when `faster-whisper` is installed as a library with no console
 * script of its own; the plugin never spawns it.
 *
 * What this plugin DOES do with audio is consume it: `describeVideo` demuxes the
 * clip's audio with `extract_audio` and hands the WAV to the HOST's
 * `transcribeAudioFile`, folding the resulting verbatim transcript into the same
 * timestamped answer as the keyframes (see `./media/video-understanding.ts`).
 * Consuming the host's audio pipeline is honest; claiming to BE one is not.
 *
 * NO GENERATION PROVIDERS. These engines are DETERMINISTIC EDITING engines —
 * compiled C++ transforms driven op-by-op through the `image.*` / `audio.*` /
 * `video.*` / `vector.*` tools. This file used to register four providers
 * anyway:
 *
 *   - `registerImageGenerationProvider({ capabilities: { generate: {} }, … })`
 *   - `registerMusicGenerationProvider(…)`
 *   - `registerVideoGenerationProvider(…)`
 *   - `registerMediaUnderstandingProvider({ id })`  ← id only, no methods
 *
 * The three generation bodies all called `engine.apply(req.prompt, "generate",
 * …)`, which (a) passed a text prompt where the dispatcher expects an INPUT FILE
 * PATH and (b) asked for an op that does not exist (155 / 45 / 46 ops
 * respectively, none named `generate`), so every call failed with `unknown op
 * 'generate'`. The old media-understanding registration was equally empty: the
 * runner skips a provider that lacks the hook for the requested capability
 * (`src/media-understanding/runner.ts:612` returns null when
 * `capability === "video" && !provider.describeVideo`), so an id-only provider
 * advertised a capability it could never serve. All four were removed rather
 * than faked; only the one that is now genuinely implemented is back.
 *
 * Do not re-add a generation provider here unless the native engines actually
 * gain a prompt-to-media op — verify against `NativeDispatch.listOps()` first.
 */
export function registerProviders(
  api: ProviderApi,
  engines: { image: ImageEngineRuntime; audio: AudioEngineRuntime; video: VideoEngineRuntime },
  options?: { codec?: CodecConfig; mediaUnderstanding?: VideoUnderstandingPluginConfig },
): void {
  const provider = createVideoUnderstandingProvider({
    videoEngine: engines.video,
    ...(options?.codec ? { codec: options.codec } : {}),
    ...(options?.mediaUnderstanding ? { pluginConfig: options.mediaUnderstanding } : {}),
    // Live snapshot, not the register()-time config: media understanding runs
    // long after boot and the vision model can be reconfigured meanwhile. The
    // `as` cast drops DeepReadonly only; the config is never mutated here.
    resolveConfig: () =>
      (api.runtime?.config?.current?.() as OpenClawConfig | undefined) ?? api.config,
    resolveAgentDir: (cfg) => api.runtime?.agent?.resolveAgentDir?.(cfg, ""),
    // Route through the HOST so the user's provider registry, auth profiles,
    // base URLs, and timeouts apply. No plugin-owned HTTP client.
    describeImage: (params) => api.runtime.mediaUnderstanding.describeImageFileWithModel(params),
    // Same rule for speech: the transcript comes from whatever the user
    // configured under `tools.media.audio.models[]`. Bound optionally and
    // capability-guarded so a host build without the hook simply yields no
    // narration instead of throwing during register().
    ...(typeof api.runtime?.mediaUnderstanding?.transcribeAudioFile === "function"
      ? {
          transcribeAudio: (params) =>
            api.runtime.mediaUnderstanding.transcribeAudioFile(params),
        }
      : {}),
    logger: api.logger,
  });
  if (provider) {
    api.registerMediaUnderstandingProvider(provider);
  }
}
