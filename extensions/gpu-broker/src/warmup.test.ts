// Tests for warmup recalibration.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GpuBroker, type BrokerLogger, type SnapshotGpuFn } from "./broker.js";
import type { GpuSnapshot } from "./types.js";
import { recalibrateAfterWarmup } from "./warmup.js";

function createMockLogger(): BrokerLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createMockSnapshot(overrides: Partial<GpuSnapshot> = {}): GpuSnapshot {
  return {
    totalMb: 24576,
    usedMb: 2048,
    freeMb: 22528,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("recalibrateAfterWarmup", () => {
  let logger: BrokerLogger;
  let snapshotFn: SnapshotGpuFn;
  let broker: GpuBroker;

  beforeEach(() => {
    vi.useFakeTimers();
    logger = createMockLogger();
    snapshotFn = vi.fn<SnapshotGpuFn>().mockResolvedValue(createMockSnapshot());
  });

  afterEach(() => {
    broker.shutdown();
    vi.useRealTimers();
  });

  it("updates baseline to include warmed model VRAM", async () => {
    broker = new GpuBroker({ logger, snapshotFn });
    await broker.init();
    expect(broker.getState().baselineUsedMb).toBe(2048);

    // Simulate a model being loaded (VRAM goes up by 3000MB)
    (snapshotFn as ReturnType<typeof vi.fn>).mockResolvedValue(
      createMockSnapshot({ usedMb: 5048 }),
    );

    await recalibrateAfterWarmup(broker, logger);
    expect(broker.getState().baselineUsedMb).toBe(5048);
  });

  it("recalibrated baseline does not trigger ghost-claim", async () => {
    broker = new GpuBroker({
      config: { externalClaimThresholdMb: 512 },
      logger,
      snapshotFn,
    });
    await broker.init();
    expect(broker.getState().baselineUsedMb).toBe(2048);

    // Model loads, VRAM increases by 3000MB
    (snapshotFn as ReturnType<typeof vi.fn>).mockResolvedValue(
      createMockSnapshot({ usedMb: 5048 }),
    );

    // Recalibrate so the baseline absorbs the model
    await recalibrateAfterWarmup(broker, logger);
    expect(broker.getState().baselineUsedMb).toBe(5048);

    // Now poll with usage at the model's level - should NOT ghost-claim
    await broker.poll();
    expect(broker.getCurrentState()).toBe("idle");
    expect(broker.getState().ghostClaimed).toBe(false);
  });

  it("ghost-claim still triggers for usage above recalibrated baseline + threshold", async () => {
    broker = new GpuBroker({
      config: { externalClaimThresholdMb: 512 },
      logger,
      snapshotFn,
    });
    await broker.init();

    // Model loads to 5048MB
    (snapshotFn as ReturnType<typeof vi.fn>).mockResolvedValue(
      createMockSnapshot({ usedMb: 5048 }),
    );
    await recalibrateAfterWarmup(broker, logger);

    // External pressure above new baseline by 600MB (> 512 threshold)
    (snapshotFn as ReturnType<typeof vi.fn>).mockResolvedValue(
      createMockSnapshot({ usedMb: 5048 + 600 }),
    );
    await broker.poll();
    expect(broker.getCurrentState()).toBe("user-claimed");
    expect(broker.getState().ghostClaimed).toBe(true);
  });

  it("logs recalibration messages", async () => {
    broker = new GpuBroker({ logger, snapshotFn });
    await broker.init();

    await recalibrateAfterWarmup(broker, logger);

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("recalibrating baseline after warmup"),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("warmup recalibration complete"),
    );
  });
});
