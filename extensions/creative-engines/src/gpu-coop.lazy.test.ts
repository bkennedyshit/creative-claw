/**
 * gpu-coop resolution semantics: the broker handle is resolved LAZILY at
 * `withGpuClaim` call time, so a handle published AFTER this module (and after
 * the plugin's register()) still engages. The explicit `setGpuBroker` override
 * keeps working and wins over the published handle.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { clearGpuBroker, setGpuBroker, withGpuClaim } from "./gpu-coop.js";
import { GPU_BROKER_HANDLE_KEY, readGpuBrokerHandle } from "./gpu-broker-handle.js";

function slot(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

describe("gpu-coop lazy resolution", () => {
  beforeEach(() => {
    clearGpuBroker();
    delete slot()[GPU_BROKER_HANDLE_KEY];
  });

  afterEach(() => {
    clearGpuBroker();
    delete slot()[GPU_BROKER_HANDLE_KEY];
  });

  it("picks up a handle published after module load", async () => {
    const order: string[] = [];
    // Nothing published yet: runs directly.
    await withGpuClaim(async () => void order.push("first-run"));
    expect(order).toEqual(["first-run"]);

    slot()[GPU_BROKER_HANDLE_KEY] = {
      release: async () => void order.push("release"),
      reclaim: async () => void order.push("reclaim"),
    };

    await withGpuClaim(async () => void order.push("second-run"));
    expect(order).toEqual(["first-run", "release", "second-run", "reclaim"]);
  });

  it("ignores a malformed published handle instead of throwing", async () => {
    slot()[GPU_BROKER_HANDLE_KEY] = { release: "not-a-function" };
    expect(readGpuBrokerHandle()).toBeUndefined();
    await expect(withGpuClaim(async () => "ok")).resolves.toBe("ok");
  });

  it("prefers an explicit setGpuBroker override over the published handle", async () => {
    const published = { release: vi.fn(async () => {}), reclaim: vi.fn(async () => {}) };
    const override = { release: vi.fn(async () => {}), reclaim: vi.fn(async () => {}) };
    slot()[GPU_BROKER_HANDLE_KEY] = published;
    setGpuBroker(override);

    await withGpuClaim(async () => "done");

    expect(override.release).toHaveBeenCalledTimes(1);
    expect(override.reclaim).toHaveBeenCalledTimes(1);
    expect(published.release).not.toHaveBeenCalled();
  });

  it("does not run the op and does not reclaim when release() fails", async () => {
    const reclaim = vi.fn(async () => {});
    const fn = vi.fn(async () => "never");
    setGpuBroker({
      release: async () => {
        throw new Error("cannot evict");
      },
      reclaim,
    });

    await expect(withGpuClaim(fn)).rejects.toThrow(/cannot evict/);
    expect(fn).not.toHaveBeenCalled();
    expect(reclaim).not.toHaveBeenCalled();
  });
});
