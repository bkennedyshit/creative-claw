import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the codec layer so tests never touch sharp/ffmpeg or the filesystem.
vi.mock("../ffi/codec.js", () => ({
  decodeImageRGBA: vi.fn(),
  encodeImageRGBA: vi.fn(async () => {}),
  encodeMaskPNG: vi.fn(async () => {}),
  decodeAudioF32: vi.fn(),
  encodeAudioF32: vi.fn(async () => {}),
  decodeVideoRGBA: vi.fn(),
  encodeVideoRGBA: vi.fn(async () => {}),
  probeVideo: vi.fn(),
  resolveFfmpeg: vi.fn(() => "ffmpeg"),
  resolveFfprobe: vi.fn(() => "ffprobe"),
  runCapture: vi.fn(async () => Buffer.alloc(0)),
}));

import { audioBindings } from "../ffi/audio-bindings.js";
import * as codec from "../ffi/codec.js";
import { NativeDispatch } from "../ffi/dispatch.js";
import { imageBindings } from "../ffi/image-bindings.js";
import { loadEngine } from "../ffi/loader.js";
import type { KoffiLib } from "../ffi/loader.js";
import { EngineRuntime } from "./engine-runtime.js";

/** A fake koffi library that records every bound prototype and every call. */
function makeFakeLib(): { lib: KoffiLib; boundPrototypes: string[]; calls: unknown[][] } {
  const boundPrototypes: string[] = [];
  const calls: unknown[][] = [];
  const lib: KoffiLib = {
    func(prototype: string) {
      boundPrototypes.push(prototype);
      return (...args: unknown[]) => {
        calls.push(args);
        // No-op: the preallocated out buffer (last arg) stays zeroed.
      };
    },
  };
  return { lib, boundPrototypes, calls };
}

describe("loader (honest missing-binary handling)", () => {
  it("reports available:false with a reason when the library is absent", () => {
    const result = loadEngine("definitely_missing_engine_bridge_xyz");
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toMatch(/not found/i);
    }
  });
});

describe("EngineRuntime — lazy start (works outside the gateway)", () => {
  /**
   * Uses a stem that cannot resolve on any machine, so this exercises the real
   * start/shutdown wiring and the real loader without mapping a 300 MB bridge
   * into the test worker.
   */
  class UnresolvableEngine extends EngineRuntime {
    constructor() {
      super({
        engineName: "unresolvable",
        bindings: { ...imageBindings, libraryStem: "definitely_missing_engine_bridge_xyz" },
        config: { available: false },
      });
    }
  }

  it("loads on first apply() with no service start, rather than throwing", async () => {
    const runtime = new UnresolvableEngine();
    // Nothing started it — this is the standalone-CLI state that used to throw.
    expect(runtime.isAvailable()).toBe(false);

    const res = await runtime.apply("/in.png", "gaussian_blur", "/out.png", { sigma: 2 });

    // A dispatcher now exists, so the failure is the honest "library missing"
    // one from the loader, not "engine 'unresolvable' not started".
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/unavailable/i);
    expect(runtime.reason()).toMatch(/not found/i);
  });

  it("records the load reason after ensureStarted(), and is idempotent", async () => {
    const runtime = new UnresolvableEngine();
    expect(runtime.reason()).toBeUndefined(); // never attempted

    await runtime.ensureStarted();
    // Proof a load actually ran: only the loader produces this reason.
    expect(runtime.reason()).toMatch(/not found/i);

    const first = runtime.reason();
    await runtime.ensureStarted();
    expect(runtime.reason()).toBe(first);
    expect(runtime.isAvailable()).toBe(false);
  });

  it("does NOT re-map the library after shutdown", async () => {
    const runtime = new UnresolvableEngine();
    await runtime.ensureStarted();
    await runtime.shutdown();

    // Re-mapping a bridge during teardown (ORT may still be mapped) trades a
    // clean exit for a native crash, so ensureStarted must stay inert here.
    await runtime.ensureStarted();
    expect(runtime.reason()).toBe("engine shut down");
    const apply = runtime.apply("/in.png", "gaussian_blur", "/out.png", {});
    await expect(apply).rejects.toThrow(/not started/);
  });

  it("still allows an explicit restart via start()", async () => {
    const runtime = new UnresolvableEngine();
    await runtime.ensureStarted();
    await runtime.shutdown();
    await runtime.start();
    expect(runtime.reason()).toMatch(/not found/i);
  });
});

describe("NativeDispatch — availability", () => {
  it("reports unavailable and degrades honestly when the lib is not loaded", async () => {
    const dispatch = new NativeDispatch(imageBindings, undefined, undefined, undefined);
    expect(dispatch.isAvailable()).toBe(false);
    const res = await dispatch.applyOp("/in.png", "gaussian_blur", "/out.png", { sigma: 2 });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/unavailable/i);
  });

  it("still lists ops without a loaded library (metadata only)", () => {
    const dispatch = new NativeDispatch(imageBindings, undefined, undefined, undefined);
    const catalog = dispatch.listOps();
    expect(catalog.engine).toBe("image");
    expect(catalog.ops.find((o) => o.id === "gaussian_blur")).toBeTruthy();
  });
});

describe("NativeDispatch — binding + dispatch (image)", () => {
  const decode = codec.decodeImageRGBA as unknown as ReturnType<typeof vi.fn>;
  const encodeImage = codec.encodeImageRGBA as unknown as ReturnType<typeof vi.fn>;
  const encodeMask = codec.encodeMaskPNG as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // 4x8 RGBA source image.
    decode.mockResolvedValue({ data: Buffer.alloc(4 * 8 * 4), width: 4, height: 8, channels: 4 });
  });

  it("binds the correct koffi prototype and calls it with header+params+out", async () => {
    const { lib, boundPrototypes, calls } = makeFakeLib();
    const dispatch = new NativeDispatch(imageBindings, lib, undefined, "/fake/lib.dll");

    const res = await dispatch.applyOp("/in.png", "gaussian_blur", "/out.png", { sigma: 3.5 });
    expect(res.ok).toBe(true);
    expect(boundPrototypes[0]).toBe(
      "void bridge_gaussian_blur(uint8* pixels, int w, int h, int channels, float sigma, uint8* out)",
    );
    // args: [pixels, w, h, channels, sigma, out]
    const args = calls[0]!;
    expect(args[1]).toBe(4); // width
    expect(args[2]).toBe(8); // height
    expect(args[3]).toBe(4); // channels
    expect(args[4]).toBe(3.5); // sigma
    expect(encodeImage).toHaveBeenCalledWith(expect.any(Buffer), 4, 8, "/out.png");
  });

  it("applies resizing dimension logic (scale → new dims)", async () => {
    const { lib } = makeFakeLib();
    const dispatch = new NativeDispatch(imageBindings, lib, undefined, "/fake/lib.dll");
    await dispatch.applyOp("/in.png", "scale", "/out.png", { new_width: 10, new_height: 20 });
    expect(encodeImage).toHaveBeenCalledWith(expect.any(Buffer), 10, 20, "/out.png");
  });

  it("swaps dimensions for rotate_90", async () => {
    const { lib } = makeFakeLib();
    const dispatch = new NativeDispatch(imageBindings, lib, undefined, "/fake/lib.dll");
    await dispatch.applyOp("/in.png", "rotate_90", "/out.png", {});
    // source 4x8 -> output 8x4
    expect(encodeImage).toHaveBeenCalledWith(expect.any(Buffer), 8, 4, "/out.png");
  });

  it("routes mask filters to a single-channel mask encode", async () => {
    const { lib } = makeFakeLib();
    const dispatch = new NativeDispatch(imageBindings, lib, undefined, "/fake/lib.dll");
    await dispatch.applyOp("/in.png", "magic_wand", "/mask.png", {
      start_x: 1,
      start_y: 2,
      tolerance: 40,
    });
    expect(encodeMask).toHaveBeenCalledWith(expect.any(Buffer), 4, 8, "/mask.png");
    expect(encodeImage).not.toHaveBeenCalled();
  });

  it("gates known-broken ops honestly", async () => {
    const { lib } = makeFakeLib();
    const broken = { ...imageBindings, knownBroken: new Set(["gaussian_blur"]) };
    const dispatch = new NativeDispatch(broken, lib, undefined, "/fake/lib.dll");
    const res = await dispatch.applyOp("/in.png", "gaussian_blur", "/out.png", { sigma: 2 });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/known_broken/);
  });

  it("skips multi-buffer special ops with an honest reason", async () => {
    const { lib } = makeFakeLib();
    const dispatch = new NativeDispatch(imageBindings, lib, undefined, "/fake/lib.dll");
    const res = await dispatch.applyOp("/in.png", "blend_multiply", "/out.png", {});
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/not a single-input/i);
  });
});

describe("NativeDispatch — binding + dispatch (audio)", () => {
  const decodeAudio = codec.decodeAudioF32 as unknown as ReturnType<typeof vi.fn>;
  const encodeAudio = codec.encodeAudioF32 as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    decodeAudio.mockResolvedValue({
      samples: new Float32Array([0.1, 0.2, 0.3, 0.4]),
      sampleRate: 48000,
    });
  });

  it("injects the real sample rate and calls an in-place op with no out buffer", async () => {
    const { lib, boundPrototypes, calls } = makeFakeLib();
    const dispatch = new NativeDispatch(audioBindings, lib, undefined, "/fake/audio.dll");
    const res = await dispatch.applyOp("/in.wav", "noise_gate", "/out.wav", { threshold_db: -30 });
    expect(res.ok).toBe(true);
    // in-place prototype has no trailing out buffer.
    expect(boundPrototypes[0]).toBe(
      "void bridge_noise_gate(float* samples, int n, float threshold_db, float attack_ms, float release_ms, int sample_rate)",
    );
    const args = calls[0]!;
    expect(args[1]).toBe(4); // sample count
    // last param is sample_rate, overridden with the decoded 48000.
    expect(args[args.length - 1]).toBe(48000);
    expect(encodeAudio).toHaveBeenCalled();
  });

  it("uses an out buffer for out-buffer DSP ops", async () => {
    const { lib, boundPrototypes } = makeFakeLib();
    const dispatch = new NativeDispatch(audioBindings, lib, undefined, "/fake/audio.dll");
    await dispatch.applyOp("/in.wav", "pitch_shift", "/out.wav", { semitones: 3 });
    expect(boundPrototypes[0]).toBe(
      "void bridge_pitch_shift(float* samples, int n, float semitones, float* out)",
    );
  });
});
