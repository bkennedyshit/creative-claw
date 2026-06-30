// Tests for honest degradation: broker operates gracefully when GPU sources are unavailable.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GpuBroker, type BrokerLogger, type SnapshotGpuFn } from "./broker.js";

function createMockLogger(): BrokerLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("honest degradation", () => {
  let logger: BrokerLogger;
  let snapshotFn: SnapshotGpuFn;
  let broker: GpuBroker;

  beforeEach(() => {
    vi.useFakeTimers();
    logger = createMockLogger();
  });

  afterEach(() => {
    broker.shutdown();
    vi.useRealTimers();
  });

  it("does not crash when snapshotGpu returns null (no nvidia-smi, no Ollama)", async () => {
    snapshotFn = vi.fn<SnapshotGpuFn>().mockResolvedValue(null);
    broker = new GpuBroker({ logger, snapshotFn });

    // init should not throw even with null snapshots
    await expect(broker.init()).resolves.not.toThrow();
    expect(broker.getCurrentState()).toBe("idle");
  });

  it("poll does not crash when snapshot returns null", async () => {
    snapshotFn = vi.fn<SnapshotGpuFn>().mockResolvedValue(null);
    broker = new GpuBroker({ logger, snapshotFn });
    await broker.init();

    // Repeated polls should be safe
    await expect(broker.poll()).resolves.not.toThrow();
    await expect(broker.poll()).resolves.not.toThrow();
    expect(broker.getCurrentState()).toBe("idle");
  });

  it("canAgentRun still returns allowed when snapshot is null", async () => {
    snapshotFn = vi.fn<SnapshotGpuFn>().mockResolvedValue(null);
    broker = new GpuBroker({ logger, snapshotFn });
    await broker.init();

    const result = broker.canAgentRun();
    expect(result.allowed).toBe(true);
  });

  it("getState reports null lastSnapshot when no GPU data available", async () => {
    snapshotFn = vi.fn<SnapshotGpuFn>().mockResolvedValue(null);
    broker = new GpuBroker({ logger, snapshotFn });
    await broker.init();

    const state = broker.getState();
    expect(state.lastSnapshot).toBeNull();
    expect(state.baselineUsedMb).toBe(0);
  });

  it("claim and release still work without GPU data", async () => {
    snapshotFn = vi.fn<SnapshotGpuFn>().mockResolvedValue(null);
    broker = new GpuBroker({ logger, snapshotFn });
    await broker.init();

    const token = broker.claim(5000);
    expect(token).not.toBeNull();
    expect(broker.getCurrentState()).toBe("user-claimed");

    const released = broker.release(token!);
    expect(released).toBe(true);
    expect(broker.getCurrentState()).toBe("idle");
  });

  it("dormant mode works regardless of GPU availability", async () => {
    snapshotFn = vi.fn<SnapshotGpuFn>().mockResolvedValue(null);
    broker = new GpuBroker({
      config: { dormant: true },
      logger,
      snapshotFn,
    });
    await broker.init();

    expect(broker.getCurrentState()).toBe("dormant");
    expect(broker.canAgentRun().allowed).toBe(true);
    expect(snapshotFn).not.toHaveBeenCalled();
  });

  it("ghost-claim does not trigger when snapshots are null", async () => {
    snapshotFn = vi.fn<SnapshotGpuFn>().mockResolvedValue(null);
    broker = new GpuBroker({
      config: { externalClaimThresholdMb: 512 },
      logger,
      snapshotFn,
    });
    await broker.init();

    await broker.poll();
    expect(broker.getCurrentState()).toBe("idle");
    expect(broker.getState().ghostClaimed).toBe(false);
  });

  it("transitions config from dormant=true to dormant=false gracefully with null snapshots", async () => {
    snapshotFn = vi.fn<SnapshotGpuFn>().mockResolvedValue(null);
    broker = new GpuBroker({
      config: { dormant: true },
      logger,
      snapshotFn,
    });
    await broker.init();
    expect(broker.getCurrentState()).toBe("dormant");

    broker.applyConfig({ dormant: false });
    expect(broker.getCurrentState()).toBe("idle");

    // Poll still safe
    await expect(broker.poll()).resolves.not.toThrow();
  });
});
