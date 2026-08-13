/**
 * Cross-plugin GPU cooperation handle — publisher side.
 *
 * WHY A `globalThis` REGISTRY (deliberate, documented escape hatch):
 * The consumer (`creative-engines`) needs a LIVE function pair
 * (`release`/`reclaim`) that closes over this plugin's running `GpuBroker`
 * instance. The host offers no seam that can carry that:
 *   - Run context (`api.setRunContext` / `api.getRunContext`,
 *     `src/plugins/types.ts:2599-2600`) is typed `PluginJsonValue`
 *     (`src/plugins/host-hook-json.ts`) — JSON primitives/arrays/objects only,
 *     validated against depth/node limits. Functions cannot travel through it.
 *   - `api.registerService` (`src/plugins/types.ts:2697`) takes
 *     `OpenClawPluginService = { id, start, stop? }` and is write-only. There is
 *     no service lookup/getter on `OpenClawPluginApi`, so another plugin cannot
 *     ask the host for this plugin's live object.
 * Both plugins load in the same Node process (the gateway), so a module-level
 * registry on `globalThis` under a well-known key is the only transport that
 * actually works. The consumer copy of this key lives in
 * `extensions/creative-engines/src/gpu-broker-handle.ts` — the two strings MUST
 * stay identical.
 */

import type { GpuBroker } from "./broker.js";

/** Well-known global slot shared with `extensions/creative-engines`. */
export const GPU_BROKER_HANDLE_KEY = "__creativeClawGpuBroker__";

/**
 * The live handle shape the consumer expects: two zero-arg async functions.
 * `release()` = "give the GPU to the caller" (evict Ollama, take a lease),
 * `reclaim()` = "caller is done, hand the GPU back".
 */
export type GpuBrokerCoopHandle = {
  release: () => Promise<void>;
  reclaim: () => Promise<void>;
};

/** Owner string recorded on the lease so `gpu.status` shows who holds the GPU. */
export const COOP_LEASE_OWNER = "creative-engines";
const COOP_LEASE_REASON = "creative-engines GPU-bound operation";

function globalSlot(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

/**
 * Adapt the real `GpuBroker` API onto the zero-arg coop handle.
 *
 * Real broker signatures (verified in `./broker.ts`):
 *   `release(owner: string, reason?: string, holdMs?: number): Promise<Lease>`
 *   `reclaim(token?: string): boolean`
 * So `release()` must remember the returned lease token and `reclaim()` must
 * present it. The broker holds at most one lease, so overlapping claims are
 * reference-counted: the first claim takes the lease, the last release returns
 * it. Concurrent callers await the same in-flight claim instead of issuing a
 * second `release()` that would replace the first lease's token.
 */
export function createGpuBrokerCoopHandle(getBroker: () => GpuBroker | null): GpuBrokerCoopHandle {
  let claims = 0;
  let pendingClaim: Promise<string> | null = null;
  let leaseToken: string | undefined;

  return {
    async release(): Promise<void> {
      const broker = getBroker();
      if (!broker) {
        throw new Error("gpu-broker service is not running; cannot release the GPU");
      }
      claims += 1;
      try {
        pendingClaim ??= broker
          .release(COOP_LEASE_OWNER, COOP_LEASE_REASON)
          .then((lease) => lease.token);
        leaseToken = await pendingClaim;
      } catch (error) {
        // Do not leave a phantom claim behind if the lease never happened.
        claims -= 1;
        if (claims === 0) {
          pendingClaim = null;
          leaseToken = undefined;
        }
        throw error;
      }
    },

    async reclaim(): Promise<void> {
      if (claims === 0) {
        return;
      }
      claims -= 1;
      if (claims > 0) {
        return;
      }
      const token = leaseToken;
      pendingClaim = null;
      leaseToken = undefined;
      // `reclaim` is synchronous on the broker; the handle stays async because
      // the consumer contract is async.
      getBroker()?.reclaim(token);
    },
  };
}

/** Publish the live handle for other in-process plugins. Called from service `start()`. */
export function publishGpuBrokerHandle(handle: GpuBrokerCoopHandle): void {
  globalSlot()[GPU_BROKER_HANDLE_KEY] = handle;
}

/**
 * Remove the handle. Called from service `stop()` so a stopped broker never
 * leaves a stale handle that a consumer would call into.
 */
export function unpublishGpuBrokerHandle(handle?: GpuBrokerCoopHandle): void {
  const slot = globalSlot();
  if (handle && slot[GPU_BROKER_HANDLE_KEY] !== handle) {
    return;
  }
  delete slot[GPU_BROKER_HANDLE_KEY];
}

/** Read back the published handle (used by tests and diagnostics). */
export function readPublishedGpuBrokerHandle(): unknown {
  return globalSlot()[GPU_BROKER_HANDLE_KEY];
}
