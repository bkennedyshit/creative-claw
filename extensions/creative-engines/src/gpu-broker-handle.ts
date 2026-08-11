/**
 * Cross-plugin GPU cooperation handle — consumer side.
 *
 * WHY A `globalThis` REGISTRY (deliberate, documented escape hatch):
 * This plugin needs the LIVE `release`/`reclaim` functions that close over the
 * `gpu-broker` plugin's running broker instance. No host seam can carry a
 * function:
 *   - Run context (`api.setRunContext` / `api.getRunContext`,
 *     `src/plugins/types.ts:2599-2600`) is typed `PluginJsonValue`
 *     (`src/plugins/host-hook-json.ts`) — JSON only, depth/node validated.
 *     Functions are stripped/rejected, so the previous run-context transport
 *     could never have worked.
 *   - `api.registerService` (`src/plugins/types.ts:2697`) is write-only and
 *     `OpenClawPluginApi` exposes no service lookup, so this plugin cannot ask
 *     the host for the broker's live object.
 * Both plugins load in the same gateway process, so a well-known `globalThis`
 * slot is the only working transport. The publisher copy of this key lives in
 * `extensions/gpu-broker/src/coop-handle.ts` — the two strings MUST stay
 * identical.
 */

/** Well-known global slot shared with `extensions/gpu-broker`. */
export const GPU_BROKER_HANDLE_KEY = "__creativeClawGpuBroker__";

/** Live handle contract: release the GPU before an op, reclaim it after. */
export type GpuBrokerHandle = {
  release: () => Promise<void>;
  reclaim: () => Promise<void>;
};

/**
 * Read the published handle, structurally validating it before use. Returns
 * `undefined` when the broker plugin is absent or its service is not running,
 * which callers treat as "no cooperation needed".
 */
export function readGpuBrokerHandle(): GpuBrokerHandle | undefined {
  const value = (globalThis as unknown as Record<string, unknown>)[GPU_BROKER_HANDLE_KEY];
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<GpuBrokerHandle>;
  if (typeof candidate.release !== "function" || typeof candidate.reclaim !== "function") {
    return undefined;
  }
  return candidate as GpuBrokerHandle;
}
