// GPU Broker plugin entrypoint: registers VRAM arbitration service and tools.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { GpuBroker } from "./src/broker.js";
import { snapshotGpu } from "./src/gpu-snapshot.js";
import { createRunGate } from "./src/run-gate.js";
import type { GpuBrokerConfig } from "./src/types.js";
import { recalibrateAfterWarmup } from "./src/warmup.js";

const DEFAULT_CONFIG: GpuBrokerConfig = {
  ollamaUrl: "http://127.0.0.1:11434",
  pollMs: 2000,
  externalClaimThresholdMb: 512,
  defaultHoldMs: 30000,
  dormant: false,
};

function resolveConfig(raw: unknown): GpuBrokerConfig {
  const cfg = (raw && typeof raw === "object" ? raw : {}) as Partial<GpuBrokerConfig>;
  return {
    ollamaUrl:
      typeof cfg.ollamaUrl === "string" && cfg.ollamaUrl.length > 0
        ? cfg.ollamaUrl
        : DEFAULT_CONFIG.ollamaUrl,
    pollMs:
      typeof cfg.pollMs === "number" && cfg.pollMs >= 500 ? cfg.pollMs : DEFAULT_CONFIG.pollMs,
    externalClaimThresholdMb:
      typeof cfg.externalClaimThresholdMb === "number" && cfg.externalClaimThresholdMb >= 0
        ? cfg.externalClaimThresholdMb
        : DEFAULT_CONFIG.externalClaimThresholdMb,
    defaultHoldMs:
      typeof cfg.defaultHoldMs === "number" && cfg.defaultHoldMs >= 1000
        ? cfg.defaultHoldMs
        : DEFAULT_CONFIG.defaultHoldMs,
    dormant: typeof cfg.dormant === "boolean" ? cfg.dormant : DEFAULT_CONFIG.dormant,
  };
}

export default definePluginEntry({
  id: "gpu-broker",
  name: "GPU Broker",
  description: "VRAM arbitration service for local GPU resource management",
  reload: {
    onConfigChange(api) {
      const broker = (api as unknown as { __gpuBroker?: GpuBroker }).__gpuBroker;
      if (broker) {
        const newConfig = resolveConfig(api.config);
        broker.applyConfig(newConfig);
      }
    },
  },
  register(api) {
    const config = resolveConfig(api.pluginConfig);
    const broker = new GpuBroker({
      config,
      logger: api.logger,
      snapshotFn: snapshotGpu,
    });

    // Store broker reference for reload access
    (api as unknown as { __gpuBroker: GpuBroker }).__gpuBroker = broker;

    // Register as a gateway-lifetime service
    api.registerService({
      id: "gpu-broker",
      async start() {
        await broker.init();
      },
      stop() {
        broker.shutdown();
      },
    });

    // Tool: gpu.status - report current broker state and VRAM snapshot
    api.registerTool({
      name: "gpu.status",
      label: "GPU Status",
      description: "Report the current GPU broker state and VRAM snapshot.",
      parameters: {},
      async execute() {
        const state = broker.getState();
        return {
          type: "json" as const,
          value: state,
          text: `GPU state: ${state.state}, used: ${String(state.lastSnapshot?.usedMb ?? "unknown")}MB`,
        };
      },
    });

    // Tool: gpu.release - claim the GPU on behalf of the user, returning a lease token
    api.registerTool({
      name: "gpu.release",
      label: "GPU Release",
      description:
        "Claim the GPU on behalf of the user for external work. Returns a lease token for later reclaim.",
      parameters: {
        type: "object",
        properties: {
          holdMs: {
            type: "integer",
            description: "Optional hold duration in milliseconds.",
          },
        },
      },
      async execute(_toolCallId: string, params: unknown) {
        const { holdMs } = (params && typeof params === "object" ? params : {}) as {
          holdMs?: number;
        };
        const token = broker.claim(holdMs);
        if (!token) {
          return {
            type: "json" as const,
            value: { success: false, reason: "GPU is already claimed or draining" },
            text: "Failed to claim GPU: already in use or draining.",
          };
        }
        return {
          type: "json" as const,
          value: { success: true, token },
          text: `GPU claimed. Token: ${token}`,
        };
      },
    });

    // Tool: gpu.reclaim - release a previously claimed GPU using the lease token
    api.registerTool({
      name: "gpu.reclaim",
      label: "GPU Reclaim",
      description: "Release a previously claimed GPU using the lease token.",
      parameters: {
        type: "object",
        properties: {
          token: {
            type: "string",
            description: "The lease token returned by gpu.release.",
          },
        },
        required: ["token"],
      },
      async execute(_toolCallId: string, params: unknown) {
        const { token } = (params && typeof params === "object" ? params : {}) as {
          token?: string;
        };
        if (!token) {
          return {
            type: "json" as const,
            value: { success: false, reason: "Missing token" },
            text: "Failed: no token provided.",
          };
        }
        const released = broker.release(token);
        return {
          type: "json" as const,
          value: { success: released },
          text: released ? "GPU reclaimed successfully." : "Failed to reclaim: invalid token.",
        };
      },
    });

    // Tool: gpu.handoff - evacuate models and hand GPU to another process
    api.registerTool({
      name: "gpu.handoff",
      label: "GPU Handoff",
      description: "Evacuate Ollama models from VRAM and hand the GPU to another process.",
      parameters: {
        type: "object",
        properties: {
          holdMs: {
            type: "integer",
            description: "Optional hold duration in milliseconds for the handoff.",
          },
        },
      },
      async execute(_toolCallId: string, params: unknown) {
        const { holdMs } = (params && typeof params === "object" ? params : {}) as {
          holdMs?: number;
        };
        const evacuated = await broker.evacuateOllama();
        if (!evacuated) {
          return {
            type: "json" as const,
            value: { success: false, reason: "Evacuation failed" },
            text: "GPU handoff failed: could not evacuate Ollama models.",
          };
        }
        const token = broker.claim(holdMs);
        if (!token) {
          return {
            type: "json" as const,
            value: { success: false, reason: "Claim failed after evacuation" },
            text: "GPU handoff failed: could not claim after evacuation.",
          };
        }
        return {
          type: "json" as const,
          value: { success: true, token },
          text: `GPU handed off. Token: ${token}`,
        };
      },
    });

    // Agent-run gate: before_model_resolve hook via typed api.on()
    let warmupDone = false;
    const runGate = createRunGate(broker, api.logger);
    api.on("before_model_resolve", async () => {
      const result = runGate();
      // Trigger warmup recalibration after the first permitted agent run
      if (!warmupDone && broker.getCurrentState() === "agent-active") {
        warmupDone = true;
        await recalibrateAfterWarmup(broker, api.logger);
      }
      return result ?? {};
    });

    // Operator surface: HTTP route for GPU state introspection
    api.registerHttpRoute({
      path: "/gpu/state",
      auth: "gateway",
      handler(_req, res) {
        const state = broker.getState();
        const body = JSON.stringify(state);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
        return true;
      },
    });

    // Operator surface: CLI command for GPU status
    api.registerCli(
      (ctx) => {
        ctx.program
          .command("status")
          .description("Show current GPU broker state")
          .action(() => {
            const state = broker.getState();
            ctx.logger.info(JSON.stringify(state, null, 2));
          });
      },
      {
        parentPath: ["gpu"],
        descriptors: [{ name: "gpu", description: "GPU broker commands", hasSubcommands: true }],
      },
    );

    // Operator surface: Control UI descriptor for GPU state display
    api.registerControlUiDescriptor({
      id: "gpu-broker-state",
      surface: "session",
      label: "GPU State",
      description: "Displays the current GPU broker state and VRAM usage.",
    });
  },
});
