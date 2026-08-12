import { Command } from "commander";
import { describe, it, expect, vi } from "vitest";
import type { OpCatalog } from "./types.js";
import type { EngineRuntime } from "./runtime/engine-runtime.js";
import {
  CREATIVE_STUDIO_DESCRIPTOR,
  buildCreativeCommand,
  collectAcceleratorStatus,
  collectEngineOps,
  registerCreativeSurface,
  type CreativeEngineRecord,
} from "./surface.js";

/** Minimal EngineRuntime stub — only the surface's read paths are exercised. */
function makeFakeEngine(opts: {
  name: string;
  available: boolean;
  reason?: string;
  opIds?: string[];
  throwOnList?: boolean;
}): EngineRuntime {
  const catalog: OpCatalog = {
    engine: opts.name,
    ops: (opts.opIds ?? []).map((id) => ({
      id,
      name: id,
      description: `${id} op`,
      params: [],
      supports_chain: true,
    })),
  };
  return {
    engineName: opts.name,
    binaryPath: undefined,
    isAvailable: () => opts.available,
    reason: () => (opts.available ? undefined : opts.reason),
    listOps: () => {
      if (opts.throwOnList) throw new Error("engine not started");
      return catalog;
    },
  } as unknown as EngineRuntime;
}

function makeEngines(): CreativeEngineRecord {
  return {
    image: makeFakeEngine({ name: "image", available: true, opIds: ["gaussian_blur", "scale"] }),
    audio: makeFakeEngine({ name: "audio", available: false, reason: "libomni_audio_bridge not found" }),
    video: makeFakeEngine({ name: "video", available: false, reason: "libomni_video_bridge not found" }),
    vector: makeFakeEngine({ name: "vector", available: true, opIds: ["vectorize"] }),
  };
}

describe("registerCreativeSurface — registration", () => {
  it("registers the CLI and Control UI descriptor when the host supports both", () => {
    const registerCli = vi.fn();
    const registerControlUiDescriptor = vi.fn();

    const result = registerCreativeSurface({ registerCli, registerControlUiDescriptor }, makeEngines());

    expect(result).toEqual({ cli: true, controlUi: true });
    expect(registerCli).toHaveBeenCalledTimes(1);
    expect(registerCli.mock.calls[0]?.[1]).toStrictEqual({
      descriptors: [{ name: "creative", description: expect.any(String), hasSubcommands: true }],
    });
    expect(registerControlUiDescriptor).toHaveBeenCalledTimes(1);
    expect(registerControlUiDescriptor.mock.calls[0]?.[0]).toEqual(CREATIVE_STUDIO_DESCRIPTOR);
    expect(CREATIVE_STUDIO_DESCRIPTOR).toMatchObject({
      id: "creative-engines-studio",
      surface: "settings",
      label: "Creative Engines",
    });
  });

  it("no-ops honestly when the host lacks registerCli / registerControlUiDescriptor", () => {
    // Empty api object: neither method present.
    const result = registerCreativeSurface({}, makeEngines());
    expect(result).toEqual({ cli: false, controlUi: false });
  });

  it("registers only the CLI when Control UI is unsupported", () => {
    const registerCli = vi.fn();
    const result = registerCreativeSurface({ registerCli }, makeEngines());
    expect(result).toEqual({ cli: true, controlUi: false });
    expect(registerCli).toHaveBeenCalledTimes(1);
  });
});

describe("buildCreativeCommand — subcommands", () => {
  it("mounts a 'creative' command with list-ops/apply/batch/onnx-status/graph subcommands", () => {
    const program = new Command();
    const creative = buildCreativeCommand(program, makeEngines());

    expect(creative.name()).toBe("creative");
    const subNames = creative.commands.map((c) => c.name()).sort();
    expect(subNames).toEqual(["apply", "batch", "graph", "list-ops", "onnx-status"]);
  });

  it("is what the CLI registrar wires onto the program", () => {
    const registerCli = vi.fn();
    registerCreativeSurface({ registerCli }, makeEngines());
    const registrar = registerCli.mock.calls[0]?.[0] as (ctx: { program: Command }) => void;

    const program = new Command();
    registrar({ program });

    const creative = program.commands.find((c) => c.name() === "creative");
    expect(creative).toBeTruthy();
    expect(creative?.commands.map((c) => c.name()).sort()).toEqual([
      "apply",
      "batch",
      "graph",
      "list-ops",
      "onnx-status",
    ]);
  });
});

describe("collectAcceleratorStatus — operator diagnostics", () => {
  /**
   * Reads memoized process state only, so it must be safe with nothing loaded
   * (the common case for `openclaw creative onnx-status` on a fresh CLI
   * process) and must not overstate what a resolved dependency set means.
   */
  it("reports honestly with no engine loaded and never claims acceleration is active", () => {
    const status = collectAcceleratorStatus();

    // No native library is loaded to answer this, so the ORT state may legitimately
    // be "not-attempted" here; the sidecar FILES are reported separately.
    expect(["loaded", "unavailable", "not-attempted"]).toContain(status.onnxRuntime.state);
    expect(["searched", "disabled", "unsupported-platform"]).toContain(status.cuda.state);
    expect(status.summary.length).toBeGreaterThan(0);
    expect(status.note).toMatch(/can LOAD the CUDA execution provider/u);
    expect(status.note).toMatch(/falling back to CPU provider/u);
    expect(JSON.stringify(status)).not.toMatch(/GPU acceleration is active/u);
  });
});

describe("collectEngineOps — reflects engine availability", () => {
  it("reports available engines with their ops and unavailable engines with a reason", () => {
    const summaries = collectEngineOps(makeEngines());

    const byName = Object.fromEntries(summaries.map((s) => [s.engine, s]));
    expect(byName.image).toMatchObject({ available: true, op_count: 2, ops: ["gaussian_blur", "scale"] });
    expect(byName.image.reason).toBeUndefined();
    expect(byName.audio).toMatchObject({ available: false, op_count: 0, ops: [] });
    expect(byName.audio.reason).toMatch(/not found/);
    expect(byName.vector).toMatchObject({ available: true, op_count: 1, ops: ["vectorize"] });
  });

  it("restricts to a single engine when requested", () => {
    const summaries = collectEngineOps(makeEngines(), "image");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.engine).toBe("image");
  });

  it("degrades op listing to empty (still reporting availability) when the engine is not started", () => {
    const engines: CreativeEngineRecord = {
      image: makeFakeEngine({ name: "image", available: true, throwOnList: true }),
    };
    const summaries = collectEngineOps(engines, "image");
    expect(summaries[0]).toMatchObject({ engine: "image", available: true, op_count: 0, ops: [] });
  });
});
