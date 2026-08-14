/**
 * GPU broker cooperation — manages GPU claims for model-heavy operations.
 *
 * When an operation requires exclusive GPU access (e.g., model inference alongside
 * the C++ engines), this helper releases the GPU claim before the op and reclaims after.
 * Pure C++ engine operations skip GPU broker entirely since they manage their own CUDA/Metal.
 *
 * RESOLUTION IS LAZY. The broker handle is published by the `gpu-broker`
 * plugin's service `start()`, and plugin `register()` order is not guaranteed,
 * so resolving at register time can (and did) capture nothing forever. The
 * handle is therefore looked up at the moment `withGpuClaim` is called.
 */

import { readGpuBrokerHandle, type GpuBrokerHandle } from "./gpu-broker-handle.js";

type GpuBroker = GpuBrokerHandle;

/** Explicit override, set by tests or an embedder; takes precedence over the global. */
let brokerOverride: GpuBroker | undefined;

/**
 * Set the GPU broker instance explicitly. This wins over the cross-plugin
 * `globalThis` handle, so tests and embedders can inject a stub.
 */
export function setGpuBroker(b: GpuBroker): void {
  brokerOverride = b;
}

/** Drop the explicit override and fall back to the published cross-plugin handle. */
export function clearGpuBroker(): void {
  brokerOverride = undefined;
}

/** Resolve the broker at call time: explicit override first, then the published handle. */
function resolveGpuBroker(): GpuBroker | undefined {
  return brokerOverride ?? readGpuBrokerHandle();
}

/**
 * Execute a function that needs exclusive GPU access.
 * Releases the GPU claim before executing, reclaims after completion or error.
 *
 * If no broker is available, the function executes directly.
 *
 * If `release()` fails, the op does NOT run and no reclaim is attempted — there
 * is no claim to hand back, and running the op anyway would race whatever still
 * holds the GPU. If the op throws, `reclaim()` still runs via `finally`.
 */
export async function withGpuClaim<T>(fn: () => Promise<T>): Promise<T> {
  const broker = resolveGpuBroker();
  if (!broker) {
    return fn();
  }

  await broker.release();
  try {
    return await fn();
  } finally {
    await broker.reclaim();
  }
}

/**
 * For pure C++ engine ops that manage their own GPU context.
 * No broker interaction needed — just execute directly.
 */
export async function withoutGpuClaim<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}
