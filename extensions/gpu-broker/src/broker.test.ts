import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GpuBroker } from "./broker.js";
import { BrokerState } from "./types.js";

// Mock spawnSync so tests don't need real nvidia-smi
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({
    status: 0,
    error: null,
    stdout: Buffer.from("2048, 24576"),
    stderr: Buffer.from(""),
  })),
}));

// Mock fetch for Ollama API.
//
// It MUST be installed through `vi.stubGlobal`, not by assigning
// `global.fetch`. The extensions lane runs with `isolate: false`, so test files
// share a worker's globals: a raw assignment is never undone and every later
// file in that worker inherits this `vi.fn()` as its `fetch`. That is not
// theoretical — it silently disabled a real integration test:
// `creative-engines/src/media/video-understanding.integration.test.ts` probes
// Ollama at import time, got `undefined` back from this mock, and skipped
// itself with "has no model qwen2.5vl:7b" while passing when run alone. The
// lane still reported green. `vi.stubGlobal` is tracked and restored by
// `unstubGlobals`/`vi.unstubAllGlobals()`, so the mock stays inside this file.
const mockFetch = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

function mockOllamaPs(models: Array<{ name: string; size_vram: number }>) {
  mockFetch.mockImplementation((url: string) => {
    if (url.includes("/api/ps")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ models }),
      });
    }
    if (url.includes("/api/generate")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    return Promise.resolve({ ok: false });
  });
}

describe("GpuBroker", () => {
  let broker: GpuBroker;

  beforeEach(async () => {
    vi.useFakeTimers();
    // Reset the module-level spawnSync mock to its default output. Other tests
    // reassign mockReturnValue (e.g. "18000, ..."), and clearAllMocks only
    // clears call history — not the implementation — so without this reset the
    // stale return value leaks into the next test's baseline calibration.
    const { spawnSync } = await import("node:child_process");
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      error: null,
      stdout: Buffer.from("2048, 24576"),
      stderr: Buffer.from(""),
    } as unknown as ReturnType<typeof spawnSync>);
    mockOllamaPs([]);
    broker = new GpuBroker({
      pollIntervalMs: 1000,
      externalClaimThresholdMb: 5000,
      defaultLeaseHoldMs: 10000,
    });
  });

  afterEach(() => {
    broker.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("state machine transitions", () => {
    it("starts in idle state", () => {
      expect(broker.getState()).toBe(BrokerState.Idle);
    });

    it("starts and remains idle when no pressure", () => {
      broker.start();
      expect(broker.getState()).toBe(BrokerState.Idle);
    });

    it("transitions to draining then user-claimed on release", async () => {
      broker.start();
      const lease = await broker.release("test-user", "testing");
      expect(broker.getState()).toBe(BrokerState.UserClaimed);
      expect(lease.owner).toBe("test-user");
      expect(lease.token).toBeTruthy();
    });

    it("transitions back to idle on reclaim", async () => {
      broker.start();
      const lease = await broker.release("test-user");
      expect(broker.getState()).toBe(BrokerState.UserClaimed);

      const reclaimed = broker.reclaim(lease.token);
      expect(reclaimed).toBe(true);
      expect(broker.getState()).toBe(BrokerState.Idle);
    });

    it("reclaim with wrong token fails", async () => {
      broker.start();
      await broker.release("test-user");
      const reclaimed = broker.reclaim("WRONG_TOKEN");
      expect(reclaimed).toBe(false);
      expect(broker.getState()).toBe(BrokerState.UserClaimed);
    });

    it("reclaim without token reclaims any lease", async () => {
      broker.start();
      await broker.release("test-user");
      const reclaimed = broker.reclaim();
      expect(reclaimed).toBe(true);
      expect(broker.getState()).toBe(BrokerState.Idle);
    });

    it("reclaim returns false when no lease active", () => {
      broker.start();
      const reclaimed = broker.reclaim();
      expect(reclaimed).toBe(false);
    });

    it("handoff goes through draining -> user-claimed -> idle", async () => {
      broker.start();
      let peerCalled = false;
      await broker.handoff(
        "comfyui",
        async () => {
          peerCalled = true;
        },
        "image gen",
      );
      expect(peerCalled).toBe(true);
      expect(broker.getState()).toBe(BrokerState.Idle);
    });

    it("records history of transitions", async () => {
      broker.start();
      await broker.release("user1");
      broker.reclaim();

      const history = broker.getHistory();
      expect(history.length).toBeGreaterThanOrEqual(3);
      expect(history[0].from).toBe(BrokerState.Idle);
      expect(history[0].to).toBe(BrokerState.Draining);
    });
  });

  describe("agent run gate", () => {
    it("allows agent run in idle state", () => {
      expect(broker.canAgentRun()).toBe(true);
    });

    it("blocks agent run when user-claimed", async () => {
      await broker.release("user");
      expect(broker.canAgentRun()).toBe(false);
    });

    it("allows agent run after reclaim", async () => {
      await broker.release("user");
      broker.reclaim();
      expect(broker.canAgentRun()).toBe(true);
    });

    it("blocks agent run in dormant? no - dormant allows", () => {
      broker.enterDormant();
      // Dormant means cloud LLM is in use, agent CAN run (just not local GPU)
      expect(broker.canAgentRun()).toBe(true);
    });
  });

  describe("dormant mode", () => {
    it("enters dormant on override config", () => {
      const dormantBroker = new GpuBroker({ dormantOverride: true });
      dormantBroker.start();
      expect(dormantBroker.getState()).toBe(BrokerState.Dormant);
      dormantBroker.stop();
    });

    it("enters dormant via enterDormant()", () => {
      broker.start();
      broker.enterDormant("cloud model active");
      expect(broker.getState()).toBe(BrokerState.Dormant);
    });

    it("exits dormant via exitDormant()", () => {
      broker.start();
      broker.enterDormant();
      broker.exitDormant();
      expect(broker.getState()).toBe(BrokerState.Idle);
    });

    it("does not poll when dormant", () => {
      broker.enterDormant();
      broker.start();
      // snapshot should remain null since poll is skipped
      expect(broker.getState()).toBe(BrokerState.Dormant);
    });

    it("updateConfig with dormantOverride transitions to dormant", () => {
      broker.start();
      broker.updateConfig({ dormantOverride: true });
      expect(broker.getState()).toBe(BrokerState.Dormant);
    });
  });

  describe("lease expiry", () => {
    it("auto-expires lease after holdMs", async () => {
      broker.start();
      await broker.release("user", "test", 5000);
      expect(broker.getState()).toBe(BrokerState.UserClaimed);

      vi.advanceTimersByTime(5001);
      expect(broker.getState()).toBe(BrokerState.Idle);
      expect(broker.getLease()).toBeNull();
    });

    it("does not expire early", async () => {
      broker.start();
      await broker.release("user", "test", 5000);

      vi.advanceTimersByTime(3000);
      expect(broker.getState()).toBe(BrokerState.UserClaimed);
    });

    it("manual reclaim cancels expiry timer", async () => {
      broker.start();
      await broker.release("user", "test", 5000);
      broker.reclaim();

      vi.advanceTimersByTime(6000);
      // Should still be idle, not re-triggered
      expect(broker.getState()).toBe(BrokerState.Idle);
    });
  });

  describe("ghost-claim logic", () => {
    it("triggers ghost claim when external pressure exceeds threshold", async () => {
      // Set baseline to 2048 (from mock nvidia-smi)
      broker.start();
      expect(broker.getBaselineVramMb()).toBe(2048);

      // Simulate high VRAM usage by changing the spawnSync mock
      const { spawnSync } = await import("node:child_process");
      const mockedSpawn = vi.mocked(spawnSync);
      mockedSpawn.mockReturnValue({
        status: 0,
        error: null,
        stdout: Buffer.from("18000, 24576"),
        stderr: Buffer.from(""),
      } as unknown as ReturnType<typeof spawnSync>);

      // Ollama using 0 MB -> external pressure = 18000 - 2048 - 0 = 15952 > 5000
      mockOllamaPs([]);

      // Advance timer to trigger poll
      await vi.advanceTimersByTimeAsync(1001);

      expect(broker.isGhostClaimActive()).toBe(true);
      expect(broker.getState()).toBe(BrokerState.UserClaimed);
    });

    it("releases ghost claim when pressure drops below threshold/2", async () => {
      const { spawnSync } = await import("node:child_process");
      const mockedSpawn = vi.mocked(spawnSync);

      broker.start();

      // Trigger ghost claim
      mockedSpawn.mockReturnValue({
        status: 0,
        error: null,
        stdout: Buffer.from("18000, 24576"),
        stderr: Buffer.from(""),
      } as unknown as ReturnType<typeof spawnSync>);
      mockOllamaPs([]);

      await vi.advanceTimersByTimeAsync(1001);
      expect(broker.isGhostClaimActive()).toBe(true);

      // Drop pressure below threshold/2 (2500)
      // external_pressure = 3000 - 2048 - 0 = 952 < 2500
      mockedSpawn.mockReturnValue({
        status: 0,
        error: null,
        stdout: Buffer.from("3000, 24576"),
        stderr: Buffer.from(""),
      } as unknown as ReturnType<typeof spawnSync>);

      await vi.advanceTimersByTimeAsync(1001);
      expect(broker.isGhostClaimActive()).toBe(false);
      expect(broker.getState()).toBe(BrokerState.Idle);
    });

    it("accounts for Ollama footprint in pressure calculation", async () => {
      const { spawnSync } = await import("node:child_process");
      const mockedSpawn = vi.mocked(spawnSync);

      broker.start();

      // VRAM used: 10000, baseline: 2048
      // Without Ollama: pressure = 10000 - 2048 = 7952 > 5000 (would trigger)
      // With Ollama using 4000MB: pressure = 10000 - 2048 - 4000 = 3952 < 5000 (no trigger)
      mockedSpawn.mockReturnValue({
        status: 0,
        error: null,
        stdout: Buffer.from("10000, 24576"),
        stderr: Buffer.from(""),
      } as unknown as ReturnType<typeof spawnSync>);

      // Ollama has a model using 4GB VRAM
      mockOllamaPs([{ name: "llama3:70b", size_vram: 4000 * 1024 * 1024 }]);

      await vi.advanceTimersByTimeAsync(1001);
      expect(broker.isGhostClaimActive()).toBe(false);
      expect(broker.getState()).toBe(BrokerState.Idle);
    });
  });

  describe("GPU snapshot reading", () => {
    it("reads and parses nvidia-smi output", () => {
      const snapshot = broker.readGpuSnapshot();
      expect(snapshot).not.toBeNull();
      expect(snapshot!.usedMb).toBe(2048);
      expect(snapshot!.totalMb).toBe(24576);
    });

    it("returns null when nvidia-smi fails", async () => {
      const { spawnSync } = await import("node:child_process");
      const mockedSpawn = vi.mocked(spawnSync);
      mockedSpawn.mockReturnValue({
        status: 1,
        error: new Error("not found"),
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
      } as unknown as ReturnType<typeof spawnSync>);

      const snapshot = broker.readGpuSnapshot();
      expect(snapshot).toBeNull();
    });
  });

  describe("Ollama interaction", () => {
    it("gets resident models", async () => {
      mockOllamaPs([
        { name: "llama3:8b", size_vram: 4000000000 },
        { name: "mistral:7b", size_vram: 3500000000 },
      ]);

      const models = await broker.getResidentModels();
      expect(models).toEqual(["llama3:8b", "mistral:7b"]);
    });

    it("evicts models on release", async () => {
      mockOllamaPs([{ name: "llama3:8b", size_vram: 4000000000 }]);
      await broker.release("user");

      // Verify eviction was called
      expect(mockFetch).toHaveBeenCalledWith(
        "http://127.0.0.1:11434/api/generate",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ model: "llama3:8b", keep_alive: 0 }),
        }),
      );
    });

    it("handles Ollama API failure gracefully", async () => {
      mockFetch.mockRejectedValue(new Error("connection refused"));
      const models = await broker.getResidentModels();
      expect(models).toEqual([]);
    });
  });
});
