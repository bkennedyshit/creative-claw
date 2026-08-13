import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * Creative Claw — Integration Smoke Test
 *
 * Every assertion below drives a REAL module. Nothing in this file
 * reimplements product logic: the embedder, vector store, pathmeta helpers,
 * GPU broker, and image engine are all imported from their shipping sources.
 *
 * Environment-gated: engine / GPU / Ollama / ffmpeg tests skip with an explicit
 * reason when the dependency is genuinely absent, and the "Skip Reasons" block
 * at the bottom reports what actually ran.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
// ---------- REAL modules under test ----------
import { decodeImageRGBA } from "./creative-engines/src/ffi/codec.js";
import { resolveBinaryPath } from "./creative-engines/src/ffi/loader.js";
// cross-plugin GPU coop global slot — cleaned between tests (isolate: false lane)
import { GPU_BROKER_HANDLE_KEY } from "./creative-engines/src/gpu-broker-handle.js";
import { AudioEngineRuntime } from "./creative-engines/src/runtime/audio.js";
// creative-engines: native in-process engine runtimes + the real path resolver
import { ImageEngineRuntime } from "./creative-engines/src/runtime/image.js";
import { VectorEngineRuntime } from "./creative-engines/src/runtime/vector.js";
import { VideoEngineRuntime } from "./creative-engines/src/runtime/video.js";
// gpu-broker: the real cooperative VRAM arbiter + its state enum
import { GpuBroker } from "./gpu-broker/src/broker.js";
import { BrokerState } from "./gpu-broker/src/types.js";
// visual-memory: the trusted-tool-policy guard that consumes shouldWarnOnEdit
import { evaluateProtectedEdit } from "./visual-memory/src/edit-guard.js";
// visual-memory: embedder (extensions/visual-memory/src/embedder/)
import { HashEmbedder, resolveEmbedder } from "./visual-memory/src/embedder/index.js";
// visual-memory: workspace path conventions
import {
  buildMetadata,
  buildPathMetadata,
  classifyIntent,
  inferBrand,
  shouldWarnOnEdit,
} from "./visual-memory/src/pathmeta.js";
// visual-memory: SQLite-backed vector store (better-sqlite3)
import { VectorStore } from "./visual-memory/src/store.js";

// ---------- Environment detection ----------

function hasNvidiaSmi(): boolean {
  try {
    execSync("nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function hasOllama(): boolean {
  try {
    const cmd = process.platform === "win32" ? "where ollama" : "which ollama";
    execSync(cmd, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * The shipping engines are native shared libraries bundled at
 * `extensions/creative-engines/binaries/libomni_*_bridge.{dll,so,dylib}` and
 * loaded in-process via koffi. Resolution goes through the REAL loader
 * (`resolveBinaryPath`), so this probe is cross-platform by construction and
 * matches exactly what `EngineRuntime.start()` will look for at runtime.
 *
 * (The previous probe looked for `~/.openclaw/creative-claw/bin/cc-*` CLI
 * binaries from an abandoned co-process architecture. Those never exist, so
 * every engine assertion in this file silently skipped.)
 */
const ENGINE_STEMS = [
  "omni_image_bridge",
  "omni_audio_bridge",
  "omni_video_bridge",
  "omni_vector_bridge",
] as const;

function resolvedEngineLibraries(): Record<string, string | undefined> {
  return Object.fromEntries(ENGINE_STEMS.map((stem) => [stem, resolveBinaryPath(stem)]));
}

function hasEngines(): boolean {
  return ENGINE_STEMS.every((stem) => resolveBinaryPath(stem) !== undefined);
}

function hasFfmpeg(): boolean {
  try {
    const cmd = process.platform === "win32" ? "where ffmpeg" : "which ffmpeg";
    execSync(cmd, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const GPU_AVAILABLE = hasNvidiaSmi();
const ENGINES_AVAILABLE = hasEngines();
const OLLAMA_AVAILABLE = hasOllama();
const FFMPEG_AVAILABLE = hasFfmpeg();

/**
 * A real 108-byte 4x4 RGBA PNG (non-interlaced, deflate IDAT). Deliberately
 * NOT grayscale and NOT uniform, so a grayscale/scale op has observable work
 * to do and a no-op would fail the assertions below.
 */
const PNG_4X4_RGBA_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAM0lEQVR4nBXIMREAQRDDsK8XWIAFWGqz8s+p1HeHOezhDr8LJtjg8qKYYovri2GGHW74A/xIKPGjpQFDAAAAAElFTkSuQmCC";

/** Broker config that is safe in a test: no nvidia-smi poll loop, no real Ollama. */
const TEST_BROKER_CONFIG = {
  // Closed port: eviction is a real fetch that fails fast, so we never evict
  // the developer's actually-loaded Ollama models.
  ollamaBaseUrl: "http://127.0.0.1:1",
  // Dormant + a poll interval far beyond the test run means no nvidia-smi loop.
  dormantOverride: true,
  pollIntervalMs: 3_600_000,
} as const;

/** The coop slot is process-global and this lane runs with isolate: false. */
function clearGpuBrokerGlobal(): void {
  delete (globalThis as unknown as Record<string, unknown>)[GPU_BROKER_HANDLE_KEY];
}

// ---------- Real always-runnable tests ----------

describe("Creative Claw Smoke — Real Modules (no external deps)", () => {
  describe("HashEmbedder (visual-memory/src/embedder/hash.ts)", () => {
    it("produces a deterministic, L2-normalized embedding for the same text", async () => {
      const embedder = new HashEmbedder(512);
      expect(embedder.dim).toBe(512);
      // The hash backend must never claim to be semantic.
      expect(embedder.semantic).toBe(false);

      const a = await embedder.embedText("sunset over ocean");
      const b = await embedder.embedText("sunset over ocean");
      const c = await embedder.embedText("cat sitting on a desk");

      expect(a.length).toBe(512);
      expect(Array.from(a)).toEqual(Array.from(b));
      expect(Array.from(a)).not.toEqual(Array.from(c));

      const norm = Math.sqrt(Array.from(a).reduce((s, v) => s + v * v, 0));
      expect(norm).toBeCloseTo(1, 5);
    });

    it("embeds a real file's bytes and stays deterministic", async () => {
      const dir = mkdtempSync(join(tmpdir(), "cc-smoke-embed-"));
      try {
        const file = join(dir, "fixture.png");
        writeFileSync(file, Buffer.from(PNG_4X4_RGBA_BASE64, "base64"));
        const embedder = new HashEmbedder(512);
        const v1 = await embedder.embedImage(file);
        const v2 = await embedder.embedImage(file);
        expect(v1.length).toBe(512);
        expect(Array.from(v1)).toEqual(Array.from(v2));
        expect(Math.sqrt(Array.from(v1).reduce((s, v) => s + v * v, 0))).toBeCloseTo(1, 5);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("reports an unsupported backend as an explicit degradation", () => {
      const ok = resolveEmbedder({ backend: "hash", dim: 512 });
      expect(ok.report).toMatchObject({ used: "hash", degraded: false, semantic: false });

      const degraded = resolveEmbedder({ backend: "clip", dim: 512 });
      expect(degraded.report.used).toBe("hash");
      expect(degraded.report.requested).toBe("clip");
      expect(degraded.report.degraded).toBe(true);
      expect(degraded.report.semantic).toBe(false);
      expect(degraded.report.reason).toMatch(/not implemented/i);
      expect(degraded.embedder.dim).toBe(512);
    });
  });

  describe("VectorStore (visual-memory/src/store.ts, real better-sqlite3)", () => {
    let dir: string;
    let store: VectorStore;
    let embedder: HashEmbedder;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "cc-smoke-store-"));
      store = new VectorStore({ dbPath: join(dir, "smoke.sqlite") });
      embedder = new HashEmbedder(512);
    });

    afterAll(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it("persists real embeddings to disk and ranks search by cosine similarity", async () => {
      const sunset = await embedder.embedText("sunset over the ocean");
      const sunsetAlt = await embedder.embedText("sunset over the ocean at dusk");
      const desk = await embedder.embedText("keyboard and mouse on a wooden desk");

      const sunsetId = store.upsert({
        path: "/ws/content/acme/posts/sunset.png",
        type: "image",
        timestamp: 1,
        dim: 512,
        embedding: sunset,
        // Real indexer path: buildMetadata() is what the product stores.
        metadata: buildMetadata("/ws/content/acme/posts/sunset.png", "/ws"),
      });
      store.upsert({
        path: "/ws/content/acme/posts/sunset-dusk.png",
        type: "image",
        timestamp: 2,
        dim: 512,
        embedding: sunsetAlt,
        metadata: {},
      });
      store.upsert({
        path: "/ws/output/desk.png",
        type: "image",
        timestamp: 3,
        dim: 512,
        embedding: desk,
        metadata: {},
      });

      expect(store.count()).toBe(3);

      // Round-tripped through SQLite as a BLOB: the vector must survive intact.
      const roundTripped = store.getById(sunsetId);
      expect(roundTripped).not.toBeNull();
      expect(Array.from(roundTripped!.embedding)).toEqual(Array.from(sunset));
      // pathmeta-derived metadata survives the JSON column.
      expect(roundTripped!.metadata.brand).toBe("acme");
      expect(roundTripped!.metadata.warnOnEdit).toBe(true);

      const results = store.search(sunset, { topK: 10, minScore: 0 });
      expect(results.length).toBe(3);
      expect(results[0]!.path).toBe("/ws/content/acme/posts/sunset.png");
      expect(results[0]!.score).toBeCloseTo(1, 5);
      // The near-duplicate phrase must outrank the unrelated one.
      expect(results[1]!.path).toBe("/ws/content/acme/posts/sunset-dusk.png");
      expect(results[1]!.score).toBeGreaterThan(results[2]!.score);
      expect(results[2]!.path).toBe("/ws/output/desk.png");
    });

    it("honours typeFilter and deletes rows", async () => {
      const q = await embedder.embedText("a short note");
      const id = store.upsert({
        path: "/ws/output/notes.md",
        type: "text",
        timestamp: 4,
        dim: 512,
        embedding: q,
        metadata: {},
      });

      const textOnly = store.search(q, { topK: 10, minScore: 0, typeFilter: "text" });
      expect(textOnly.map((r) => r.path)).toEqual(["/ws/output/notes.md"]);

      expect(store.delete(id)).toBe(true);
      expect(store.getById(id)).toBeNull();
      expect(store.delete(id)).toBe(false);
    });
  });

  describe("pathmeta (visual-memory/src/pathmeta.ts)", () => {
    it("infers brand from the segment after a workspace root", () => {
      expect(inferBrand("/ws/content/acme/posts/img.png", "/ws")).toBe("acme");
      expect(inferBrand("/ws/output/acme/reels/clip.mp4", "/ws")).toBe("acme");
      // Windows separators normalize.
      expect(inferBrand("C:\\ws\\content\\acme\\posts\\img.png", "C:\\ws")).toBe("acme");
      // No recognized workspace root → no brand.
      expect(inferBrand("/ws/random/thing.png", "/ws")).toBeUndefined();
    });

    it("classifies intent from folder hints", () => {
      expect(classifyIntent("/ws/content/acme/posts/img.png")).toBe("post");
      expect(classifyIntent("/ws/content/acme/reels/clip.mp4")).toBe("reel");
      expect(classifyIntent("/ws/content/acme/stories/s.png")).toBe("story");
      expect(classifyIntent("/ws/input/acme/footage/raw.mp4")).toBe("video");
      expect(classifyIntent("/ws/output/acme/final.png")).toBeUndefined();
    });

    it("flags /content/ paths as protected on edit", () => {
      expect(shouldWarnOnEdit("/ws/content/acme/hero.png")).toBe(true);
      expect(shouldWarnOnEdit("C:\\ws\\Content\\acme\\logo.svg")).toBe(true);
      expect(shouldWarnOnEdit("/ws/output/result.png")).toBe(false);
      expect(shouldWarnOnEdit("/ws/input/source.jpg")).toBe(false);
    });

    it("builds combined metadata", () => {
      expect(buildPathMetadata("/ws/content/acme/posts/img.png", "/ws")).toEqual({
        brand: "acme",
        intent: "post",
        warnOnEdit: true,
      });
    });

    it("blocks a write to an absolute /content/ path via the real edit guard", () => {
      const decision = evaluateProtectedEdit({
        toolName: "write",
        params: { path: "/ws/content/acme/hero.png" },
      });
      expect(decision?.allow).toBe(false);
      expect(decision?.reason).toMatch(/protected source media/i);
    });

    /**
     * REGRESSION PIN for a fixed guardrail bypass.
     *
     * `shouldWarnOnEdit` used to match the literal substring `"/content/"`, so a
     * workspace-RELATIVE target ("content/acme/hero.png") had no leading
     * separator and was not flagged. `evaluateProtectedEdit` runs on the raw
     * `path` / `file_path` tool params, which agents routinely pass as
     * workspace-relative, so the protected-content guardrail could be bypassed
     * by simply omitting the leading slash: the guard returned `undefined`
     * ("no opinion") and the host allowed the overwrite.
     *
     * It now matches a `content` path SEGMENT. This test asserts the relative
     * form is blocked, and that the fix did not start flagging directories that
     * merely begin with the word.
     */
    it("blocks workspace-relative content/ writes (fixed bypass)", () => {
      expect(shouldWarnOnEdit("content/acme/hero.png")).toBe(true);
      const decision = evaluateProtectedEdit({
        toolName: "write",
        params: { path: "content/acme/hero.png" },
      });
      expect(decision?.allow).toBe(false);
      expect(decision?.reason).toMatch(/protected source media/i);
    });

    it("does not flag directories that merely start with 'content'", () => {
      expect(shouldWarnOnEdit("contents/acme/hero.png")).toBe(false);
      expect(shouldWarnOnEdit("my_content/acme/hero.png")).toBe(false);
      expect(
        evaluateProtectedEdit({ toolName: "write", params: { path: "contents/acme/hero.png" } }),
      ).toBeUndefined();
    });
  });

  describe("GpuBroker (gpu-broker/src/broker.ts, real instance)", () => {
    let broker: GpuBroker;

    beforeEach(() => {
      clearGpuBrokerGlobal();
      broker = new GpuBroker(TEST_BROKER_CONFIG);
    });

    afterEach(() => {
      broker.stop();
      clearGpuBrokerGlobal();
    });

    it("starts dormant under dormantOverride without polling nvidia-smi", () => {
      expect(broker.getState()).toBe(BrokerState.Idle);
      broker.start();
      expect(broker.getState()).toBe(BrokerState.Dormant);
      // dormantOverride returns before calibrateBaseline(), so no nvidia-smi ran.
      expect(broker.getSnapshot()).toBeNull();
      expect(broker.getBaselineVramMb()).toBe(0);
    });

    it("release() grants a real lease and blocks agent runs", async () => {
      expect(broker.canAgentRun()).toBe(true);
      const lease = await broker.release("user", "smoke test", 60_000);

      expect(lease.token).toBeTruthy();
      expect(lease.owner).toBe("user");
      expect(lease.reason).toBe("smoke test");
      expect(lease.expiresAt).toBeGreaterThan(lease.grantedAt);
      expect(broker.getState()).toBe(BrokerState.UserClaimed);
      expect(broker.getLease()?.token).toBe(lease.token);
      expect(broker.canAgentRun()).toBe(false);

      // The real transition history records draining → user-claimed.
      const states = broker.getHistory().map((h) => h.to);
      expect(states).toContain(BrokerState.Draining);
      expect(states).toContain(BrokerState.UserClaimed);
    });

    it("reclaim() validates the token and returns to idle", async () => {
      expect(broker.reclaim()).toBe(false); // nothing leased yet

      const lease = await broker.release("user", undefined, 60_000);
      expect(broker.reclaim("not-the-token")).toBe(false);
      expect(broker.getState()).toBe(BrokerState.UserClaimed);

      expect(broker.reclaim(lease.token)).toBe(true);
      expect(broker.getState()).toBe(BrokerState.Idle);
      expect(broker.getLease()).toBeNull();
      expect(broker.canAgentRun()).toBe(true);
    });

    it("expires a short lease back to idle on its own", async () => {
      await broker.release("user", "short hold", 25);
      expect(broker.getState()).toBe(BrokerState.UserClaimed);
      await new Promise((r) => {
        setTimeout(r, 120);
      });
      expect(broker.getState()).toBe(BrokerState.Idle);
      expect(broker.getLease()).toBeNull();
    });

    it("handoff() holds the claim for the peer and reclaims afterwards", async () => {
      const seen: BrokerState[] = [];
      await broker.handoff(
        "peer",
        async () => {
          seen.push(broker.getState());
        },
        "handoff smoke",
      );
      expect(seen).toEqual([BrokerState.UserClaimed]);
      expect(broker.getState()).toBe(BrokerState.Idle);
      expect(broker.getLease()).toBeNull();
    });

    it("reports zero Ollama footprint when the endpoint is unreachable", async () => {
      // Closed port → real fetch failure → honest 0 / empty, never a guess.
      await expect(broker.getOllamaFootprintMb()).resolves.toBe(0);
      await expect(broker.getResidentModels()).resolves.toEqual([]);
    });

    it("does not leak the cross-plugin coop handle", () => {
      expect(
        (globalThis as unknown as Record<string, unknown>)[GPU_BROKER_HANDLE_KEY],
      ).toBeUndefined();
    });
  });
});

// ---------- Env-gated integration tests ----------

describe("Creative Claw Smoke — GPU + Engines Integration", () => {
  let tempDir: string;
  let inputPng: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cc-smoke-engines-"));
    inputPng = join(tempDir, "input-4x4.png");
    writeFileSync(inputPng, Buffer.from(PNG_4X4_RGBA_BASE64, "base64"));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    clearGpuBrokerGlobal();
  });

  afterEach(() => {
    clearGpuBrokerGlobal();
  });

  it.skipIf(!GPU_AVAILABLE)("nvidia-smi reports VRAM", () => {
    const result = execSync(
      "nvidia-smi --query-gpu=memory.free,memory.total --format=csv,noheader,nounits",
      { encoding: "utf-8" },
    );
    const [free, total] = result.trim().split(",").map(Number);
    expect(free).toBeGreaterThan(0);
    expect(total).toBeGreaterThan(0);
    expect(free).toBeLessThanOrEqual(total!);
  });

  it.skipIf(!OLLAMA_AVAILABLE)("ollama is responsive", async () => {
    const res = await fetch("http://127.0.0.1:11434/api/tags", {
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined);
    if (!res) {
      // Binary installed but daemon not serving — that is a genuine absence.
      console.log("Ollama: ❌ skipped (binary on PATH but daemon not answering)");
      return;
    }
    const parsed = (await res.json()) as { models?: unknown };
    expect(parsed).toHaveProperty("models");
  });

  it.skipIf(!FFMPEG_AVAILABLE)("ffmpeg version is parseable", () => {
    const result = execSync("ffmpeg -version", { encoding: "utf-8" });
    expect(result).toContain("ffmpeg version");
  });

  it.skipIf(!ENGINES_AVAILABLE)("all four native engine bridges resolve on this platform", () => {
    const resolved = resolvedEngineLibraries();
    for (const stem of ENGINE_STEMS) {
      const path = resolved[stem];
      expect(path, `${stem} did not resolve`).toBeTruthy();
      expect(existsSync(path!)).toBe(true);
      expect(statSync(path!).size).toBeGreaterThan(0);
      expect(path!).toMatch(/\.(dll|so|dylib)$/);
    }
  });

  it.skipIf(!ENGINES_AVAILABLE)(
    "every engine runtime loads its native library in-process",
    async () => {
      const runtimes = [
        new ImageEngineRuntime(),
        new AudioEngineRuntime(),
        new VideoEngineRuntime(),
        new VectorEngineRuntime(),
      ];
      try {
        for (const runtime of runtimes) {
          await runtime.start();
          expect(runtime.isAvailable(), `${runtime.engineName}: ${runtime.reason()}`).toBe(true);
          expect(runtime.reason()).toBeUndefined();
          // The op catalog comes from the real bindings, not a stub.
          const catalog = runtime.listOps();
          expect(catalog.engine).toBe(runtime.engineName);
          expect(catalog.ops.length).toBeGreaterThan(0);
        }
      } finally {
        await Promise.all(runtimes.map((r) => r.shutdown()));
      }
    },
  );

  it.skipIf(!ENGINES_AVAILABLE)(
    "image engine: real scale op turns a 4x4 PNG into a real 16x16 PNG",
    async () => {
      const runtime = new ImageEngineRuntime();
      await runtime.start();
      try {
        expect(runtime.isAvailable(), `image engine unavailable: ${runtime.reason()}`).toBe(true);

        const output = join(tempDir, "scaled-16x16.png");
        const result = await runtime.apply(inputPng, "scale", output, {
          new_width: 16,
          new_height: 16,
        });

        expect(result.ok, `scale failed: ${result.reason}`).toBe(true);
        expect(result.output_path).toBe(output);
        expect(result.engine_path).toMatch(/omni_image_bridge/);
        expect(existsSync(output)).toBe(true);
        expect(statSync(output).size).toBeGreaterThan(0);

        // Decode the produced file for real: the C++ engine must have written
        // 16x16 pixels, not just created a file.
        const decoded = await decodeImageRGBA(output);
        expect(decoded.width).toBe(16);
        expect(decoded.height).toBe(16);
        expect(decoded.data.length).toBe(16 * 16 * 4);
        // A zeroed buffer would mean the bridge never wrote anything.
        expect(decoded.data.some((byte) => byte !== 0)).toBe(true);
      } finally {
        await runtime.shutdown();
      }
    },
  );

  it.skipIf(!ENGINES_AVAILABLE)(
    "image engine: real grayscale op equalizes RGB channels",
    async () => {
      const runtime = new ImageEngineRuntime();
      await runtime.start();
      try {
        const source = await decodeImageRGBA(inputPng);
        // Sanity: the fixture is genuinely colored, so grayscale has work to do.
        let colored = false;
        for (let i = 0; i < source.data.length; i += 4) {
          if (source.data[i] !== source.data[i + 1] || source.data[i + 1] !== source.data[i + 2]) {
            colored = true;
            break;
          }
        }
        expect(colored).toBe(true);

        const output = join(tempDir, "gray-4x4.png");
        const result = await runtime.apply(inputPng, "grayscale", output, {});
        expect(result.ok, `grayscale failed: ${result.reason}`).toBe(true);
        expect(existsSync(output)).toBe(true);
        expect(statSync(output).size).toBeGreaterThan(0);

        const decoded = await decodeImageRGBA(output);
        expect(decoded.width).toBe(4);
        expect(decoded.height).toBe(4);
        for (let i = 0; i < decoded.data.length; i += 4) {
          expect(decoded.data[i]).toBe(decoded.data[i + 1]);
          expect(decoded.data[i + 1]).toBe(decoded.data[i + 2]);
        }
        expect(decoded.data.some((byte) => byte !== 0)).toBe(true);
      } finally {
        await runtime.shutdown();
      }
    },
  );

  it.skipIf(!ENGINES_AVAILABLE)(
    "image engine: chained ops run in-buffer and produce one real output",
    async () => {
      const runtime = new ImageEngineRuntime();
      await runtime.start();
      try {
        const output = join(tempDir, "chained.png");
        const result = await runtime.applyChain(
          inputPng,
          [
            { op: "grayscale", params: {} },
            { op: "scale", params: { new_width: 8, new_height: 8 } },
          ],
          output,
        );
        expect(result.ok, `chain failed: ${result.reason}`).toBe(true);
        const decoded = await decodeImageRGBA(output);
        expect(decoded.width).toBe(8);
        expect(decoded.height).toBe(8);
        expect(decoded.data.some((byte) => byte !== 0)).toBe(true);
      } finally {
        await runtime.shutdown();
      }
    },
  );

  it.skipIf(!ENGINES_AVAILABLE)(
    "image engine reports unknown ops honestly instead of writing a file",
    async () => {
      const runtime = new ImageEngineRuntime();
      await runtime.start();
      try {
        const output = join(tempDir, "never-written.png");
        const result = await runtime.apply(inputPng, "definitely_not_an_op", output, {});
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/unknown op/i);
        expect(existsSync(output)).toBe(false);
      } finally {
        await runtime.shutdown();
      }
    },
  );

  /**
   * REGRESSION GUARD — this pinned a real defect that is now fixed.
   *
   * `NativeDispatch.runImageOp` used to size the OUT BUFFER from
   * `params.new_width ?? width` / `params.new_height ?? height` (falling back to
   * the SOURCE dimension) while marshalling the same param to C++ through
   * `paramValue()`, whose fallback is the BINDING DEFAULT of `0`. The two
   * disagreed, so `scale { new_width: 16 }` on the 4x4 fixture allocated a 16x4
   * buffer and then told `bridge_scale` to write a 0-wide image: nothing was
   * written, the zeroed buffer was encoded to a real PNG, and the op reported
   * `ok: true`. The user got a blank file and a success result.
   *
   * `resolveOutputDims` (creative-engines/src/ffi/dispatch.ts) is now the single
   * source of truth: the resolved dimensions are written back into the params
   * used for BOTH the allocation and the scalar args, so they cannot disagree.
   * A missing dimension on a full-frame resample now genuinely means "keep the
   * source dimension".
   *
   * If this test ever goes all-zero again, the two paths have drifted apart.
   */
  it.skipIf(!ENGINES_AVAILABLE)(
    "a resizing op with one missing dimension keeps the source dimension and writes real pixels",
    async () => {
      const runtime = new ImageEngineRuntime();
      await runtime.start();
      try {
        const output = join(tempDir, "partial-scale.png");
        const result = await runtime.apply(inputPng, "scale", output, { new_width: 16 });

        expect(result.ok, `scale failed: ${result.reason}`).toBe(true);

        const decoded = await decodeImageRGBA(output);
        expect(decoded.width).toBe(16);
        expect(decoded.height).toBe(4); // missing new_height → source height
        // The whole point: a blank/zeroed buffer must never pass again.
        expect(decoded.data.every((byte) => byte === 0)).toBe(false);
        expect(decoded.data.some((byte) => byte !== 0)).toBe(true);
      } finally {
        await runtime.shutdown();
      }
    },
  );

  /**
   * The other half of the same contract: where a missing dimension has no
   * honest default (a crop RECTANGLE — `0` is an empty rect to `bridge_crop`,
   * not "the rest of the image"), the call must be REJECTED with a reason
   * naming the missing param rather than silently emitting a blank file.
   */
  it.skipIf(!ENGINES_AVAILABLE)(
    "a crop with no rectangle size is rejected instead of writing a blank file",
    async () => {
      const runtime = new ImageEngineRuntime();
      await runtime.start();
      try {
        const output = join(tempDir, "crop-no-size.png");
        const result = await runtime.apply(inputPng, "crop", output, { crop_x: 0, crop_y: 0 });

        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/crop_width/);
        expect(existsSync(output)).toBe(false);
      } finally {
        await runtime.shutdown();
      }
    },
  );

  it.skipIf(!ENGINES_AVAILABLE)(
    "full pipeline: real gpu.release → real image op → real gpu.reclaim",
    async () => {
      const broker = new GpuBroker(TEST_BROKER_CONFIG);
      const runtime = new ImageEngineRuntime();
      await runtime.start();
      try {
        expect(runtime.isAvailable(), `image engine unavailable: ${runtime.reason()}`).toBe(true);

        const lease = await broker.release("creative-claw-smoke", "engine op", 60_000);
        expect(broker.getState()).toBe(BrokerState.UserClaimed);
        expect(broker.canAgentRun()).toBe(false);

        const output = join(tempDir, "pipeline-out.png");
        const result = await runtime.apply(inputPng, "invert", output, {});
        expect(result.ok, `invert failed: ${result.reason}`).toBe(true);

        const decoded = await decodeImageRGBA(output);
        expect(decoded.width).toBe(4);
        expect(decoded.height).toBe(4);

        // invert must actually change the pixels.
        const source = await decodeImageRGBA(inputPng);
        expect(Buffer.compare(decoded.data, source.data)).not.toBe(0);

        expect(broker.reclaim(lease.token)).toBe(true);
        expect(broker.getState()).toBe(BrokerState.Idle);
        expect(broker.canAgentRun()).toBe(true);
      } finally {
        broker.stop();
        await runtime.shutdown();
      }
    },
  );
});

describe("Creative Claw Smoke — Skip Reasons", () => {
  it("reports GPU availability", () => {
    console.log(`GPU (nvidia-smi): ${GPU_AVAILABLE ? "✅" : "❌ skipped"}`);
    expect(typeof GPU_AVAILABLE).toBe("boolean");
  });

  it("reports engine availability", () => {
    const resolved = resolvedEngineLibraries();
    const detail = ENGINE_STEMS.map((stem) => `${stem}=${resolved[stem] ?? "missing"}`).join(", ");
    console.log(
      `Engines (libomni_*_bridge): ${ENGINES_AVAILABLE ? "✅" : "❌ skipped"} — ${detail}`,
    );
    expect(typeof ENGINES_AVAILABLE).toBe("boolean");
  });

  it("reports Ollama availability", () => {
    console.log(`Ollama: ${OLLAMA_AVAILABLE ? "✅" : "❌ skipped"}`);
    expect(typeof OLLAMA_AVAILABLE).toBe("boolean");
  });

  it("reports FFmpeg availability", () => {
    console.log(`FFmpeg: ${FFMPEG_AVAILABLE ? "✅" : "❌ skipped"}`);
    expect(typeof FFMPEG_AVAILABLE).toBe("boolean");
  });
});
