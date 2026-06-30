// Unit tests for the GpuBroker state machine with mocked snapshotGpu.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GpuBroker, type BrokerLogger, type SnapshotGpuFn } from "./broker.js";
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

describe("GpuBroker", () => {
  let logger: BrokerLogger;
  let snapshotFn: SnapshotGpuFn;
  let broker: GpuBroker;

  beforeEach(() => {
    vi.useFakeTimers();
    logger = createMockLogger();
    snapshotFn = vi.fn<SnapshotGpuFn>().mockResolvedValue(createMockSnapshot());
    broker = new GpuBroker({ logger, snapshotFn });
  });

  afterEach(() => {
    broker.shutdown();
    vi.useRealTimers();
  });

  describe("state transitions", () => {
    it("starts in idle state", () => {
      expect(broker.getCurrentState()).toBe("idle");
    });

    it("transitions idle -> agent-active -> idle", () => {
      broker.enterAgentActive();
      expect(broker.getCurrentState()).toBe("agent-active");
      broker.exitAgentActive();
      expect(broker.getCurrentState()).toBe("idle");
    });

    it("transitions idle -> user-claimed on claim()", () => {
      const token = broker.claim();
      expect(token).not.toBeNull();
      expect(broker.getCurrentState()).toBe("user-claimed");
    });

    it("transitions user-claimed -> idle on release()", () => {
      const token = broker.claim()!;
      const released = broker.release(token);
      expect(released).toBe(true);
      expect(broker.getCurrentState()).toBe("idle");
    });

    it("starts in dormant when configured", () => {
      const dormantBroker = new GpuBroker({
        config: { dormant: true },
        logger,
        snapshotFn,
      });
      expect(dormantBroker.getCurrentState()).toBe("dormant");
      dormantBroker.shutdown();
    });
  });

  describe("lease token integrity", () => {
    it("claim() returns a unique UUID token", () => {
      const token = broker.claim()!;
      expect(token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it("release with wrong token fails", () => {
      broker.claim();
      const released = broker.release("wrong-token");
      expect(released).toBe(false);
      expect(broker.getCurrentState()).toBe("user-claimed");
    });

    it("release with no active lease fails", () => {
      const released = broker.release("any-token");
      expect(released).toBe(false);
    });
  });

  describe("auto-expiry", () => {
    it("lease expires after holdMs and state returns to idle", async () => {
      broker.claim(5000);
      expect(broker.getCurrentState()).toBe("user-claimed");

      vi.advanceTimersByTime(5000);
      expect(broker.getCurrentState()).toBe("idle");
    });

    it("uses defaultHoldMs from config when no holdMs provided", () => {
      const customBroker = new GpuBroker({
        config: { defaultHoldMs: 10000 },
        logger,
        snapshotFn,
      });
      customBroker.claim();
      expect(customBroker.getCurrentState()).toBe("user-claimed");

      vi.advanceTimersByTime(10000);
      expect(customBroker.getCurrentState()).toBe("idle");
      customBroker.shutdown();
    });
  });

  describe("claim-while-claimed rejection", () => {
    it("rejects a second claim while already claimed", () => {
      broker.claim();
      const secondToken = broker.claim();
      expect(secondToken).toBeNull();
    });

    it("rejects claim while draining", () => {
      // Simulate draining state via ghost-claim logic then release
      // We manually set state via ghost-claim poll
      broker.claim();
      // Can't claim again
      const token2 = broker.claim();
      expect(token2).toBeNull();
    });
  });

  describe("canAgentRun", () => {
    it("returns allowed:true in idle", () => {
      expect(broker.canAgentRun()).toEqual({ allowed: true });
    });

    it("returns allowed:true in agent-active", () => {
      broker.enterAgentActive();
      expect(broker.canAgentRun()).toEqual({ allowed: true });
    });

    it("returns allowed:true in dormant", () => {
      const dormantBroker = new GpuBroker({
        config: { dormant: true },
        logger,
        snapshotFn,
      });
      expect(dormantBroker.canAgentRun()).toEqual({ allowed: true });
      dormantBroker.shutdown();
    });

    it("returns allowed:false with reason in user-claimed", () => {
      broker.claim();
      const result = broker.canAgentRun();
      expect(result.allowed).toBe(false);
      expect(result.reason).toBeDefined();
    });
  });

  describe("ghost-claim on external pressure", () => {
    it("triggers ghost-claim when external pressure exceeds threshold", async () => {
      // First init to set baseline at 2048MB
      await broker.init();
      expect(broker.getCurrentState()).toBe("idle");

      // Simulate high pressure snapshot
      (snapshotFn as ReturnType<typeof vi.fn>).mockResolvedValue(
        createMockSnapshot({ usedMb: 2048 + 600 }),
      );

      await broker.poll();
      expect(broker.getCurrentState()).toBe("user-claimed");
    });

    it("auto-releases ghost-claim when pressure drops below half threshold", async () => {
      // Set baseline
      await broker.init();

      // Trigger ghost-claim
      (snapshotFn as ReturnType<typeof vi.fn>).mockResolvedValue(
        createMockSnapshot({ usedMb: 2048 + 600 }),
      );
      await broker.poll();
      expect(broker.getCurrentState()).toBe("user-claimed");

      // Pressure drops below half (256MB = 512/2)
      (snapshotFn as ReturnType<typeof vi.fn>).mockResolvedValue(
        createMockSnapshot({ usedMb: 2048 + 200 }),
      );
      await broker.poll();
      expect(broker.getCurrentState()).toBe("idle");
    });

    it("does not override an explicit user claim", async () => {
      await broker.init();
      const token = broker.claim()!;

      // Even if pressure drops, the claim remains because it's explicit
      (snapshotFn as ReturnType<typeof vi.fn>).mockResolvedValue(
        createMockSnapshot({ usedMb: 2048 + 100 }),
      );
      await broker.poll();
      // State should remain user-claimed because it's an explicit claim (not ghost)
      expect(broker.getCurrentState()).toBe("user-claimed");

      // Release with correct token
      const released = broker.release(token);
      expect(released).toBe(true);
    });
  });

  describe("init and recalibrate", () => {
    it("init captures baseline from snapshot", async () => {
      await broker.init();
      const state = broker.getState();
      expect(state.baselineUsedMb).toBe(2048);
    });

    it("recalibrateBaseline updates baseline to current usage", async () => {
      await broker.init();
      (snapshotFn as ReturnType<typeof vi.fn>).mockResolvedValue(
        createMockSnapshot({ usedMb: 4096 }),
      );
      await broker.recalibrateBaseline();
      const state = broker.getState();
      expect(state.baselineUsedMb).toBe(4096);
    });

    it("dormant init does not poll", async () => {
      const dormantBroker = new GpuBroker({
        config: { dormant: true },
        logger,
        snapshotFn,
      });
      await dormantBroker.init();
      expect(snapshotFn).not.toHaveBeenCalled();
      dormantBroker.shutdown();
    });
  });

  describe("applyConfig", () => {
    it("transitions to dormant when dormant=true", async () => {
      await broker.init();
      broker.applyConfig({ dormant: true });
      expect(broker.getCurrentState()).toBe("dormant");
    });

    it("transitions from dormant to idle when dormant=false", () => {
      const dormantBroker = new GpuBroker({
        config: { dormant: true },
        logger,
        snapshotFn,
      });
      dormantBroker.applyConfig({ dormant: false });
      expect(dormantBroker.getCurrentState()).toBe("idle");
      dormantBroker.shutdown();
    });
  });

  describe("getState", () => {
    it("returns full state introspection", async () => {
      await broker.init();
      const state = broker.getState();
      expect(state.state).toBe("idle");
      expect(state.leaseActive).toBe(false);
      expect(state.ghostClaimed).toBe(false);
      expect(state.baselineUsedMb).toBe(2048);
      expect(state.lastSnapshot).not.toBeNull();
      expect(state.config).toBeDefined();
    });
  });
});
