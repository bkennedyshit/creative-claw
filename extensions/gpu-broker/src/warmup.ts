// Warmup recalibration: updates the broker baseline after a model has been loaded.
import type { GpuBroker, BrokerLogger } from "./broker.js";

/**
 * Recalibrate the broker baseline after a warmup model load.
 *
 * Call this after the first idle->agent-active transition so the warmed model's
 * VRAM footprint is absorbed into the baseline and does not trigger a ghost-claim.
 */
export async function recalibrateAfterWarmup(
  broker: GpuBroker,
  logger: BrokerLogger,
): Promise<void> {
  logger.info("gpu-broker: recalibrating baseline after warmup");
  await broker.recalibrateBaseline();
  logger.info(
    `gpu-broker: warmup recalibration complete (baseline=${String(broker.getState().baselineUsedMb)}MB)`,
  );
}
