import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { EngineBindingModule } from "../ffi/binding-types.js";
import type { CodecConfig } from "../ffi/codec.js";
import { NativeDispatch } from "../ffi/dispatch.js";
import { loadEngine, unloadEngine, type KoffiLib } from "../ffi/loader.js";
import type {
  ApplyResult,
  BatchItemResult,
  EngineConfig,
  OpCatalog,
  OpInfo,
  RunManifest,
  Step,
} from "../types.js";

export interface EngineRuntimeOptions {
  engineName: string;
  /** koffi binding catalog for this engine. */
  bindings: EngineBindingModule;
  config: EngineConfig;
  /** Codec config (ffmpeg location) for audio/video engines. */
  codec?: CodecConfig;
}

/**
 * Base for all engine runtimes.
 *
 * NATIVE, IN-PROCESS. The compiled C++ engine is loaded into this process via
 * koffi and called directly — there is no HTTP, no co-process, no health-check
 * loop, and no Python. A missing native library is reported honestly through
 * {@link isAvailable} so the plugin degrades gracefully instead of crashing.
 *
 * The interface (start/shutdown/isAvailable/listOps/opInfo/apply/applyChain/
 * batch) is identical to the previous co-process runtime so the agent-facing
 * tool surface is unchanged.
 */
export abstract class EngineRuntime {
  readonly engineName: string;
  readonly binaryPath: string | undefined;

  private readonly bindings: EngineBindingModule;
  private readonly codec: CodecConfig | undefined;
  private lib: KoffiLib | undefined;
  private dispatch: NativeDispatch | undefined;
  private available = false;
  private unavailableReason: string | undefined;
  private resolvedPath: string | undefined;
  private unloadSkipped: string | undefined;
  /** In-flight/settled load, so concurrent callers map the library once. */
  private starting: Promise<void> | undefined;
  /** Set by shutdown(); blocks {@link ensureStarted} from re-mapping. */
  private stopped = false;

  constructor(options: EngineRuntimeOptions) {
    this.engineName = options.engineName;
    this.binaryPath = options.config.binaryPath;
    this.bindings = options.bindings;
    this.codec = options.codec;
  }

  /**
   * Load the native library in-process. Never throws for a missing binary.
   *
   * Memoized: the gateway service calls this at boot and {@link ensureStarted}
   * calls it on first use in a process that has no service, and the library must
   * be mapped exactly once either way. A repeat call is a no-op that resolves
   * against the first load.
   */
  async start(): Promise<void> {
    this.stopped = false;
    this.starting ??= this.load();
    await this.starting;
  }

  /**
   * Start on demand, once, before any dispatch.
   *
   * THIS IS WHAT MAKES THE ENGINES WORK OUTSIDE THE GATEWAY. `start()` is
   * registered as a gateway SERVICE (`extensions/creative-engines/index.ts`), so
   * a standalone `openclaw creative ...` process — or a direct `describeVideo`
   * call — ran `register()` but never the service, leaving `dispatch` undefined:
   * `apply` threw "engine not started" and `list-ops` reported
   * `available:false` on a machine where the DLLs were present and fine. Every
   * async entry point funnels through here so the gateway and standalone paths
   * are one code path, not two.
   *
   * Deliberately does NOT restart after {@link shutdown}. Cleanup runs at
   * process teardown, ORT may still be mapped (see `unloadEngine`), and
   * re-mapping a bridge there trades a clean exit for a native crash. A caller
   * that genuinely wants a restart calls {@link start} explicitly.
   */
  async ensureStarted(): Promise<void> {
    if (this.stopped) {
      return;
    }
    await this.start();
  }

  /** The actual load. Only ever invoked through the {@link starting} memo. */
  private async load(): Promise<void> {
    this.unloadSkipped = undefined;
    // Maps ONNX Runtime by absolute path before the bridge (loadEngine ->
    // preloadOnnxRuntime). That ordering is a crash guard, and it is memoized
    // process-wide, so it holds no matter which engine happens to start first.
    const result = loadEngine(this.bindings.libraryStem, this.binaryPath);
    if (result.available) {
      this.lib = result.lib;
      this.resolvedPath = result.path;
      this.available = true;
      this.unavailableReason = undefined;
    } else {
      this.lib = undefined;
      this.resolvedPath = result.path;
      this.available = false;
      this.unavailableReason = result.reason;
    }
    // Build the dispatcher either way; it reports unavailable honestly when the
    // library is missing (no throw, no HTTP).
    this.dispatch = new NativeDispatch(
      this.bindings,
      this.lib,
      this.codec,
      this.resolvedPath ?? this.binaryPath,
    );
  }

  /**
   * Tear down this runtime. BOUNDED BY CONSTRUCTION — it cannot wedge a gateway
   * restart.
   *
   * The wedge this replaces: `shutdown()` used to call the native unload FIRST.
   * Once ONNX Runtime is mapped into the process, `koffi`'s `unload()`
   * (`FreeLibrary` / `dlclose`) runs the bridge's and ORT's static teardown
   * while ORT's intra-op thread pools are still alive, and on Windows that
   * deadlocks under the loader lock. Measured directly: with the unload,
   * `shutdown()` never returned (killed at 120 s); with it skipped the same
   * script finished and the process exited 0 in ~3 s.
   *
   * A JS timeout is NOT a fix for that and none is used here: a blocked
   * synchronous FFI call owns the only JS thread, so no timer can fire to
   * interrupt it. The bound comes from ordering plus not making the call that
   * blocks:
   *   1. Drop the dispatcher and library references and mark the engine
   *      unavailable. This always completes, so nothing can dispatch into the
   *      engine after `shutdown()` resolves.
   *   2. Only then attempt the native unload, which `unloadEngine` skips
   *      outright whenever ORT is mapped, recording why.
   *
   * The skip reason is retained on {@link unloadSkippedReason} so a left-mapped
   * library is visible rather than silent.
   */
  async shutdown(): Promise<void> {
    const lib = this.lib;
    this.stopped = true;
    this.starting = undefined;
    this.lib = undefined;
    this.dispatch = undefined;
    this.available = false;
    this.unavailableReason = "engine shut down";
    this.unloadSkipped = unloadEngine(lib);
  }

  /**
   * Why the native library was left mapped at shutdown, or undefined when it
   * was unloaded (or was never loaded).
   */
  unloadSkippedReason(): string | undefined {
    return this.unloadSkipped;
  }

  isAvailable(): boolean {
    return this.available;
  }

  /** Human-readable reason the engine is unavailable, when applicable. */
  reason(): string | undefined {
    return this.available ? undefined : this.unavailableReason;
  }

  private ensureDispatch(): NativeDispatch {
    if (!this.dispatch) {
      throw new Error(`engine '${this.engineName}' not started`);
    }
    return this.dispatch;
  }

  listOps(): OpCatalog {
    return this.ensureDispatch().listOps();
  }

  opInfo(opId: string): OpInfo {
    const info = this.ensureDispatch().opInfo(opId);
    if (!info) {
      throw new Error(`unknown op '${opId}' for engine '${this.engineName}'`);
    }
    return info;
  }

  async apply(
    input: string,
    op: string,
    output: string,
    params: Record<string, unknown>,
  ): Promise<ApplyResult> {
    await this.ensureStarted();
    return this.ensureDispatch().applyOp(input, op, output, params);
  }

  async applyChain(input: string, steps: Step[], output: string): Promise<ApplyResult> {
    await this.ensureStarted();
    return this.ensureDispatch().applyChain(input, steps, output);
  }

  /**
   * Run an `analysis`-kind op, which returns DATA rather than media (video
   * `detect_scenes` / `detect_silence`).
   *
   * `apply()` deliberately refuses these ops — there is no output file to write
   * — so without this seam the dispatcher's `analyze()` was unreachable from
   * outside the FFI layer and the scene-cut timestamps it produces could not be
   * consumed. It is intentionally NOT a new agent tool: the analysis data is
   * consumed in-process by keyframe sampling, and adding a tool would require a
   * manifest `contracts.tools` entry.
   */
  async analyze(
    input: string,
    op: string,
    params: Record<string, unknown> = {},
  ): Promise<{ ok: boolean; data?: unknown; reason?: string }> {
    await this.ensureStarted();
    return this.ensureDispatch().analyze(input, op, params);
  }

  /**
   * Run a pipeline over multiple inputs. One failure never aborts the batch —
   * each item is isolated and recorded in the manifest.
   */
  async batch(
    inputSet: { glob?: string; folder?: string; list?: string[] },
    pipeline: Step[],
    outputDir: string,
  ): Promise<{ items: BatchItemResult[]; manifest: RunManifest }> {
    const started = new Date().toISOString();
    const inputs = await resolveInputSet(inputSet);
    const items: BatchItemResult[] = [];

    for (const input of inputs) {
      const output = join(outputDir, basename(input));
      const start = Date.now();
      try {
        const result = await this.applyChain(input, pipeline, output);
        items.push({
          input_path: input,
          output_path: output,
          ok: result.ok,
          duration_ms: Date.now() - start,
          error: result.ok ? undefined : result.reason,
        });
      } catch (err) {
        items.push({
          input_path: input,
          output_path: output,
          ok: false,
          duration_ms: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const succeeded = items.filter((i) => i.ok).length;
    const manifest: RunManifest = {
      started_at: started,
      completed_at: new Date().toISOString(),
      total_items: items.length,
      succeeded,
      failed: items.length - succeeded,
      output_dir: outputDir,
      items,
    };
    return { items, manifest };
  }
}

/** Resolve an input specification into a concrete list of file paths. */
async function resolveInputSet(spec: {
  glob?: string;
  folder?: string;
  list?: string[];
}): Promise<string[]> {
  if (spec.list?.length) {
    return spec.list;
  }
  if (spec.folder) {
    const entries = await readdir(spec.folder, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => join(spec.folder!, e.name));
  }
  if (spec.glob) {
    // Minimal glob: read the directory portion and match the trailing pattern.
    const dir = dirname(spec.glob);
    const pattern = basename(spec.glob);
    const re = new RegExp(
      `^${pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")}$`,
    );
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    return entries.filter((e) => e.isFile() && re.test(e.name)).map((e) => join(dir, e.name));
  }
  return [];
}
