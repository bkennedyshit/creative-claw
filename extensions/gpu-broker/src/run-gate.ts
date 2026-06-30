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
 *
 * NOTE: This gate is advisory-only. The before_model_resolve hook does not support
 * blocking or canceling a model request. It can only suggest provider/model overrides.
 * True enforcement would require a different hook point or a provider-level gate.
 * The broker's claim/deny semantics are therefore informational: operators see
 * warnings when the GPU is claimed, but agent inference is not prevented.
 */
export function createRunGate(
  broker: GpuBroker,
  logger: BrokerLogger,
): () => RunGateHookResult | undefined {
  return (): RunGateHookResult | undefined => {
    const gate = broker.canAgentRun();
    if (gate.allowed) {
      return undefined;
    }

    logger.warn(`gpu-broker: agent run gate denied (reason: ${gate.reason ?? "unknown"})`);
    return undefined;
  };
}
