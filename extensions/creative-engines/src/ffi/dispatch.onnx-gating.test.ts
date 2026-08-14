import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * ONNX gating + GPU-claim routing at the dispatch chokepoint.
 *
 * WHY THIS SUITE EXISTS — it guards a PROCESS-CRASH path, not a bad result.
 * `libomni_image_bridge` requests ORT API 26. When ONNX Runtime has not been
 * pre-loaded from the engine's own directory, Windows binds the bridge's
 * implicit `onnxruntime.dll` import to System32's ORT 1.17.1 (API <= 17); ORT
 * hands back a null API table and the bridge dereferences it. That is a native
 * access violation (0xC0000005) which kills the whole gateway, and `image.apply`
 * is agent-callable — so a single agent call could take the gateway down. No
 * try/catch in JS can catch it.
 *
 * The only safe guard is a TypeScript-side decision made BEFORE the FFI call.
 * The `lib` stub below therefore FAILS THE TEST if `func()` is ever reached for
 * a gated op: reaching the bridge is exactly the bug.
 *
 * These tests use a synthetic binding module and need no native binaries, so
 * they run everywhere. `loader.onnxUnavailableReason` is mocked because it
 * reflects process-wide preload state that a unit test must not depend on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { clearGpuBroker, setGpuBroker } from "../gpu-coop.js";
import type { EngineBindingModule, OnnxOpSpec } from "./binding-types.js";
import { buildPrototype } from "./binding-types.js";
import type { KoffiLib } from "./loader.js";

vi.mock("./loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./loader.js")>();
  return { ...actual, onnxUnavailableReason: () => ortReason };
});

/** Controlled by each test; `undefined` means "ORT is loaded and usable". */
let ortReason: string | undefined;

const { NativeDispatch } = await import("./dispatch.js");

/** The 4x4 non-uniform RGBA PNG fixture shared with the other dispatch suites. */
const PNG_4X4_RGBA_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAM0lEQVR4nBXIMREAQRDDsK8XWIAFWGqz8s+p1HeHOezhDr8LJtjg8qKYYovri2GGHW74A/xIKPGjpQFDAAAAAElFTkSuQmCC";

const SEGMENT_SPEC: OnnxOpSpec = {
  modelId: "segment",
  modelFile: "u2net.onnx",
  modelEnvVar: "OMNI_SEG_MODEL",
};

/** Minimal image binding module: one ONNX-backed op and one pure CPU op. */
const testBindings: EngineBindingModule = {
  engine: "image",
  libraryStem: "test_image_bridge",
  ops: [
    {
      name: "remove_background",
      signature: buildPrototype("remove_background", []),
      params: [],
      kind: "filter",
      chainable: true,
      description: "ONNX-backed background removal (test double).",
    },
    {
      name: "grayscale",
      signature: buildPrototype("grayscale", []),
      params: [],
      kind: "filter",
      chainable: true,
      description: "Pure C++ grayscale (test double).",
    },
  ],
  knownBroken: new Set<string>(),
  onnxOps: new Map<string, OnnxOpSpec>([["remove_background", SEGMENT_SPEC]]),
};

let tempDir: string;
let inputPng: string;
/** Fake engine library path whose sibling `models/` dir holds the model. */
let libWithModel: string;
/** Fake engine library path whose sibling `models/` dir is empty. */
let libWithoutModel: string;
/** Op names for which the stub's `func()` was reached. */
let ffiCalls: string[];

/**
 * koffi stub. `func()` records the prototype it was asked to bind — for a gated
 * op that must never happen — and returns a no-op writer so the non-gated paths
 * still produce a real file.
 */
function makeLib(): KoffiLib {
  return {
    func(prototype: string) {
      ffiCalls.push(prototype);
      return () => undefined;
    },
  };
}

beforeEach(() => {
  ortReason = undefined;
  ffiCalls = [];
  clearGpuBroker();
  tempDir = mkdtempSync(join(tmpdir(), "creative-onnx-gate-"));
  inputPng = join(tempDir, "input-4x4.png");
  writeFileSync(inputPng, Buffer.from(PNG_4X4_RGBA_BASE64, "base64"));

  const withModel = join(tempDir, "with-model");
  mkdirSync(join(withModel, "models"), { recursive: true });
  writeFileSync(join(withModel, "models", SEGMENT_SPEC.modelFile), "not-a-real-model");
  libWithModel = join(withModel, "libtest_image_bridge.dll");

  const withoutModel = join(tempDir, "without-model");
  mkdirSync(join(withoutModel, "models"), { recursive: true });
  libWithoutModel = join(withoutModel, "libtest_image_bridge.dll");

  delete process.env[SEGMENT_SPEC.modelEnvVar];
});

afterEach(() => {
  clearGpuBroker();
  delete process.env[SEGMENT_SPEC.modelEnvVar];
  rmSync(tempDir, { recursive: true, force: true });
});

function dispatchWithModel() {
  return new NativeDispatch(testBindings, makeLib(), undefined, libWithModel);
}

describe("neural ops are gated when the ONNX Runtime sidecar is unavailable", () => {
  it("fails honestly and never reaches the C++ bridge", async () => {
    ortReason =
      "ONNX Runtime sidecar not found in 'X' (looked for libonnxruntime.dll / onnxruntime.dll).";
    const dispatch = dispatchWithModel();

    const result = await dispatch.applyOp(
      inputPng,
      "remove_background",
      join(tempDir, "out.png"),
      {},
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("onnx_unavailable");
    expect(result.reason).toContain("remove_background");
    // The reason must name the model and what to provision, not just "failed".
    expect(result.reason).toContain("segment");
    expect(result.reason).toContain("ONNX Runtime sidecar not found");
    // THE crash guard: no FFI binding, so no call into the bridge.
    expect(ffiCalls).toEqual([]);
  });

  it("still runs pure C++ ops from the same engine", async () => {
    ortReason = "ONNX Runtime sidecar not found.";
    const dispatch = dispatchWithModel();

    const result = await dispatch.applyOp(inputPng, "grayscale", join(tempDir, "gray.png"), {});

    expect(result.ok, result.reason).toBe(true);
    expect(ffiCalls).toHaveLength(1);
    expect(ffiCalls[0]).toContain("bridge_grayscale");
  });

  it("rejects a whole chain up front rather than running the steps before the neural one", async () => {
    ortReason = "ONNX Runtime sidecar not found.";
    const dispatch = dispatchWithModel();

    const result = await dispatch.applyChain(
      inputPng,
      [
        { op: "grayscale", params: {} },
        { op: "remove_background", params: {} },
      ],
      join(tempDir, "chain.png"),
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("onnx_unavailable");
    // Not even the leading CPU step ran, so no partial output was produced.
    expect(ffiCalls).toEqual([]);
  });
});

describe("neural ops are gated when the model file is missing", () => {
  it("names the resolved path and the env override", async () => {
    const dispatch = new NativeDispatch(testBindings, makeLib(), undefined, libWithoutModel);

    const result = await dispatch.applyOp(
      inputPng,
      "remove_background",
      join(tempDir, "out.png"),
      {},
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("onnx_model_missing");
    expect(result.reason).toContain(SEGMENT_SPEC.modelFile);
    expect(result.reason).toContain(SEGMENT_SPEC.modelEnvVar);
    expect(ffiCalls).toEqual([]);
  });

  it("honors the env-var override the C++ model host reads", async () => {
    const override = join(tempDir, "elsewhere.onnx");
    writeFileSync(override, "not-a-real-model");
    process.env[SEGMENT_SPEC.modelEnvVar] = override;

    const dispatch = new NativeDispatch(testBindings, makeLib(), undefined, libWithoutModel);
    const result = await dispatch.applyOp(
      inputPng,
      "remove_background",
      join(tempDir, "out.png"),
      {},
    );

    expect(result.ok, result.reason).toBe(true);
    expect(ffiCalls[0]).toContain("bridge_remove_background");
  });
});

describe("GPU cooperation is routed to the ops that contend for VRAM", () => {
  it("claims the GPU for an ONNX op and not for a pure C++ op", async () => {
    const order: string[] = [];
    setGpuBroker({
      release: async () => void order.push("release"),
      reclaim: async () => void order.push("reclaim"),
    });
    const dispatch = dispatchWithModel();

    await dispatch.applyOp(inputPng, "grayscale", join(tempDir, "gray.png"), {});
    expect(order).toEqual([]);

    await dispatch.applyOp(inputPng, "remove_background", join(tempDir, "rb.png"), {});
    expect(order).toEqual(["release", "reclaim"]);
  });

  it("takes a single claim for a chain containing a neural step", async () => {
    const order: string[] = [];
    setGpuBroker({
      release: async () => void order.push("release"),
      reclaim: async () => void order.push("reclaim"),
    });
    const dispatch = dispatchWithModel();

    await dispatch.applyChain(
      inputPng,
      [
        { op: "grayscale", params: {} },
        { op: "remove_background", params: {} },
        { op: "grayscale", params: {} },
      ],
      join(tempDir, "chain.png"),
    );

    expect(order).toEqual(["release", "reclaim"]);
  });

  it("does not claim for a chain of pure C++ steps", async () => {
    const order: string[] = [];
    setGpuBroker({
      release: async () => void order.push("release"),
      reclaim: async () => void order.push("reclaim"),
    });
    const dispatch = dispatchWithModel();

    await dispatch.applyChain(
      inputPng,
      [
        { op: "grayscale", params: {} },
        { op: "grayscale", params: {} },
      ],
      join(tempDir, "chain-cpu.png"),
    );

    expect(order).toEqual([]);
  });

  it("returns the claim even when the op fails", async () => {
    const order: string[] = [];
    setGpuBroker({
      release: async () => void order.push("release"),
      reclaim: async () => void order.push("reclaim"),
    });
    const dispatch = dispatchWithModel();

    const result = await dispatch.applyOp(
      "does-not-exist.png",
      "remove_background",
      join(tempDir, "out.png"),
      {},
    );

    expect(result.ok).toBe(false);
    expect(order).toEqual(["release", "reclaim"]);
  });
});
