import type { AnyAgentTool } from "openclaw/plugin-sdk/core";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { configureCudaProviderDependencies } from "./src/ffi/loader.js";
import { registerEditSessionTools } from "./src/image/edit-session.js";
import { registerProviders } from "./src/providers.js";
import { AudioEngineRuntime } from "./src/runtime/audio.js";
import { ImageEngineRuntime } from "./src/runtime/image.js";
import { VectorEngineRuntime } from "./src/runtime/vector.js";
import { VideoEngineRuntime } from "./src/runtime/video.js";
import { registerCreativeSurface } from "./src/surface.js";
import { registerBatchTools } from "./src/tools/batch.js";
import { registerOpsTools } from "./src/tools/ops.js";
import type { CreativeEnginesConfig } from "./src/types.js";

/** Structural view of the config-reading seams this plugin uses. */
interface PluginConfigApi {
  getPluginConfig?: () => Record<string, unknown> | undefined;
  pluginConfig?: Record<string, unknown>;
}

export default definePluginEntry({
  id: "creative-engines",
  name: "Creative Engines",
  description:
    "Native in-process C++ image, audio, video, and vector engines loaded via koffi FFI (no co-processes, no Python).",

  register(api) {
    // Resolve plugin config from the canonical plugin-config seam.
    const configApi: PluginConfigApi = api;
    const config = (configApi.getPluginConfig?.() ??
      configApi.pluginConfig ??
      {}) as CreativeEnginesConfig;
    const codec = config.codec;

    // Hand the CUDA block to the loader BEFORE any engine starts. Discovery
    // itself runs inside the ONNX Runtime preload (first engine start), so the
    // config has to be recorded here — register() is the only point that has it.
    // Purely an optimization: with nothing found, ONNX ops run on the CPU
    // provider and say so.
    configureCudaProviderDependencies(config.cuda);

    // Initialize engine runtimes. Each loads its native library in-process.
    const imageEngine = new ImageEngineRuntime(config.image, codec);
    const audioEngine = new AudioEngineRuntime(config.audio, codec);
    const videoEngine = new VideoEngineRuntime(config.video, codec);
    const vectorEngine = new VectorEngineRuntime(config.vector, codec);

    const engines: Record<
      string,
      ImageEngineRuntime | AudioEngineRuntime | VideoEngineRuntime | VectorEngineRuntime
    > = {
      image: imageEngine,
      audio: audioEngine,
      video: videoEngine,
      vector: vectorEngine,
    };

    // Startup: load the FFI libraries when the gateway boots. There is no child
    // process to spawn — the engines run in-process.
    api.registerService({
      id: "creative-engines",
      async start() {
        await Promise.all([
          imageEngine.start(),
          audioEngine.start(),
          videoEngine.start(),
          vectorEngine.start(),
        ]);
      },
    });

    // Shutdown/unload happens through the runtime lifecycle cleanup seam.
    api.registerRuntimeLifecycle({
      id: "creative-engines",
      async cleanup() {
        await Promise.all([
          imageEngine.shutdown(),
          audioEngine.shutdown(),
          videoEngine.shutdown(),
          vectorEngine.shutdown(),
        ]);
      },
    });

    // Cross-plugin GPU cooperation needs no wiring here. `withGpuClaim` resolves
    // the broker handle LAZILY at call time from the shared `globalThis` slot
    // (see src/gpu-broker-handle.ts for why that transport is used). Resolving
    // eagerly here was the old bug: `gpu-broker` only creates its broker inside
    // its service `start()`, and plugin register() order is not guaranteed, so
    // any handle captured during register() was always missing.

    // Register per-engine op tools (tool surface unchanged).
    const registerTool = (tool: AnyAgentTool): void => {
      api.registerTool(tool);
    };

    registerOpsTools(registerTool, engines);
    registerBatchTools(registerTool, engines);
    registerEditSessionTools(registerTool, imageEngine);

    // Register the one media provider these engines can honestly serve:
    // keyframe-based video understanding (`describeVideo`). See src/providers.ts
    // for why nothing else is registered.
    registerProviders(
      api,
      { image: imageEngine, audio: audioEngine, video: videoEngine },
      {
        ...(codec ? { codec } : {}),
        ...(config.mediaUnderstanding ? { mediaUnderstanding: config.mediaUnderstanding } : {}),
      },
    );

    // Operator surface: `openclaw creative ...` CLI + Control UI settings card.
    // Capability-guarded inside; no-ops honestly on hosts lacking the methods.
    registerCreativeSurface(api, engines);
  },
});
