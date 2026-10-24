import type { AnyAgentTool } from "openclaw/plugin-sdk/core";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  getAllCreativeCapabilities,
  getCreativeCapability,
  getEngineCapabilities,
  searchCreativeCapabilities,
  validateOperationParameters,
  validateCreativeGraph,
} from "./src/capabilities.js";
import { configureCudaProviderDependencies } from "./src/ffi/loader.js";
import { registerEditSessionTools } from "./src/image/edit-session.js";
import { registerProviders } from "./src/providers.js";
import { AudioEngineRuntime } from "./src/runtime/audio.js";
import { ImageEngineRuntime } from "./src/runtime/image.js";
import { VectorEngineRuntime } from "./src/runtime/vector.js";
import { VfxEngineRuntime, VFX_CAPABILITIES } from "./src/runtime/vfx.js";
import { VideoEngineRuntime } from "./src/runtime/video.js";
import { registerCreativeStudio } from "./src/studio.js";
import { registerCreativeSurface } from "./src/surface.js";
import { registerBatchTools } from "./src/tools/batch.js";
import { registerDiscoveryTools } from "./src/tools/discovery.js";
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
    const vfxEngine = new VfxEngineRuntime(config.vfx?.binaryPath, codec);
    api.registerGatewayMethod("vfx.list_ops", async ({ respond }) => {
      await vfxEngine.ensureStarted();
      respond(true, {
        available: vfxEngine.isAvailable(),
        reason: vfxEngine.reason(),
        ops: VFX_CAPABILITIES.map((cap) => ({
          id: cap.id.slice("vfx.".length),
          label: cap.label,
          parametersSchema: cap.parametersSchema,
          capability: cap,
        })),
      });
    });

    const engines: Record<
      string,
      ImageEngineRuntime | AudioEngineRuntime | VideoEngineRuntime | VectorEngineRuntime
    > = {
      image: imageEngine,
      audio: audioEngine,
      video: videoEngine,
      vector: vectorEngine,
    };

    // Control UI gateway surface. Agent tools and gateway RPC methods live in
    // separate registries, so the Studio needs explicit adapters over the same
    // in-process runtime objects used by the tools and CLI.
    for (const [name, engine] of Object.entries(engines)) {
      api.registerGatewayMethod(`${name}.list_ops`, async ({ respond }) => {
        await engine.ensureStarted();
        const reason = engine.reason();
        const opCatalog = engine.listOps();
        const capabilities = getEngineCapabilities(name as "image" | "audio" | "video" | "vector");
        const opsWithCapabilities = opCatalog.ops.map((op) => {
          const cap = capabilities.find((c) => c.id === `${name}.${op.id}`);
          return {
            ...op,
            label: cap?.label ?? op.name,
            parametersSchema: cap?.parametersSchema,
            capability: cap,
          };
        });
        respond(true, {
          ...opCatalog,
          ops: opsWithCapabilities,
          available: engine.isAvailable(),
          ...(reason ? { reason } : {}),
          engine_path: engine.binaryPath ?? "bundled",
        });
      });

      api.registerGatewayMethod(`${name}.apply`, async ({ params, respond }) => {
        const input = typeof params.input === "string" ? params.input.trim() : "";
        const op = typeof params.op === "string" ? params.op.trim() : "";
        const output = typeof params.output === "string" ? params.output.trim() : "";
        const operationParams =
          params.params && typeof params.params === "object" && !Array.isArray(params.params)
            ? (params.params as Record<string, unknown>)
            : {};

        if (!input || !op || !output) {
          const message = "input, op, and output are required";
          return respond(true, { ok: false, error: message, message });
        }

        const capability = getCreativeCapability(`${name}.${op}`);
        if (!capability) {
          return respond(true, { ok: false, error: `Unknown operation '${name}.${op}'` });
        }
        let resolvedParams = operationParams;
        if (capability) {
          const validation = validateOperationParameters(capability, operationParams);
          if (!validation.valid) {
            const message = `Validation failed for op '${name}.${op}': ${validation.errors.join("; ")}`;
            return respond(true, { ok: false, error: message, message, errors: validation.errors });
          }
          resolvedParams = validation.resolvedParams;
        }

        try {
          const result = await engine.apply(input, op, output, resolvedParams);
          respond(true, {
            ...result,
            output: result.output_path,
            message: result.ok ? result.output_path : (result.reason ?? "Operation failed"),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          respond(true, { ok: false, error: message, message });
        }
      });
    }

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
          vfxEngine.ensureStarted(),
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
          vfxEngine.shutdown(),
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
    registerCreativeStudio(api, { ...engines, vfx: vfxEngine }, codec);

    // Register compact discovery tools for agent and Codex tool-call loops.
    registerDiscoveryTools(registerTool);

    // Compact discovery Gateway RPCs for Control UI / Creative Studio.
    api.registerGatewayMethod("creative.capabilities.search", async ({ params, respond }) => {
      const p = params ?? {};
      const query = typeof p.query === "string" ? p.query : "";
      const family = typeof p.family === "string" ? p.family : undefined;
      const limit = typeof p.limit === "number" ? p.limit : 10;
      respond(true, { results: searchCreativeCapabilities(query, { family, limit }) });
    });

    api.registerGatewayMethod("creative.capabilities.get", async ({ params, respond }) => {
      const p = params ?? {};
      const id = typeof p.id === "string" ? p.id.trim() : "";
      const capability = getCreativeCapability(id);
      respond(
        true,
        capability
          ? { found: true, capability }
          : { found: false, error: `Capability '${id}' not found` },
      );
    });

    api.registerGatewayMethod("creative.capabilities.list", async ({ params, respond }) => {
      const p = params ?? {};
      const family = typeof p.family === "string" ? p.family : undefined;
      respond(true, {
        capabilities: getAllCreativeCapabilities().filter(
          (cap) => !family || cap.family === family,
        ),
      });
    });

    api.registerGatewayMethod("creative.graph.validate", async ({ params, respond }) => {
      const p = params ?? {};
      respond(true, validateCreativeGraph(p.graph));
    });
  },
});
