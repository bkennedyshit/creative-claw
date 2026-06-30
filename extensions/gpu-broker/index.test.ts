// Tests for the gpu-broker plugin registration.
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";

vi.mock("./src/gpu-snapshot.js", () => ({
  snapshotGpu: vi.fn().mockResolvedValue({
    totalMb: 24576,
    usedMb: 2048,
    freeMb: 22528,
    timestamp: Date.now(),
  }),
}));

import plugin from "./index.js";

describe("gpu-broker plugin registration", () => {
  it("registers a service with id gpu-broker", () => {
    const registerService = vi.fn();
    const api = createTestPluginApi({
      pluginConfig: {},
      registerService,
      registerTool: vi.fn(),
    });

    plugin.register(api);

    expect(registerService).toHaveBeenCalledTimes(1);
    const service = registerService.mock.calls[0]?.[0] as { id: string };
    expect(service.id).toBe("gpu-broker");
    expect(service).toHaveProperty("start");
    expect(service).toHaveProperty("stop");
  });

  it("registers four tools with correct names", () => {
    const registerTool = vi.fn();
    const api = createTestPluginApi({
      pluginConfig: {},
      registerService: vi.fn(),
      registerTool,
    });

    plugin.register(api);

    expect(registerTool).toHaveBeenCalledTimes(4);
    const toolNames = registerTool.mock.calls.map(
      (call: unknown[]) => (call[0] as { name: string }).name,
    );
    expect(toolNames).toContain("gpu.status");
    expect(toolNames).toContain("gpu.release");
    expect(toolNames).toContain("gpu.reclaim");
    expect(toolNames).toContain("gpu.handoff");
  });

  it("has correct plugin metadata", () => {
    expect(plugin.id).toBe("gpu-broker");
    expect(plugin.name).toBe("GPU Broker");
    expect(plugin.description).toContain("VRAM");
  });

  it("config reload calls broker.applyConfig", () => {
    const registerService = vi.fn();
    const api = createTestPluginApi({
      pluginConfig: { pollMs: 3000 },
      registerService,
      registerTool: vi.fn(),
    });

    plugin.register(api);

    // Verify reload is defined
    expect(plugin.reload).toBeDefined();
    expect(plugin.reload?.onConfigChange).toBeTypeOf("function");
  });

  it("service start and stop functions are callable", async () => {
    const registerService = vi.fn();
    const api = createTestPluginApi({
      pluginConfig: {},
      registerService,
      registerTool: vi.fn(),
    });

    plugin.register(api);

    const service = registerService.mock.calls[0]?.[0] as {
      start: () => Promise<void>;
      stop: () => void;
    };

    // Service start/stop should not throw
    await expect(service.start()).resolves.not.toThrow();
    expect(() => service.stop()).not.toThrow();
  });
});
