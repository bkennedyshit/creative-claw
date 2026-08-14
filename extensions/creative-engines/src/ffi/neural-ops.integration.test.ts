import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
/**
 * Real neural ops end to end — REAL native engine, REAL ONNX Runtime, REAL
 * GPU broker. No mocks.
 *
 * This suite is the counterpart to `dispatch.onnx-gating.test.ts`: that one pins
 * the honest-failure path with no binaries, this one pins the working path when
 * the binaries ARE provisioned. It is env-gated on the engine library, the ONNX
 * Runtime sidecar and each model file, so it skips cleanly on a machine that has
 * not provisioned `extensions/creative-engines/binaries/` (see that directory's
 * README.md).
 *
 * What it proves:
 *   1. `remove_background` runs a real U2Net inference and produces a real,
 *      non-blank, non-passthrough RGBA cut-out.
 *   2. The GPU claim is taken and returned for a neural op and never touched for
 *      a pure C++ op, against a real `GpuBroker`.
 *   3. `shutdown()` returns promptly once ORT is mapped instead of wedging in
 *      `FreeLibrary` (the old hang), and says why the library was left mapped.
 *
 * Set `CREATIVE_ENGINES_NEURAL_FIXTURE` to a real photograph to also assert the
 * alpha cut-out contains BOTH transparent and opaque pixels; a synthetic
 * gradient is not a subject any segmentation model is obliged to find, so that
 * stronger assertion is only made on real input.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GpuBroker } from "../../../gpu-broker/src/broker.js";
import {
  createGpuBrokerCoopHandle,
  publishGpuBrokerHandle,
  unpublishGpuBrokerHandle,
} from "../../../gpu-broker/src/coop-handle.js";
import { ImageEngineRuntime } from "../runtime/image.js";
import { collectAcceleratorStatus } from "../surface.js";
import { decodeImageRGBA } from "./codec.js";
import { ONNX_OPS } from "./image-bindings.js";
import {
  CUDA_PROVIDER_DEPENDENCIES,
  cudaProviderDependenciesResolved,
  cudaProviderDependencyStatus,
  describeCudaProviderDependencies,
  resolveBinaryPath,
} from "./loader.js";

const enginePath = resolveBinaryPath("omni_image_bridge");
const ortPath = resolveBinaryPath("onnxruntime");

/** Every distinct model the ONNX op catalog needs, resolved as the C++ host does. */
function missingModels(): string[] {
  if (!enginePath) {
    return ["<engine library not found>"];
  }
  const modelsDir = join(dirname(enginePath), "models");
  const files = new Set([...ONNX_OPS.values()].map((spec) => spec.modelFile));
  return [...files].filter((file) => !existsSync(join(modelsDir, file)));
}

const MISSING =
  enginePath && ortPath ? missingModels() : ["<engine or onnxruntime sidecar not found>"];
const NEURAL_READY = MISSING.length === 0;

if (!NEURAL_READY) {
  // eslint-disable-next-line no-console
  console.log(`[neural-ops] skipping: not provisioned (${MISSING.join(", ")})`);
}

/** Optional real photograph for the stronger alpha assertions. */
const FIXTURE = process.env.CREATIVE_ENGINES_NEURAL_FIXTURE;
const HAVE_PHOTO = Boolean(FIXTURE) && existsSync(FIXTURE);

let tempDir: string;
let syntheticInput: string;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "creative-neural-"));
  syntheticInput = join(tempDir, "synthetic-64x64.png");
  if (!NEURAL_READY) {
    return;
  }
  // A deterministic non-uniform image: a bright block on a dark field.
  const sharp = (await import("sharp")).default;
  const w = 64;
  const h = 64;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inBlock = x >= 16 && x < 48 && y >= 16 && y < 48;
      const i = (y * w + x) * 3;
      raw[i] = inBlock ? 220 : 20;
      raw[i + 1] = inBlock ? 180 : 30;
      raw[i + 2] = inBlock ? 60 : 40;
    }
  }
  await sharp(raw, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toFile(syntheticInput);
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

interface PixelStats {
  width: number;
  height: number;
  nonZero: number;
  differing: number;
  alphaZero: number;
  alphaOpaque: number;
}

async function comparePixels(inputPath: string, outputPath: string): Promise<PixelStats> {
  const src = await decodeImageRGBA(inputPath);
  const dst = await decodeImageRGBA(outputPath);
  let nonZero = 0;
  let differing = 0;
  let alphaZero = 0;
  let alphaOpaque = 0;
  for (let i = 0; i < dst.data.length; i += 4) {
    const a = dst.data[i + 3]!;
    if (a === 0) {
      alphaZero++;
    } else if (a === 255) {
      alphaOpaque++;
    }
    if (dst.data[i] !== 0 || dst.data[i + 1] !== 0 || dst.data[i + 2] !== 0 || a !== 0) {
      nonZero++;
    }
    if (
      i < src.data.length &&
      (dst.data[i] !== src.data[i] ||
        dst.data[i + 1] !== src.data[i + 1] ||
        dst.data[i + 2] !== src.data[i + 2] ||
        a !== src.data[i + 3])
    ) {
      differing++;
    }
  }
  return { width: dst.width, height: dst.height, nonZero, differing, alphaZero, alphaOpaque };
}

describe.skipIf(!NEURAL_READY)("neural ops against the real ONNX Runtime", () => {
  it("remove_background runs a real inference and returns a non-blank, non-passthrough cut-out", async () => {
    const runtime = new ImageEngineRuntime();
    await runtime.start();
    try {
      expect(runtime.isAvailable(), runtime.reason()).toBe(true);
      const input = HAVE_PHOTO ? FIXTURE! : syntheticInput;
      const output = join(tempDir, "remove-bg.png");

      const result = await runtime.apply(input, "remove_background", output, {});
      // eslint-disable-next-line no-console
      console.log(
        `[remove_background] ok=${result.ok} ms=${result.duration_ms} reason=${result.reason ?? "-"}`,
      );
      expect(result.ok, result.reason).toBe(true);
      expect(existsSync(output)).toBe(true);

      const stats = await comparePixels(input, output);
      // eslint-disable-next-line no-console
      console.log(
        `[remove_background] ${stats.width}x${stats.height} nonZero=${stats.nonZero} differing=${stats.differing} alpha0=${stats.alphaZero} alpha255=${stats.alphaOpaque}`,
      );
      const source = await decodeImageRGBA(input);
      expect(stats.width).toBe(source.width);
      expect(stats.height).toBe(source.height);
      // A zeroed buffer encoded to a valid PNG was the old failure mode.
      expect(stats.nonZero).toBeGreaterThan(0);
      // A passthrough copy would be byte-identical.
      expect(stats.differing).toBeGreaterThan(0);

      if (HAVE_PHOTO) {
        // A real photograph must yield a real matte: some background cut away
        // AND some subject kept. All-transparent or all-opaque means the model
        // did not actually segment anything.
        expect(stats.alphaZero).toBeGreaterThan(0);
        expect(stats.alphaOpaque).toBeGreaterThan(0);
      }
    } finally {
      await runtime.shutdown();
    }
  }, 120_000);

  /**
   * `bridge_get_foreground_mask` and `bridge_neural_generate_depth_map` write
   * exactly `w*h` bytes. They used to be dispatched as ordinary `w*h*4` RGBA
   * filters, so C++ filled only the first quarter of the buffer and the op
   * reported `ok: true` for an image whose bottom ~3/4 was zeros. A grayscale
   * PNG round-trips as R==G==B; an RGBA misencode of a single-channel buffer
   * does not, and its lowest row is empty — so both are asserted.
   */
  it.each(["get_foreground_mask", "neural_generate_depth_map"])(
    "%s writes a full single-channel image, not a quarter-filled RGBA buffer",
    async (op) => {
      const runtime = new ImageEngineRuntime();
      await runtime.start();
      try {
        const output = join(tempDir, `single-channel-${op}.png`);
        const result = await runtime.apply(syntheticInput, op, output, {});
        expect(result.ok, result.reason).toBe(true);

        const decoded = await decodeImageRGBA(output);
        const source = await decodeImageRGBA(syntheticInput);
        expect(decoded.width).toBe(source.width);
        expect(decoded.height).toBe(source.height);

        let nonGray = 0;
        let lastRowNonZero = 0;
        for (let y = 0; y < decoded.height; y++) {
          for (let x = 0; x < decoded.width; x++) {
            const i = (y * decoded.width + x) * 4;
            const r = decoded.data[i]!;
            const g = decoded.data[i + 1]!;
            const b = decoded.data[i + 2]!;
            if (r !== g || g !== b) {
              nonGray++;
            }
            if (y === decoded.height - 1 && (r !== 0 || g !== 0 || b !== 0)) {
              lastRowNonZero++;
            }
          }
        }
        // eslint-disable-next-line no-console
        console.log(
          `[single-channel ${op}] nonGrayPixels=${nonGray} lastRowNonZero=${lastRowNonZero}/${decoded.width}`,
        );
        expect(nonGray).toBe(0);
        expect(lastRowNonZero).toBeGreaterThan(0);
      } finally {
        await runtime.shutdown();
      }
    },
    120_000,
  );

  it("takes and returns a real GPU broker lease for a neural op, and none for a CPU op", async () => {
    // Dormant + dead Ollama URL + a 1h poll: nothing real is evicted and no
    // nvidia-smi loop runs, but release/reclaim still exercise the real broker.
    const broker = new GpuBroker({
      ollamaBaseUrl: "http://127.0.0.1:1",
      dormantOverride: true,
      pollIntervalMs: 3_600_000,
    });
    broker.start();
    const handle = createGpuBrokerCoopHandle(() => broker);
    publishGpuBrokerHandle(handle);

    const runtime = new ImageEngineRuntime();
    await runtime.start();
    try {
      const cpuMark = broker.getHistory().length;
      const cpu = await runtime.apply(
        syntheticInput,
        "grayscale",
        join(tempDir, "claim-gray.png"),
        {},
      );
      expect(cpu.ok, cpu.reason).toBe(true);
      expect(broker.getHistory().length - cpuMark).toBe(0);
      expect(broker.getLease()).toBeNull();

      const neuralMark = broker.getHistory().length;
      let leaseOwner: string | undefined;
      const sampler = setInterval(() => {
        const lease = broker.getLease();
        if (lease) {
          leaseOwner = lease.owner;
        }
      }, 5);
      const neural = await runtime.apply(
        syntheticInput,
        "remove_background",
        join(tempDir, "claim-rb.png"),
        {},
      );
      clearInterval(sampler);

      expect(neural.ok, neural.reason).toBe(true);
      const transitions = broker.getHistory().slice(neuralMark);
      // eslint-disable-next-line no-console
      console.log(
        `[gpu-claim] transitions: ${transitions.map((t) => `${t.from}->${t.to}`).join(" | ")}`,
      );
      expect(transitions.map((t) => t.to)).toContain("draining");
      expect(transitions.map((t) => t.to)).toContain("user-claimed");
      expect(leaseOwner).toBe("creative-engines");
      // The claim was handed back, not leaked.
      expect(broker.getLease()).toBeNull();
    } finally {
      await runtime.shutdown();
      unpublishGpuBrokerHandle(handle);
      broker.stop();
    }
  }, 120_000);

  /**
   * The CUDA discovery has to have RUN by the time an engine is up, because it
   * is wired into the ONNX Runtime preload. What it found is machine-dependent,
   * so the always-on assertion is only that the state is one of the honest ones
   * and that a neural op works in every one of them.
   *
   * NO SPEED ASSERTION. GPU vs CPU wall clock depends on the machine, the image
   * and what else is running; asserting a number here would flake. Provider
   * selection and the diagnostics are the stable, meaningful contract.
   */
  it("reports a resolved CUDA dependency state once an engine has started, and the op works in every state", async () => {
    const runtime = new ImageEngineRuntime();
    await runtime.start();
    try {
      const status = cudaProviderDependencyStatus();
      // eslint-disable-next-line no-console
      console.log(`[cuda] ${describeCudaProviderDependencies()}`);
      expect(status.state).not.toBe("not-attempted");
      expect(["searched", "disabled", "unsupported-platform"]).toContain(status.state);

      if (status.state === "searched") {
        // Every required library is accounted for, found or not.
        expect(status.libraries.map((entry) => entry.library)).toEqual([
          ...CUDA_PROVIDER_DEPENDENCIES,
        ]);
        for (const entry of status.libraries) {
          if (entry.directory) {
            expect(existsSync(join(entry.directory, entry.library))).toBe(true);
          }
        }
        expect(status.complete).toBe(status.missing.length === 0);
        // Only directories that actually hold a required library get added.
        for (const dir of status.addedDirectories) {
          expect(status.libraries.some((entry) => entry.directory === dir)).toBe(true);
        }
        // eslint-disable-next-line no-console
        console.log(
          `[cuda] resolved: ${status.libraries
            .map((entry) => `${entry.library}=${entry.directory ?? "MISSING"}`)
            .join("\n            ")}`,
        );
      }

      // The whole point: GPU is an optimization, so the op succeeds regardless.
      const output = join(tempDir, "cuda-state-rb.png");
      const result = await runtime.apply(syntheticInput, "remove_background", output, {});
      expect(result.ok, result.reason).toBe(true);

      // The operator-facing diagnostics report the same state, and never claim
      // acceleration is active.
      const diagnostics = collectAcceleratorStatus();
      expect(diagnostics.cuda).toEqual(status);
      expect(diagnostics.onnxRuntime.state).toBe("loaded");
      expect(diagnostics.note).toMatch(/not that any given session ran on the GPU/u);
    } finally {
      await runtime.shutdown();
    }
  }, 120_000);

  /**
   * Opt-in lane for a machine that is SUPPOSED to have CUDA 12 + cuDNN 9. Set
   * `CREATIVE_ENGINES_EXPECT_CUDA=1` to turn a silent CPU fallback into a
   * failure. Off by default so CI and CUDA-less machines stay green.
   */
  it.skipIf(process.env.CREATIVE_ENGINES_EXPECT_CUDA !== "1")(
    "resolves every CUDA provider dependency when CREATIVE_ENGINES_EXPECT_CUDA=1",
    async () => {
      const runtime = new ImageEngineRuntime();
      await runtime.start();
      try {
        const status = cudaProviderDependencyStatus();
        expect(status.state).toBe("searched");
        if (status.state !== "searched") {
          return;
        }
        expect(status.missing, describeCudaProviderDependencies()).toEqual([]);
        expect(status.complete).toBe(true);
        expect(cudaProviderDependenciesResolved()).toBe(true);
        expect(status.addedDirectories.length).toBeGreaterThan(0);

        const result = await runtime.apply(
          syntheticInput,
          "remove_background",
          join(tempDir, "expect-cuda.png"),
          {},
        );
        expect(result.ok, result.reason).toBe(true);
      } finally {
        await runtime.shutdown();
      }
    },
    120_000,
  );

  it("shutdown returns promptly once ONNX Runtime is mapped, and reports the skipped unload", async () => {
    const runtime = new ImageEngineRuntime();
    await runtime.start();
    const result = await runtime.apply(
      syntheticInput,
      "remove_background",
      join(tempDir, "shutdown-rb.png"),
      {},
    );
    expect(result.ok, result.reason).toBe(true);

    const started = Date.now();
    await runtime.shutdown();
    const elapsed = Date.now() - started;
    // eslint-disable-next-line no-console
    console.log(
      `[shutdown] returned in ${elapsed} ms; skipped=${runtime.unloadSkippedReason() ?? "-"}`,
    );
    // The old path blocked indefinitely in FreeLibrary (killed at 120 s).
    expect(elapsed).toBeLessThan(5_000);
    expect(runtime.isAvailable()).toBe(false);
    expect(runtime.unloadSkippedReason()).toMatch(/ONNX Runtime is mapped/);
  }, 120_000);
});
