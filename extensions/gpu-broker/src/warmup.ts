import type { GpuBroker } from "./broker.js";

/**
 * Minimal structural view of the plugin API surface warmup recalibration uses.
 *
 * Every method is optional so the helper degrades honestly: if the host does
 * not expose a given seam, the corresponding wiring is skipped instead of
 * throwing. Matches the object-form hook style used elsewhere in this plugin.
 */
export interface WarmupApi {
  /**
   * Host hook registration: `(events, handler, opts)`. `opts.name` is REQUIRED —
   * the host registry throws "hook registration missing name" without it
   * (src/plugins/registry.ts registerHook).
   */
  registerHook?: (
    events: string | string[],
    handler: (event?: unknown) => unknown,
    opts?: { name?: string; description?: string },
  ) => void;
  /**
   * Optional dedicated model-warmup seam. No OpenClaw host currently exposes
   * this, so the run-start fallback below is the path that actually runs.
   */
  registerModelWarmupHook?: (handler: () => void) => void;
}

/**
 * Wire GPU-broker baseline recalibration to the model-warm / first-run path.
 *
 * A deliberate model warmup makes a new resident model footprint legitimate.
 * If the broker's VRAM baseline was calibrated before the model loaded, that
 * warmed footprint would look like external pressure and trigger a spurious
 * ghost claim. Recalibrating the baseline after warmup folds the warmed model
 * into the baseline so it is not mistaken for an external claimant.
 *
 * Preference order:
 *  1. An explicit model-warmup seam (`registerModelWarmupHook`) when present —
 *     recalibrate on every deliberate warmup.
 *  2. Otherwise fall back to the run-start hook and recalibrate exactly once
 *     per session, on the first agent run after idle→agent-active (by then the
 *     model the run needs has been loaded).
 */
export function registerWarmupRecalibration(
  api: WarmupApi,
  getBroker: () => GpuBroker | null,
): void {
  const recalibrate = (): void => {
    getBroker()?.calibrateBaseline();
  };

  // Preferred: a host that signals deliberate warmups. Rebaseline each time so
  // repeated warmups keep the baseline aligned with the warmed footprint.
  if (typeof api.registerModelWarmupHook === "function") {
    api.registerModelWarmupHook(() => recalibrate());
    return;
  }

  // Fallback: no explicit warm seam. Recalibrate once per session on the first
  // run-start; the `done` latch keeps later runs from re-reading the baseline
  // (which could absorb a genuine external claim that appeared mid-session).
  if (typeof api.registerHook !== "function") return;
  let done = false;
  api.registerHook(
    "agent:bootstrap",
    () => {
      if (done) return;
      done = true;
      recalibrate();
    },
    {
      name: "gpu-broker-warmup-recalibration",
      description: "Recalibrate the GPU VRAM baseline once per session after model warmup.",
    },
  );
}
