// Tests for the agent-run gate hook handler.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GpuBroker, type BrokerLogger, type SnapshotGpuFn } from "./broker.js";
import { createRunGate } from "./run-gate.js";
import type { GpuSnapshot } from "./types.js";

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

describe("createRunGate", () => {
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

  it("permits when broker state is idle", () => {
    broker = new GpuBroker({ logger, snapshotFn });
    const gate = createRunGate(broker, logger);

    const result = gate();
    expect(result).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("permits when broker state is agent-active", () => {
    broker = new GpuBroker({ logger, snapshotFn });
    broker.enterAgentActive();
    const gate = createRunGate(broker, logger);

    const result = gate();
    expect(result).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("permits when broker state is dormant", () => {
    broker = new GpuBroker({ config: { dormant: true }, logger, snapshotFn });
    const gate = createRunGate(broker, logger);

    const result = gate();
    expect(result).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("denies (logs warning) when state is user-claimed", () => {
    broker = new GpuBroker({ logger, snapshotFn });
    broker.claim();
    const gate = createRunGate(broker, logger);

    const result = gate();
    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("agent run gate denied"));
  });

  it("denies (logs warning) when state is draining via ghost-claim", async () => {
    broker = new GpuBroker({
      config: { externalClaimThresholdMb: 512 },
      logger,
      snapshotFn,
    });
    await broker.init();

    // Trigger ghost-claim
    (snapshotFn as ReturnType<typeof vi.fn>).mockResolvedValue(
      createMockSnapshot({ usedMb: 2048 + 600 }),
    );
    await broker.poll();
    expect(broker.getCurrentState()).toBe("user-claimed");

    const gate = createRunGate(broker, logger);
    const result = gate();
    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("agent run gate denied"));
  });

  it("always permits in dormant mode regardless of config", () => {
    broker = new GpuBroker({ config: { dormant: true }, logger, snapshotFn });
    const gate = createRunGate(broker, logger);

    // Call multiple times to confirm consistency
    expect(gate()).toBeUndefined();
    expect(gate()).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("transitions to agent-active on first permitted call from idle", () => {
    broker = new GpuBroker({ logger, snapshotFn });
    expect(broker.getCurrentState()).toBe("idle");

    const gate = createRunGate(broker, logger);
    gate();

    expect(broker.getCurrentState()).toBe("agent-active");
  });

  it("does not transition from agent-active to agent-active on repeated calls", () => {
    broker = new GpuBroker({ logger, snapshotFn });
    broker.enterAgentActive();
    const gate = createRunGate(broker, logger);

    gate();
    expect(broker.getCurrentState()).toBe("agent-active");
  });
});
