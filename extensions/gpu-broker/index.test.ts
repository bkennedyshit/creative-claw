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
      registerHttpRoute: vi.fn(),
      registerCli: vi.fn(),
      registerControlUiDescriptor: vi.fn(),
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
      registerHttpRoute: vi.fn(),
      registerCli: vi.fn(),
      registerControlUiDescriptor: vi.fn(),
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

  it("does not define a reload.onConfigChange (config changes require gateway restart)", () => {
    expect(plugin.reload).toBeUndefined();
  });

  it("service start and stop functions are callable", async () => {
    const registerService = vi.fn();
    const api = createTestPluginApi({
      pluginConfig: {},
      registerService,
      registerTool: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerCli: vi.fn(),
      registerControlUiDescriptor: vi.fn(),
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

  it("registers the before_model_resolve hook via api.on()", () => {
    const on = vi.fn();
    const api = createTestPluginApi({
      pluginConfig: {},
      registerService: vi.fn(),
      registerTool: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerCli: vi.fn(),
      registerControlUiDescriptor: vi.fn(),
      on,
    });

    plugin.register(api);

    expect(on).toHaveBeenCalledTimes(1);
    expect(on).toHaveBeenCalledWith("before_model_resolve", expect.any(Function));
  });

  it("registers an HTTP route at /gpu/state", () => {
    const registerHttpRoute = vi.fn();
    const api = createTestPluginApi({
      pluginConfig: {},
      registerService: vi.fn(),
      registerTool: vi.fn(),
      registerHttpRoute,
      registerCli: vi.fn(),
      registerControlUiDescriptor: vi.fn(),
    });

    plugin.register(api);

    expect(registerHttpRoute).toHaveBeenCalledTimes(1);
    const routeParams = registerHttpRoute.mock.calls[0]?.[0] as { path: string; auth: string };
    expect(routeParams.path).toBe("/gpu/state");
    expect(routeParams.auth).toBe("gateway");
    expect(routeParams).toHaveProperty("handler");
  });

  it("registers a CLI command with gpu parent path", () => {
    const registerCli = vi.fn();
    const api = createTestPluginApi({
      pluginConfig: {},
      registerService: vi.fn(),
      registerTool: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerCli,
      registerControlUiDescriptor: vi.fn(),
    });

    plugin.register(api);

    expect(registerCli).toHaveBeenCalledTimes(1);
    const args = registerCli.mock.calls[0] as [unknown, { parentPath: string[] }];
    expect(args[1].parentPath).toEqual(["gpu"]);
  });

  it("registers a control UI descriptor for GPU state", () => {
    const registerControlUiDescriptor = vi.fn();
    const api = createTestPluginApi({
      pluginConfig: {},
      registerService: vi.fn(),
      registerTool: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerCli: vi.fn(),
      registerControlUiDescriptor,
    });

    plugin.register(api);

    expect(registerControlUiDescriptor).toHaveBeenCalledTimes(1);
    const descriptor = registerControlUiDescriptor.mock.calls[0]?.[0] as {
      id: string;
      surface: string;
      label: string;
    };
    expect(descriptor.id).toBe("gpu-broker-state");
    expect(descriptor.surface).toBe("session");
    expect(descriptor.label).toBe("GPU State");
  });
});
