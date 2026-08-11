import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GpuBroker } from "./broker.js";
import {
  registerGpuSurface,
  type CliCommandLike,
  type CliProgramLike,
  type ControlUiDescriptor,
} from "./surface.js";

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

/** Recording commander-style command that captures the built subcommand tree. */
interface MockCommand extends CliCommandLike {
  name: string;
  subcommands: Record<string, MockCommand>;
  actionFn?: (...args: unknown[]) => unknown;
}

function makeCommand(name: string): MockCommand {
  const cmd: MockCommand = {
    name,
    subcommands: {},
    command(sub: string) {
      const child = makeCommand(sub);
      this.subcommands[sub] = child;
      return child;
    },
    description() {
      return this;
    },
    option() {
      return this;
    },
    action(fn) {
      this.actionFn = fn;
      return this;
    },
  };
  return cmd;
}

describe("registerGpuSurface", () => {
  let broker: GpuBroker;

  beforeEach(() => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/api/ps")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ models: [] }) });
      }
      return Promise.resolve({ ok: false });
    });
    broker = new GpuBroker({ pollIntervalMs: 1000 });
  });

  afterEach(() => {
    broker.stop();
    vi.clearAllMocks();
  });

  it("registers the gpu CLI and control-ui descriptor when the api supports them", () => {
    const root = makeCommand("root");
    let controlUi: ControlUiDescriptor | undefined;
    let cliOpts: unknown;

    const api = {
      registerCli(registrar: (ctx: { program: CliProgramLike }) => void, opts?: unknown) {
        cliOpts = opts;
        registrar({ program: root });
      },
      registerControlUiDescriptor(descriptor: ControlUiDescriptor) {
        controlUi = descriptor;
      },
    };

    registerGpuSurface(api, () => broker);

    // CLI: a `gpu` group with status/release/reclaim subcommands.
    expect(root.subcommands.gpu).toBeDefined();
    const gpu = root.subcommands.gpu!;
    expect(Object.keys(gpu.subcommands).sort()).toEqual(["reclaim", "release", "status"]);

    // Lazy CLI descriptor advertises the `gpu` root with subcommands.
    expect(cliOpts).toEqual({
      descriptors: [
        { name: "gpu", description: expect.any(String), hasSubcommands: true },
      ],
    });

    // Control UI: settings surface with the expected id + label.
    expect(controlUi).toEqual({
      id: "gpu-broker-status",
      surface: "settings",
      label: "GPU Broker",
      description: expect.any(String),
    });
  });

  it("gpu status action reads live broker state", async () => {
    const root = makeCommand("root");
    const api = {
      registerCli(registrar: (ctx: { program: CliProgramLike }) => void) {
        registrar({ program: root });
      },
    };

    registerGpuSurface(api, () => broker);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stateSpy = vi.spyOn(broker, "getState");

    await root.subcommands.gpu!.subcommands.status!.actionFn?.();

    expect(stateSpy).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
    stateSpy.mockRestore();
  });

  it("no-ops honestly when the api exposes neither registration seam", () => {
    // Empty api: no registerCli / registerControlUiDescriptor.
    expect(() => registerGpuSurface({}, () => broker)).not.toThrow();
  });

  it("registers only the control-ui descriptor when registerCli is absent", () => {
    let controlUi: ControlUiDescriptor | undefined;
    const api = {
      registerControlUiDescriptor(descriptor: ControlUiDescriptor) {
        controlUi = descriptor;
      },
    };

    expect(() => registerGpuSurface(api, () => broker)).not.toThrow();
    expect(controlUi?.id).toBe("gpu-broker-status");
  });
});
