import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GpuBroker } from "./broker.js";
import { BrokerState } from "./types.js";
import { registerWarmupRecalibration } from "./warmup.js";

// Mock spawnSync so tests don't need real nvidia-smi.
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({
    status: 0,
    error: null,
    stdout: Buffer.from("2048, 24576"),
    stderr: Buffer.from(""),
  })),
}));

// Installed via `vi.stubGlobal` so it is restored at the end of this file: the
// extensions lane runs with `isolate: false`, so a raw `global.fetch = …` leaks
// the mock into every later test file in the same worker (it silently skipped
// the creative-engines video-understanding integration suite). See the longer
// note in broker.test.ts.
const mockFetch = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

/** Point /api/ps at a fixed model list (0 models => 0 MB footprint). */
function mockOllamaPs(models: Array<{ name: string; size_vram: number }>) {
  mockFetch.mockImplementation((url: string) => {
    if (url.includes("/api/ps")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ models }) });
    }
    if (url.includes("/api/generate")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    return Promise.resolve({ ok: false });
  });
}

/** Reset the spawnSync mock to a given "usedMb, totalMb" reading. */
async function setGpuUsed(used: number, total = 24576) {
  const { spawnSync } = await import("node:child_process");
  vi.mocked(spawnSync).mockReturnValue({
    status: 0,
    error: null,
    stdout: Buffer.from(`${used}, ${total}`),
    stderr: Buffer.from(""),
  } as unknown as ReturnType<typeof spawnSync>);
}

describe("registerWarmupRecalibration", () => {
  let broker: GpuBroker;

  beforeEach(async () => {
    vi.useFakeTimers();
    await setGpuUsed(2048);
    mockOllamaPs([]);
    broker = new GpuBroker({ pollIntervalMs: 1000, externalClaimThresholdMb: 5000 });
  });

  afterEach(() => {
    broker.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("recalibrates via the explicit model-warmup seam so the warmed footprint is not a ghost claim", async () => {
    let warmHandler: (() => void) | undefined;
    const api = {
      registerModelWarmupHook(handler: () => void) {
        warmHandler = handler;
      },
    };

    registerWarmupRecalibration(api, () => broker);

    broker.start();
    expect(broker.getBaselineVramMb()).toBe(2048);

    const calibrateSpy = vi.spyOn(broker, "calibrateBaseline");

    // A deliberate warmup loads a ~10GB model (baseline was measured before).
    await setGpuUsed(12000);

    // Simulate the host firing its model-warm signal.
    warmHandler?.();

    expect(calibrateSpy).toHaveBeenCalledTimes(1);
    // The warmed footprint is now folded into the baseline.
    expect(broker.getBaselineVramMb()).toBe(12000);

    // Next poll: used(12000) - baseline(12000) - ollama(0) = 0 < threshold.
    await vi.advanceTimersByTimeAsync(1001);
    expect(broker.isGhostClaimActive()).toBe(false);
    expect(broker.getState()).toBe(BrokerState.Idle);

    calibrateSpy.mockRestore();
  });

  it("without recalibration the same warmed footprint WOULD trigger a ghost claim (control)", async () => {
    broker.start();
    expect(broker.getBaselineVramMb()).toBe(2048);

    // Warm a ~10GB model but never recalibrate the baseline.
    await setGpuUsed(12000);

    await vi.advanceTimersByTimeAsync(1001);
    // external = 12000 - 2048 - 0 = 9952 > 5000 => mistaken for external pressure.
    expect(broker.isGhostClaimActive()).toBe(true);
    expect(broker.getState()).toBe(BrokerState.UserClaimed);
  });

  it("falls back to recalibrating once per session on agent bootstrap when no warm seam exists", async () => {
    let runStartHandler: (() => void) | undefined;
    const api = {
      registerHook(
        events: string | string[],
        handler: () => void,
        opts?: { name?: string },
      ) {
        // Mirror the host contract: a hook without a name is rejected.
        if (!opts?.name?.trim()) throw new Error("hook registration missing name");
        if (events === "agent:bootstrap") runStartHandler = handler;
      },
    };

    registerWarmupRecalibration(api, () => broker);
    expect(runStartHandler).toBeTypeOf("function");

    broker.start();
    const calibrateSpy = vi.spyOn(broker, "calibrateBaseline");

    await setGpuUsed(12000);

    // First run-start recalibrates.
    runStartHandler?.();
    expect(calibrateSpy).toHaveBeenCalledTimes(1);
    expect(broker.getBaselineVramMb()).toBe(12000);

    // Subsequent run-starts do not recalibrate again this session.
    runStartHandler?.();
    runStartHandler?.();
    expect(calibrateSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1001);
    expect(broker.isGhostClaimActive()).toBe(false);

    calibrateSpy.mockRestore();
  });

  it("prefers the warm seam over the run-start fallback when both are available", () => {
    let warmRegistered = false;
    let hookRegistered = false;
    const api = {
      registerModelWarmupHook() {
        warmRegistered = true;
      },
      registerHook() {
        hookRegistered = true;
      },
    };

    registerWarmupRecalibration(api, () => broker);
    expect(warmRegistered).toBe(true);
    // The run-start fallback is not wired when an explicit warm seam exists.
    expect(hookRegistered).toBe(false);
  });

  it("no-ops honestly when the api exposes no warm or hook seam", () => {
    expect(() => registerWarmupRecalibration({}, () => broker)).not.toThrow();
  });
});
