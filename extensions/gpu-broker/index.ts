import type { AnyAgentTool } from "openclaw/plugin-sdk/core";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type, type TSchema } from "typebox";
import { GpuBroker } from "./src/broker.js";
import {
  createGpuBrokerCoopHandle,
  publishGpuBrokerHandle,
  unpublishGpuBrokerHandle,
  type GpuBrokerCoopHandle,
} from "./src/coop-handle.js";
import { registerGpuSurface, type GpuSurfaceApi } from "./src/surface.js";
import {
  handleGpuStatus,
  handleGpuRelease,
  handleGpuReclaim,
  handleGpuHandoff,
} from "./src/tools.js";
import type { BrokerConfig } from "./src/types.js";
import { registerWarmupRecalibration, type WarmupApi } from "./src/warmup.js";

/** Structural view of the config-reading seams `resolveConfig` uses. */
interface PluginConfigApi {
  getPluginConfig?: () => Record<string, unknown> | undefined;
  pluginConfig?: Record<string, unknown>;
}

/**
 * Wrap a friendly string-returning handler into a conforming agent tool. The
 * broker tools emit JSON text, so the string becomes the model-facing content
 * and the structured details echo the same payload.
 */
function gpuTool(spec: {
  name: string;
  description: string;
  parameters: TSchema;
  run: (args: Record<string, unknown>) => Promise<string> | string;
}): AnyAgentTool {
  return {
    name: spec.name,
    label: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    async execute(
      _toolCallId: string,
      params: unknown,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }> {
      const text = await spec.run((params ?? {}) as Record<string, unknown>);
      return { content: [{ type: "text", text }], details: text };
    },
  } satisfies AnyAgentTool;
}

/**
 * Resolve the broker config from plugin config, applying the verified
 * Polymathes defaults when a key is absent. Kept exported so the service and
 * the reload path share one canonical config shape.
 */
export function resolveConfig(api: PluginConfigApi): BrokerConfig {
  const raw = (api.getPluginConfig?.() ?? api.pluginConfig ?? {}) as Partial<BrokerConfig>;
  return {
    ollamaBaseUrl: raw.ollamaBaseUrl ?? "http://127.0.0.1:11434",
    pollIntervalMs: raw.pollIntervalMs ?? 15000,
    externalClaimThresholdMb: raw.externalClaimThresholdMb ?? 10000,
    defaultLeaseHoldMs: raw.defaultLeaseHoldMs ?? 3600000,
    dormantOverride: raw.dormantOverride ?? false,
  };
}

export default definePluginEntry({
  id: "gpu-broker",
  name: "GPU Broker",
  description:
    "Cooperative single-GPU VRAM arbiter. Manages Ollama model eviction, user leases, ghost claims on external VRAM pressure, and agent run gating.",

  // Declarative reload policy: a config change under this prefix restarts the
  // plugin so register() rebuilds the broker with the new resolved config.
  reload: {
    restartPrefixes: ["plugins.entries.gpu-broker"],
  },

  register(api) {
    let broker: GpuBroker | null = null;
    const getBroker = (): GpuBroker | null => broker;

    // Live cross-plugin coop handle, published only while the service runs.
    let coopHandle: GpuBrokerCoopHandle | null = null;

    // Register the broker as a service so it starts on gateway boot
    api.registerService({
      id: "gpu-broker",
      start() {
        broker = new GpuBroker(resolveConfig(api));
        broker.start();
        // Publish the live release/reclaim pair for in-process consumers
        // (creative-engines' withGpuClaim). The host has no cross-plugin seam
        // that can carry functions — see src/coop-handle.ts for the full why.
        coopHandle = createGpuBrokerCoopHandle(getBroker);
        publishGpuBrokerHandle(coopHandle);
      },
      stop() {
        // Remove the handle first so nothing can call into a stopped broker.
        if (coopHandle) {
          unpublishGpuBrokerHandle(coopHandle);
          coopHandle = null;
        }
        broker?.stop();
        broker = null;
      },
    });

    // --- Tool: gpu.status ---
    api.registerTool(
      gpuTool({
        name: "gpu.status",
        description:
          "Show GPU broker state: current state, VRAM usage, resident models, lease info, and recent history.",
        parameters: Type.Object({}),
        async run() {
          if (!broker) {
            return "GPU broker not running.";
          }
          return await handleGpuStatus(broker);
        },
      }),
    );

    // --- Tool: gpu.release ---
    api.registerTool(
      gpuTool({
        name: "gpu.release",
        description: "Release GPU for user work: evict all Ollama models and grant a VRAM lease.",
        parameters: Type.Object({
          owner: Type.Optional(
            Type.String({ description: "Who is claiming the GPU (default: 'user')." }),
          ),
          reason: Type.Optional(Type.String({ description: "Why the GPU is being released." })),
          holdMs: Type.Optional(Type.Number({ description: "Lease duration in ms." })),
        }),
        async run(args) {
          if (!broker) {
            return "GPU broker not running.";
          }
          return await handleGpuRelease(
            broker,
            args as { owner?: string; reason?: string; holdMs?: number },
          );
        },
      }),
    );

    // --- Tool: gpu.reclaim ---
    api.registerTool(
      gpuTool({
        name: "gpu.reclaim",
        description: "End the current GPU lease and return the broker to idle.",
        parameters: Type.Object({
          token: Type.Optional(Type.String({ description: "Lease token to reclaim (optional)." })),
        }),
        run(args) {
          if (!broker) {
            return "GPU broker not running.";
          }
          return handleGpuReclaim(broker, args as { token?: string });
        },
      }),
    );

    // --- Tool: gpu.handoff ---
    api.registerTool(
      gpuTool({
        name: "gpu.handoff",
        description: "Evacuate GPU, hand off to a peer process, then auto-reclaim.",
        parameters: Type.Object({
          owner: Type.Optional(
            Type.String({ description: "Peer process name (default: 'peer')." }),
          ),
          reason: Type.Optional(Type.String({ description: "Reason for handoff." })),
          peerDurationMs: Type.Optional(
            Type.Number({ description: "Simulated peer work duration in ms." }),
          ),
        }),
        async run(args) {
          if (!broker) {
            return "GPU broker not running.";
          }
          return await handleGpuHandoff(
            broker,
            args as { owner?: string; reason?: string; peerDurationMs?: number },
          );
        },
      }),
    );

    // --- Agent run gate hook ---
    // The broker owns the gate decision via canAgentRun() (also surfaced through
    // gpu.status and the CLI). This rides the real "agent:bootstrap" internal
    // hook event, which is the earliest per-run seam the host dispatches.
    // NOTE: the host currently discards `event.messages` for agent:bootstrap
    // (src/agents/bootstrap-hooks.ts only reads back context.bootstrapFiles),
    // so this advertises the unavailable state but cannot block a run. A real
    // gate needs a host-side veto seam.
    api.registerHook(
      "agent:bootstrap",
      (event) => {
        if (broker && !broker.canAgentRun()) {
          event.messages.push(
            `GPU broker state is "${broker.getState()}" — local GPU unavailable.`,
          );
        }
      },
      {
        name: "gpu-broker-agent-run-gate",
        description: "Advertise GPU availability at agent bootstrap.",
      },
    );

    // --- Warmup recalibration: rebaseline after a deliberate model warmup ---
    // The host api shape varies across runtimes; the helper typeof-guards each
    // seam, so we adapt to its narrow structural contract at the boundary.
    registerWarmupRecalibration(api as unknown as WarmupApi, getBroker);

    // --- Operator surface: `openclaw gpu ...` CLI + Control UI descriptor ---
    registerGpuSurface(api as unknown as GpuSurfaceApi, getBroker);

    // Config reload is declarative on this host (see the entry's `reload`
    // field below): the host has no reload *handler* seam, so a config change
    // under plugins.entries.gpu-broker restarts the plugin, which re-runs
    // register() and rebuilds the broker from the new resolved config.
  },
});
