/**
 * koffi shared-library loader.
 *
 * Resolves and loads a compiled engine bridge (`.dll` on Windows, `.so` on
 * Linux, `.dylib` on macOS) directly into the OpenClaw process. There is no
 * co-process, no HTTP, and no child process for the engine itself — the C++
 * engine is mapped into this process and called in-process via koffi FFI.
 *
 * Missing binaries are reported honestly ({ available: false, reason }) rather
 * than throwing, so an engine whose native library is not installed degrades
 * gracefully instead of taking down the plugin.
 */

import koffi from "koffi";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** A loaded koffi library handle. `func(prototype)` binds a C export. */
export interface KoffiLib {
  func(prototype: string): (...args: unknown[]) => unknown;
  unload?: () => void;
}

/** Result of attempting to load an engine's native library. */
export type LoadResult =
  | { available: true; lib: KoffiLib; path: string }
  | { available: false; reason: string; path?: string };

const _here = dirname(fileURLToPath(import.meta.url));

/**
 * Directory that ships the bundled engine binaries. Resolved relative to the
 * built plugin so a packaged install finds the libraries next to the code.
 * Layout: `<extensionRoot>/binaries/<lib><stem>.<ext>`.
 */
function bundledBinariesDir(): string {
  // src/ffi/loader.ts -> extension root is two levels up from src/ffi.
  return resolve(_here, "..", "..", "binaries");
}

/** True when `path` exists and is a directory. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Platform-specific candidate file names for a library stem. */
function candidateFileNames(stem: string): string[] {
  if (process.platform === "win32") {
    // Windows builds ship both `lib`-prefixed and bare names historically.
    return [`lib${stem}.dll`, `${stem}.dll`];
  }
  if (process.platform === "darwin") {
    return [`lib${stem}.dylib`, `${stem}.dylib`, `lib${stem}.so`, `${stem}.so`];
  }
  return [`lib${stem}.so`, `${stem}.so`];
}

/**
 * Resolve the on-disk path of an engine library.
 *
 * Priority:
 *   1. An explicit `configuredPath` that is a library FILE.
 *   2. A platform-specific file inside `configuredPath` when it is a DIRECTORY
 *      (the plugin config schema documents both spellings).
 *   3. A platform-specific file inside the bundled `binaries/` directory.
 *
 * Returns the first existing path, or undefined when none is found.
 *
 * A directory `configuredPath` used to be returned verbatim (the `existsSync`
 * test passes for directories), so `koffi.load()` was handed a directory and
 * the documented "or a directory containing it" config spelling never worked.
 */
export function resolveBinaryPath(stem: string, configuredPath?: string): string | undefined {
  if (configuredPath) {
    if (isDirectory(configuredPath)) {
      for (const name of candidateFileNames(stem)) {
        const candidate = join(configuredPath, name);
        if (existsSync(candidate)) return candidate;
      }
    } else if (existsSync(configuredPath)) {
      return configuredPath;
    }
  }
  const dir = bundledBinariesDir();
  for (const name of candidateFileNames(stem)) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

// ── ONNX Runtime sidecar preload ────────────────────────────────────────────
//
// WHY THIS EXISTS (this is a process-crash guard, not an optimization):
//
// `libomni_image_bridge` links ONNX Runtime and requests ORT **API version 26**.
// Windows resolves an implicit `onnxruntime.dll` import for a module loaded by
// ABSOLUTE PATH against System32 BEFORE the module's own directory or PATH, and
// System32 ships ORT 1.17.1 (API <= 17). ORT then prints
//
//   The requested API version [26] is not available, only API versions
//   [1, 17] are supported in this build. Current ORT Version is: 1.17.1
//
// and returns a null API table which the bridge dereferences — a NATIVE
// access violation (0xC0000005) that kills the whole gateway process. No
// try/catch in JS can catch it, and prepending to `process.env.PATH` does not
// help because System32 wins the search order regardless.
//
// The fix is load ORDER, not search order: map the correct ORT into the process
// under the base name `onnxruntime` BEFORE the bridge is loaded. Windows then
// binds the bridge's import to the already-loaded module and performs no disk
// search at all. The same trick is the documented way to control `dlopen`
// resolution on Linux/macOS.
//
// Everything here is best-effort: a missing sidecar is recorded and reported,
// never thrown, so pure-C++ (non-ONNX) ops keep working untouched. The neural
// ops are gated on {@link ortSidecarStatus} in the dispatcher so they fail
// honestly instead of reaching the bridge and aborting.

/** Outcome of the process-wide ONNX Runtime sidecar preload. */
export type OrtSidecarStatus =
  | { state: "loaded"; path: string; providerPath?: string }
  | { state: "unavailable"; reason: string }
  | { state: "not-attempted" };

/** Library stem of the ONNX Runtime core library. */
const ORT_STEM = "onnxruntime";
/** Library stem of the ORT shared-provider shim, loaded first when present. */
const ORT_PROVIDERS_SHARED_STEM = "onnxruntime_providers_shared";

/**
 * Process-wide memo. `undefined` means "never attempted". Once set it is never
 * recomputed, so ORT is mapped at most once per process.
 */
let ortStatus: OrtSidecarStatus | undefined;

/**
 * Keeps the preloaded ORT handles reachable for the lifetime of the process.
 *
 * These are deliberately NEVER unloaded. `FreeLibrary`/`dlclose` on ORT while
 * its intra-op thread pools are alive runs ORT's static teardown under the
 * loader lock, which is the shutdown wedge described in the runtime shutdown
 * path (see `EngineRuntime.shutdown`).
 */
const ortHandles: KoffiLib[] = [];

/** Directory that should carry an engine's sidecar libraries. */
function sidecarDir(configuredPath?: string): string {
  if (configuredPath) {
    return isDirectory(configuredPath) ? configuredPath : dirname(configuredPath);
  }
  return bundledBinariesDir();
}

/**
 * Pre-load ONNX Runtime by ABSOLUTE PATH from the resolved binaries directory,
 * shared provider shim first, then the core library.
 *
 * Idempotent: the first call decides the outcome for the whole process and
 * every later call returns the memoized status. Never throws.
 */
export function preloadOnnxRuntime(configuredPath?: string): OrtSidecarStatus {
  if (ortStatus) return ortStatus;

  const dir = sidecarDir(configuredPath);
  const corePath = resolveBinaryPath(ORT_STEM, dir);
  if (!corePath) {
    ortStatus = {
      state: "unavailable",
      reason:
        `ONNX Runtime sidecar not found in '${dir}' (looked for ${candidateFileNames(ORT_STEM).join(" / ")}). ` +
        `Neural/ONNX ops are disabled; provision ORT 1.26 (API 26) next to the engine libraries — see binaries/README.md.`,
    };
    return ortStatus;
  }

  // The shared-provider shim is what lets ORT load an execution provider (e.g.
  // CUDA) out of a separate DLL. It is optional: without it ORT still runs on
  // the CPU provider, so a missing shim must not disable the neural ops.
  const providerPath = resolveBinaryPath(ORT_PROVIDERS_SHARED_STEM, dir);
  if (providerPath) {
    try {
      ortHandles.push(koffi.load(providerPath) as unknown as KoffiLib);
    } catch {
      // Best-effort: ORT falls back to the CPU provider without the shim.
    }
  }

  try {
    ortHandles.push(koffi.load(corePath) as unknown as KoffiLib);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ortStatus = {
      state: "unavailable",
      reason: `failed to pre-load ONNX Runtime from '${corePath}': ${message}. Neural/ONNX ops are disabled.`,
    };
    return ortStatus;
  }

  ortStatus = providerPath ? { state: "loaded", path: corePath, providerPath } : { state: "loaded", path: corePath };
  return ortStatus;
}

/** Current sidecar status without triggering a load. */
export function ortSidecarStatus(): OrtSidecarStatus {
  return ortStatus ?? { state: "not-attempted" };
}

/** Whether ORT is mapped in this process, so ONNX-backed ops are safe to call. */
export function isOnnxRuntimeReady(): boolean {
  return ortSidecarStatus().state === "loaded";
}

/**
 * Human-readable reason the ONNX path is unusable, or undefined when it is
 * usable. Used verbatim in the dispatcher's honest failure reasons.
 */
export function onnxUnavailableReason(): string | undefined {
  const status = ortSidecarStatus();
  if (status.state === "loaded") return undefined;
  if (status.state === "unavailable") return status.reason;
  return "ONNX Runtime sidecar preload has not run (engine not started); neural/ONNX ops are disabled.";
}

/** Test-only: forget the memoized status so a fresh preload can be exercised. */
export function __resetOnnxRuntimePreloadForTests(): void {
  ortStatus = undefined;
  ortHandles.length = 0;
}

/**
 * Load an engine's native library in-process.
 *
 * Never throws for the expected "binary not installed" case — returns
 * `{ available: false, reason }` so callers can degrade honestly. Only truly
 * unexpected load failures (corrupt library, ABI mismatch) surface as a reason
 * string as well; the plugin stays up either way.
 */
export function loadEngine(stem: string, configuredPath?: string): LoadResult {
  const path = resolveBinaryPath(stem, configuredPath);
  if (!path) {
    return {
      available: false,
      reason: `native library '${stem}' not found (looked in bundled binaries dir and configured binaryPath). Install the compiled engine or set binaryPath.`,
    };
  }
  // Map ONNX Runtime FIRST so any bridge that imports it binds to the correct
  // version instead of System32's. Idempotent and non-throwing: an absent
  // sidecar only disables the neural ops, it never blocks the engine load.
  preloadOnnxRuntime(configuredPath);
  try {
    const lib = koffi.load(path) as unknown as KoffiLib;
    return { available: true, lib, path };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { available: false, reason: `failed to load '${path}': ${message}`, path };
  }
}

/**
 * Unload a previously loaded library, if the koffi build supports it.
 *
 * SKIPPED once ORT is mapped. `koffi`'s `unload()` calls `FreeLibrary`
 * (`dlclose` on POSIX), which runs the bridge's and ORT's static destructors
 * while ORT's intra-op thread pools are still alive. On Windows that happens
 * under the loader lock and deadlocks: the observed symptom was
 * `EngineRuntime.shutdown()` never returning and the process sitting alive
 * indefinitely (~22 CPU-seconds, 1.2 GB RSS) instead of printing its clean
 * shutdown line.
 *
 * Leaving the module mapped costs one address-space mapping until the process
 * exits, which is bounded and safe. The runtime still drops its own references
 * so nothing dispatches into the engine after shutdown.
 *
 * Returns the reason the unload was skipped, or undefined when it ran.
 */
export function unloadEngine(lib: KoffiLib | undefined): string | undefined {
  if (!lib) return undefined;
  if (isOnnxRuntimeReady()) {
    return "native unload skipped: ONNX Runtime is mapped in this process and FreeLibrary/dlclose during its teardown deadlocks the shutdown path";
  }
  try {
    lib.unload?.();
  } catch {
    // Unload is best-effort; koffi may not expose it on all platforms.
  }
  return undefined;
}
