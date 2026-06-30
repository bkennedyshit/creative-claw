// Agent-run gate: before_model_resolve hook handler that checks GPU availability.
import type { GpuBroker, BrokerLogger } from "./broker.js";

/**
 * Hook handler result compatible with PluginHookBeforeModelResolveResult.
 * Only providerOverride and modelOverride are recognized by the runtime.
 */
export interface RunGateHookResult {
  providerOverride?: string;
  modelOverride?: string;
}

/**
 * Create a before_model_resolve hook handler that checks whether the GPU broker
 * permits agent runs. When the broker denies a run (user-claimed or draining),
 * the handler logs a warning. It cannot block the run directly (the hook only
 * supports model/provider overrides), but it signals the situation to operators.
 */
export function createRunGate(
  broker: GpuBroker,
  logger: BrokerLogger,
): () => RunGateHookResult | undefined {
  return (): RunGateHookResult | undefined => {
    const gate = broker.canAgentRun();
    if (gate.allowed) {
      // Permit: transition to agent-active when idle
      if (broker.getCurrentState() === "idle") {
        broker.enterAgentActive();
      }
      return undefined;
    }

    logger.warn(`gpu-broker: agent run gate denied (reason: ${gate.reason ?? "unknown"})`);
    return undefined;
  };
}
