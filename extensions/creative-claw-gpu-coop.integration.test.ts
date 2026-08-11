/**
 * Cross-plugin GPU cooperation integration test.
 *
 * Wires the REAL `gpu-broker` publish path (its actual plugin entry, its actual
 * service `start()`, its actual `GpuBroker` instance) to the REAL
 * `creative-engines` consumer (`withGpuClaim`) inside one process, and proves
 * the handoff: the op runs while the broker holds a `creative-engines` lease,
 * and the lease is returned afterwards.
 *
 * Only the SDK boundary is mocked (`definePluginEntry` returns the entry so
 * `.register(api)` can be called directly). Nothing about the broker or the
 * coop path is stubbed.
 *
 * Ollama is pointed at a closed port so `evictAllModels()` is a fast, real
 * no-op instead of evicting a developer's actually-loaded models, and
 * `dormantOverride` keeps the nvidia-smi poll loop out of the test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
  definePluginEntry: (entry: unknown) => entry,
}));

import gpuBrokerPlugin from "./gpu-broker/index.js";
import { GPU_BROKER_HANDLE_KEY } from "./gpu-broker/src/coop-handle.js";
import { clearGpuBroker, withGpuClaim } from "./creative-engines/src/gpu-coop.js";
import { readGpuBrokerHandle } from "./creative-engines/src/gpu-broker-handle.js";

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: unknown) => Promise<{ details: unknown }>;
};
type RegisteredService = {
  id: string;
  start: (ctx?: unknown) => void | Promise<void>;
  stop?: (ctx?: unknown) => void | Promise<void>;
};

function createMockApi() {
  const tools: RegisteredTool[] = [];
  const services: RegisteredService[] = [];
  return {
    tools,
    services,
    api: {
      registerTool(tool: RegisteredTool) {
        tools.push(tool);
      },
      registerService(service: RegisteredService) {
        services.push(service);
      },
      registerHook(
        _events: string | string[],
        _handler: (...args: unknown[]) => unknown,
        _opts?: { name?: string },
      ) {},
      getPluginConfig: () => ({
        // Closed port: eviction attempts fail fast and are swallowed by the
        // broker's own try/catch, so no real Ollama model is touched.
        ollamaBaseUrl: "http://127.0.0.1:1",
        dormantOverride: true,
        pollIntervalMs: 3_600_000,
        defaultLeaseHoldMs: 60_000,
      }),
    },
  };
}

async function readStatus(tools: RegisteredTool[]): Promise<{
  state: string;
  lease: { owner: string; token: string } | null;
}> {
  const status = tools.find((t) => t.name === "gpu.status");
  if (!status) throw new Error("gpu.status tool was not registered");
  const result = await status.execute("test", {});
  return JSON.parse(String(result.details)) as {
    state: string;
    lease: { owner: string; token: string } | null;
  };
}

function globalSlot(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

describe("cross-plugin GPU cooperation (real broker → real withGpuClaim)", () => {
  let mockApi: ReturnType<typeof createMockApi>;

  beforeEach(() => {
    clearGpuBroker();
    delete globalSlot()[GPU_BROKER_HANDLE_KEY];
    mockApi = createMockApi();
    gpuBrokerPlugin.register(mockApi.api as never);
  });

  afterEach(async () => {
    for (const service of mockApi.services) {
      await service.stop?.();
    }
    clearGpuBroker();
    delete globalSlot()[GPU_BROKER_HANDLE_KEY];
  });

  it("publishes no handle until the broker service starts", () => {
    // register() alone must not publish: the broker instance does not exist yet.
    expect(readGpuBrokerHandle()).toBeUndefined();
  });

  it("publishes a live handle on service start and removes it on stop", async () => {
    const service = mockApi.services.find((s) => s.id === "gpu-broker");
    expect(service).toBeDefined();

    await service?.start();
    expect(readGpuBrokerHandle()).toBeDefined();

    await service?.stop?.();
    expect(readGpuBrokerHandle()).toBeUndefined();
  });

  it("holds a creative-engines lease for the duration of a GPU-bound op, then returns it", async () => {
    const service = mockApi.services.find((s) => s.id === "gpu-broker");
    await service?.start();

    const before = await readStatus(mockApi.tools);
    expect(before.lease).toBeNull();

    let during: Awaited<ReturnType<typeof readStatus>> | undefined;
    const value = await withGpuClaim(async () => {
      during = await readStatus(mockApi.tools);
      return "op-result";
    });

    expect(value).toBe("op-result");
    // The op ran while the broker was user-claimed by creative-engines.
    expect(during?.state).toBe("user-claimed");
    expect(during?.lease?.owner).toBe("creative-engines");

    // ...and the lease was handed back afterwards.
    const after = await readStatus(mockApi.tools);
    expect(after.state).toBe("idle");
    expect(after.lease).toBeNull();
  });

  it("returns the lease even when the GPU-bound op throws", async () => {
    const service = mockApi.services.find((s) => s.id === "gpu-broker");
    await service?.start();

    await expect(
      withGpuClaim(async () => {
        throw new Error("engine exploded");
      }),
    ).rejects.toThrow(/engine exploded/);

    const after = await readStatus(mockApi.tools);
    expect(after.state).toBe("idle");
    expect(after.lease).toBeNull();
  });

  it("runs the op directly after the broker service stops (no stale handle)", async () => {
    const service = mockApi.services.find((s) => s.id === "gpu-broker");
    await service?.start();
    await service?.stop?.();

    const fn = vi.fn(async () => 7);
    await expect(withGpuClaim(fn)).resolves.toBe(7);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("reference-counts overlapping claims onto the broker's single lease", async () => {
    const service = mockApi.services.find((s) => s.id === "gpu-broker");
    await service?.start();

    const seen: Array<{ state: string; token: string | undefined }> = [];
    const claim = async () =>
      withGpuClaim(async () => {
        const status = await readStatus(mockApi.tools);
        seen.push({ state: status.state, token: status.lease?.token });
        await new Promise((resolve) => setTimeout(resolve, 5));
      });

    await Promise.all([claim(), claim()]);

    expect(seen).toHaveLength(2);
    expect(seen[0]?.state).toBe("user-claimed");
    expect(seen[1]?.state).toBe("user-claimed");
    // One lease, shared by both overlapping claims.
    expect(seen[0]?.token).toBe(seen[1]?.token);

    const after = await readStatus(mockApi.tools);
    expect(after.state).toBe("idle");
    expect(after.lease).toBeNull();
  });
});
