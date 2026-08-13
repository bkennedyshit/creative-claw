import { readFile } from "node:fs/promises";
import { describe, it, expect, vi } from "vitest";
import { setGpuBroker, withGpuClaim, withoutGpuClaim } from "./gpu-coop.js";
import { registerProviders } from "./providers.js";
import type { AudioEngineRuntime } from "./runtime/audio.js";
import type { ImageEngineRuntime } from "./runtime/image.js";
import type { VideoEngineRuntime } from "./runtime/video.js";

const engines = {
  image: { isAvailable: () => true } as unknown as ImageEngineRuntime,
  audio: { isAvailable: () => true } as unknown as AudioEngineRuntime,
  video: {
    ensureStarted: async () => {},
    isAvailable: () => true,
    reason: () => undefined,
    apply: async () => ({ ok: true }),
    analyze: async () => ({ ok: true, data: { cuts: [] } }),
  } as unknown as VideoEngineRuntime,
};

/** Minimal api stub: register() only stores closures, it never invokes them. */
function providerApiStub(overrides: Record<string, unknown> = {}) {
  return {
    config: {},
    logger: { warn() {}, debug() {}, info() {}, error() {} },
    runtime: {
      config: { current: () => ({}) },
      agent: { resolveAgentDir: () => "/tmp/agent" },
      mediaUnderstanding: {
        describeImageFileWithModel: vi.fn(),
        transcribeAudioFile: vi.fn(),
      },
    },
    registerImageGenerationProvider: vi.fn(),
    registerMediaUnderstandingProvider: vi.fn(),
    registerMusicGenerationProvider: vi.fn(),
    registerVideoGenerationProvider: vi.fn(),
    ...overrides,
  };
}

describe("registerProviders — understanding yes, generation no", () => {
  /**
   * These engines are deterministic C++ EDITING engines: there is no `generate`
   * op in the image/audio/video catalogs and nothing turns a text prompt into
   * media. The plugin used to register image/music/video generation providers
   * whose bodies all called `engine.apply(req.prompt, "generate", …)` and failed
   * 100% of the time, plus an id-only media-understanding provider with no hook
   * at all. All four were removed.
   *
   * Exactly one came back, and only because it is now genuinely implemented: a
   * media-understanding provider with a real `describeVideo` that extracts
   * keyframes with the video engine and describes them through the host's
   * configured vision model. These tests pin that boundary in both directions.
   */
  it("registers only a video-capable media-understanding provider", () => {
    // Pre-seed each seam with an existing provider: generation seams must survive
    // untouched, and the understanding seam must gain exactly our id.
    const registry = {
      image: ["comfy-image"] as string[],
      media: ["comfy-understanding"] as string[],
      music: ["comfy-audio"] as string[],
      video: ["comfy-video"] as string[],
    };
    const api = providerApiStub({
      registerImageGenerationProvider: (p: { id: string }) => registry.image.push(p.id),
      registerMediaUnderstandingProvider: (p: { id: string }) => registry.media.push(p.id),
      registerMusicGenerationProvider: (p: { id: string }) => registry.music.push(p.id),
      registerVideoGenerationProvider: (p: { id: string }) => registry.video.push(p.id),
    });

    registerProviders(api as never, engines);

    expect(registry.image).toEqual(["comfy-image"]);
    expect(registry.media).toEqual(["comfy-understanding", "creative-engines"]);
    expect(registry.music).toEqual(["comfy-audio"]);
    expect(registry.video).toEqual(["comfy-video"]);
  });

  it("never calls a GENERATION registration seam", () => {
    const api = providerApiStub();

    registerProviders(api as never, engines);

    expect(api.registerImageGenerationProvider).not.toHaveBeenCalled();
    expect(api.registerMusicGenerationProvider).not.toHaveBeenCalled();
    expect(api.registerVideoGenerationProvider).not.toHaveBeenCalled();
    expect(api.registerMediaUnderstandingProvider).toHaveBeenCalledTimes(1);
  });

  it("claims the video capability only, with a real hook behind it", () => {
    const api = providerApiStub();
    registerProviders(api as never, engines);
    const provider = (api.registerMediaUnderstandingProvider as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Record<string, unknown>;
    expect(provider.id).toBe("creative-engines");
    expect(provider.capabilities).toEqual(["video"]);
    expect(provider.describeVideo).toBeTypeOf("function");
    // No hook is advertised without an implementation behind it.
    expect(provider.describeImage).toBeUndefined();
    expect(provider.describeImages).toBeUndefined();
    expect(provider.transcribeAudio).toBeUndefined();
    expect(provider.extractStructured).toBeUndefined();
  });

  it("claims nothing when video understanding is disabled in plugin config", () => {
    const api = providerApiStub();
    registerProviders(api as never, engines, { mediaUnderstanding: { enabled: false } });
    expect(api.registerMediaUnderstandingProvider).not.toHaveBeenCalled();
  });

  /**
   * CONSUMES the host audio pipeline, does not CLAIM to be one.
   *
   * `describeVideo` folds a transcript in (see media/video-understanding.ts), but
   * the ASR itself is whatever the user configured under
   * `tools.media.audio.models[]`. Registering `transcribeAudio` here would put
   * this plugin's id in front of that config for every audio attachment in the
   * system while contributing nothing to the transcription — the audio engine's
   * 45 ops contain no ASR. That is the fabrication this asserts against.
   */
  it("consumes the host audio pipeline without claiming the audio capability", () => {
    const api = providerApiStub();
    registerProviders(api as never, engines);
    const provider = (api.registerMediaUnderstandingProvider as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Record<string, unknown>;
    expect(provider.capabilities).toEqual(["video"]);
    expect(provider.transcribeAudio).toBeUndefined();
    // Present on the runtime stub above, so absence here is a deliberate
    // non-registration rather than a missing host seam.
    expect(
      (api.runtime as { mediaUnderstanding: { transcribeAudioFile: unknown } }).mediaUnderstanding
        .transcribeAudioFile,
    ).toBeTypeOf("function");
  });

  it("still registers when the host build exposes no transcribeAudioFile seam", () => {
    const api = providerApiStub({
      runtime: {
        config: { current: () => ({}) },
        agent: { resolveAgentDir: () => "/tmp/agent" },
        mediaUnderstanding: { describeImageFileWithModel: vi.fn() },
      },
    });
    expect(() => registerProviders(api as never, engines)).not.toThrow();
    expect(api.registerMediaUnderstandingProvider).toHaveBeenCalledTimes(1);
  });
});

describe("no plugin-owned model transport", () => {
  /**
   * The whole honesty argument for this provider rests on the model calls going
   * through the HOST (`describeImageFileWithModel`, `transcribeAudioFile`) so the
   * user's provider registry, auth, base URLs and timeouts apply. A plugin-owned
   * HTTP client or a spawned speech binary would quietly reintroduce a second,
   * unconfigurable model path — which is how a capability starts being faked.
   */
  it("video understanding owns no HTTP client and spawns no ASR process", async () => {
    const source = await readFile(
      new URL("./media/video-understanding.ts", import.meta.url),
      "utf8",
    );
    const code = source.replace(/\/\*\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
    expect(code).not.toMatch(/\bfetch\s*\(/u);
    expect(code).not.toMatch(/node:child_process/u);
    expect(code).not.toMatch(/\bspawn(?:Sync)?\s*\(/u);
    expect(code).not.toMatch(/\bwhisper\b/iu);
    // The transcript arrives through the injected host seam and nowhere else.
    expect(code).toMatch(/deps\.transcribeAudio/u);
  });

  it("registration binds the transcript to the host runtime seam", async () => {
    const source = await readFile(new URL("./providers.ts", import.meta.url), "utf8");
    expect(source).toMatch(/transcribeAudio:\s*\(params\)\s*=>/u);
    expect(source).toMatch(/api\.runtime\.mediaUnderstanding\.transcribeAudioFile\(params\)/u);
  });
});

describe("plugin manifest — declares only contracts the plugin honours", () => {
  it("declares the media-understanding provider it registers and no generation contracts", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as {
      providers?: string[];
      contracts?: Record<string, unknown>;
    };

    expect(manifest.providers).toBeUndefined();
    expect(manifest.contracts?.imageGenerationProviders).toBeUndefined();
    expect(manifest.contracts?.musicGenerationProviders).toBeUndefined();
    expect(manifest.contracts?.videoGenerationProviders).toBeUndefined();
    // Required for the host to resolve this provider outside the already-loaded
    // registry (src/plugins/capability-provider-runtime.ts resolveCapabilityPluginIds).
    expect(manifest.contracts?.mediaUnderstandingProviders).toEqual(["creative-engines"]);
    // The op tools are the real, working surface and stay declared.
    expect(manifest.contracts?.tools).toContain("image.apply");
  });

  it("keeps the declared provider id in step with the registered one", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { contracts?: { mediaUnderstandingProviders?: string[] } };
    const api = providerApiStub();
    registerProviders(api as never, engines);
    const registeredIds = (
      api.registerMediaUnderstandingProvider as ReturnType<typeof vi.fn>
    ).mock.calls.map((call) => (call[0] as { id: string }).id);
    expect(registeredIds).toEqual(manifest.contracts?.mediaUnderstandingProviders);
  });
});

describe("gpu-coop — cooperation semantics", () => {
  it("pure-C++ ops (withoutGpuClaim) run directly with no broker interaction", async () => {
    const fn = vi.fn(async () => "done");
    await expect(withoutGpuClaim(fn)).resolves.toBe("done");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("model-heavy ops run directly when no broker is configured", async () => {
    // Runs before setGpuBroker: broker is still undefined here.
    const fn = vi.fn(async () => 42);
    await expect(withGpuClaim(fn)).resolves.toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("model-heavy ops release then reclaim the GPU around execution when a broker is set", async () => {
    const order: string[] = [];
    setGpuBroker({
      release: async () => void order.push("release"),
      reclaim: async () => void order.push("reclaim"),
    });

    await withGpuClaim(async () => void order.push("run"));
    expect(order).toEqual(["release", "run", "reclaim"]);
  });

  it("reclaims the GPU even if the op throws (honors user claim on failure)", async () => {
    const reclaim = vi.fn(async () => {});
    setGpuBroker({ release: async () => {}, reclaim });
    await expect(
      withGpuClaim(async () => {
        throw new Error("kaboom");
      }),
    ).rejects.toThrow(/kaboom/);
    expect(reclaim).toHaveBeenCalledTimes(1);
  });

  /**
   * The keyframe vision call must NOT take a GPU claim.
   *
   * `withGpuClaim` -> `broker.release()` -> `GpuBroker.evictAllModels()` POSTs
   * `keep_alive: 0` to every resident Ollama model. The vision model IS an
   * Ollama model, so a claim here would evict the model the call is about to
   * use. This asserts the video-understanding module never imports the claim
   * helpers, so the decision cannot regress by accident.
   */
  it("video understanding does not wrap the vision call in a GPU claim", async () => {
    const source = await readFile(
      new URL("./media/video-understanding.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/^\s*import\b.*gpu-coop/mu);
    expect(source).not.toMatch(/\bwithGpuClaim\s*\(/u);
  });
});
