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

import { existsSync, readdirSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import koffi from "koffi";

/** A loaded koffi library handle. `func(prototype)` binds a C export. */
export interface KoffiLib {
  func(prototype: string): (...args: unknown[]) => unknown;
  unload?: () => void;
}

/** Result of attempting to load an engine's native library. */
export type LoadResult =
  | { available: true; lib: KoffiLib; path: string }
  | { available: false; reason: string; path?: string };

const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * Directory that ships the bundled engine binaries. Resolved relative to the
 * built plugin so a packaged install finds the libraries next to the code.
 * Layout: `<extensionRoot>/binaries/<lib><stem>.<ext>`.
 */
function bundledBinariesDir(): string {
  // src/ffi/loader.ts -> extension root is two levels up from src/ffi.
  return resolve(moduleDir, "..", "..", "binaries");
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
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    } else if (existsSync(configuredPath)) {
      return configuredPath;
    }
  }
  const dir = bundledBinariesDir();
  for (const name of candidateFileNames(stem)) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

// ── CUDA 12 / cuDNN 9 provider-dependency discovery ─────────────────────────
//
// WHY THIS EXISTS (this one IS an optimization, and must never be more):
//
// `onnxruntime_providers_cuda.dll` in `binaries/` links, per
// `dumpbin /DEPENDENTS` (CRT/KERNEL32 elided):
//
//   cublas64_12.dll  cublasLt64_12.dll  cudart64_12.dll  cudnn64_9.dll
//   cufft64_11.dll   onnxruntime_providers_shared.dll
//
// That is **CUDA 12 + cuDNN 9**, not CUDA 11. `cufft64_11.dll` is a CUDA 12
// library: CUDA 11.8 ships `cufft64_10.dll` and cuFFT's soname only bumps to 11
// in CUDA 12. A machine whose `CUDA_PATH` points at an 11.x toolkit therefore
// satisfies nothing here, and `CUDA_PATH` is deliberately NOT consulted below.
//
// When any of those five are unresolvable, ORT logs
//
//   Error loading "...onnxruntime_providers_cuda.dll" which depends on
//   "cufft64_11.dll" which is missing. (Error 126)
//   [omni][onnx_model_host] model 'segment': CUDA execution provider
//   unavailable (...); falling back to CPU provider.
//
// and every neural op runs on the CPU provider. That fallback is a FEATURE and
// is preserved: nothing here can fail the load, gate an op, or throw.
//
// PATH IS SUFFICIENT FOR THESE, unlike `onnxruntime.dll` itself. None of the
// five exist in System32, so the System32-wins-the-search problem that forces
// the absolute-path preload below does not apply — prepending the directories
// that hold them to `process.env.PATH` before ORT is mapped is enough, and it is
// also what makes the whole cuDNN directory resolvable. That matters:
// `cudnn64_9.dll` is a ~0.4 MB shim that `LoadLibrary`s `cudnn_ops64_9.dll`,
// `cudnn_graph64_9.dll`, `cudnn_engines_precompiled64_9.dll` and friends by BASE
// NAME at runtime (its only static import is KERNEL32), so the directory has to
// be on the search path, not just the one file.
//
// Nothing is vendored into `binaries/` for this: `cublasLt64_12.dll` alone is
// ~660 MB and the cuDNN set is ~990 MB. Discovery plus a config override keeps
// the repo ~2 GB smaller, and `binaries/` is still searched first among the
// built-in candidates so vendoring stays possible for anyone who wants it.

/** Plugin config block (`creative-engines.cuda`) for this discovery. */
export interface CudaDiscoveryConfig {
  /**
   * Set false to skip discovery entirely and stay on the CPU provider. Default
   * true. Useful to reproduce the CPU path on a machine that does have CUDA 12.
   */
  enabled?: boolean;
  /**
   * Directories searched FIRST, in the given order, ahead of every built-in
   * candidate. Point these at a CUDA 12 / cuDNN 9 install on an unusual layout.
   */
  searchPaths?: string[];
}

/** Where one required library was found, or that it was not found at all. */
export interface CudaLibraryResolution {
  /** File name searched for, e.g. `cufft64_11.dll`. */
  library: string;
  /** Directory it was found in. Absent when the library was not found. */
  directory?: string;
}

/** Outcome of the process-wide CUDA dependency discovery. */
export type CudaDependencyStatus =
  | { state: "not-attempted" }
  | { state: "disabled"; reason: string }
  | { state: "unsupported-platform"; platform: NodeJS.Platform; reason: string }
  | {
      state: "searched";
      /** True only when every required library resolved. */
      complete: boolean;
      /** Per-library outcome, in the documented required order. */
      libraries: CudaLibraryResolution[];
      /** Libraries that were not found anywhere. */
      missing: string[];
      /** Directories prepended to `PATH`, in the order they were prepended. */
      addedDirectories: string[];
      /** Every candidate directory that existed and was searched, in order. */
      searchedDirectories: string[];
      /**
       * Why the resolved directories could not be published to the OS loader
       * search path, when that failed. Present means the libraries were FOUND
       * but ORT still will not be able to load the provider, so `complete` is
       * false: reporting "found" as "usable" there would be a lie.
       */
      searchPathError?: string;
      /** One-line human summary, safe to print in diagnostics. */
      summary: string;
    };

/**
 * The libraries `onnxruntime_providers_cuda.dll` imports, minus
 * `onnxruntime_providers_shared.dll` (which ships in `binaries/` and is loaded
 * by absolute path) and the CRT. Verified with `dumpbin /DEPENDENTS`.
 */
export const CUDA_PROVIDER_DEPENDENCIES = [
  "cublas64_12.dll",
  "cublasLt64_12.dll",
  "cudart64_12.dll",
  "cudnn64_9.dll",
  "cufft64_11.dll",
] as const;

/** Env override for {@link CudaDiscoveryConfig.searchPaths}, same semantics. */
const CUDA_SEARCH_PATHS_ENV = "CREATIVE_ENGINES_CUDA_SEARCH_PATHS";

/** Process-wide memo; `undefined` means discovery has never run. */
let cudaStatus: CudaDependencyStatus | undefined;
/** Config handed in by the plugin entry before any engine starts. */
let cudaConfig: CudaDiscoveryConfig | undefined;

/** Immediate subdirectories of `parent`, or [] when it is not readable. */
function subdirectories(parent: string): string[] {
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(parent, entry.name));
  } catch {
    return [];
  }
}

/** Absolute, de-duplicated (case-insensitively), existing directories only. */
function uniqueExistingDirs(candidates: Iterable<string | undefined>): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const abs = resolve(candidate);
    const key = abs.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (isDirectory(abs)) {
      dirs.push(abs);
    }
  }
  return dirs;
}

/** Split a `PATH`-style list, dropping empties and stray quotes. */
function splitPathList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/gu, ""))
    .filter((entry) => entry.length > 0);
}

/**
 * Python `site-packages` roots, DERIVED — no interpreter version is hardcoded
 * and no user profile path is either. The NVIDIA CUDA 12 wheels
 * (`nvidia-cufft-cu12`, ...), `torch` and `ctranslate2` all ship the runtime
 * DLLs this provider needs, so these are the most likely place to find them on
 * a developer machine that never installed a CUDA toolkit.
 */
function pythonSitePackagesRoots(): string[] {
  const roots: string[] = [];
  const push = (root: string | undefined): void => {
    if (root) {
      roots.push(root);
    }
  };

  // An active venv/conda env wins: it is the interpreter the user is using.
  push(process.env.VIRTUAL_ENV ? join(process.env.VIRTUAL_ENV, "Lib", "site-packages") : undefined);
  push(
    process.env.CONDA_PREFIX ? join(process.env.CONDA_PREFIX, "Lib", "site-packages") : undefined,
  );
  push(process.env.PYTHONHOME ? join(process.env.PYTHONHOME, "Lib", "site-packages") : undefined);

  // Whatever interpreter is on PATH, found without spawning it: a Python
  // install directory contains `python.exe`, and its `Scripts` sibling is the
  // entry `py -m pip`/the installer adds.
  for (const entry of splitPathList(process.env.PATH)) {
    const dir = entry.replace(/[\\/]+$/u, "");
    if (!dir) {
      continue;
    }
    if (/[\\/]scripts$/iu.test(dir)) {
      push(join(dirname(dir), "Lib", "site-packages"));
      continue;
    }
    if (existsSync(join(dir, "python.exe"))) {
      push(join(dir, "Lib", "site-packages"));
    }
  }

  // Default per-user installs (`%LOCALAPPDATA%\Programs\Python\Python3xx`) and
  // the per-user site dir (`%APPDATA%\Python\Python3xx\site-packages`). Newest
  // version first, which is where a freshly `pip install`ed wheel lands.
  const localPrograms = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "Programs", "Python")
    : undefined;
  if (localPrograms) {
    for (const dir of subdirectories(localPrograms).toSorted().toReversed()) {
      push(join(dir, "Lib", "site-packages"));
    }
  }
  const roamingPython = process.env.APPDATA ? join(process.env.APPDATA, "Python") : undefined;
  if (roamingPython) {
    for (const dir of subdirectories(roamingPython).toSorted().toReversed()) {
      push(join(dir, "site-packages"));
    }
  }
  return roots;
}

/** Ollama install roots. Ollama ships a complete CUDA 12 runtime subset. */
function ollamaRoots(): string[] {
  const roots: string[] = [];
  const push = (root: string | undefined): void => {
    if (root) {
      roots.push(root);
    }
  };
  push(process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "Ollama") : undefined);
  push(process.env.ProgramFiles ? join(process.env.ProgramFiles, "Ollama") : undefined);
  push(
    process.env["ProgramFiles(x86)"]
      ? join(process.env["ProgramFiles(x86)"]!, "Ollama")
      : undefined,
  );
  for (const entry of splitPathList(process.env.PATH)) {
    if (existsSync(join(entry, "ollama.exe"))) {
      push(entry);
    }
  }
  return roots;
}

/**
 * `bin` directories of CUDA **12** toolkits and standalone cuDNN 9 installs.
 *
 * `CUDA_PATH` is deliberately not read: NVIDIA points it at whichever toolkit
 * was installed last, and on this machine that is 11.8 — a trap, since 11.8
 * satisfies none of the five libraries above. The versioned `CUDA_PATH_V12_*`
 * variables and an explicit `v12.*` directory scan are unambiguous.
 */
function cuda12ToolkitBins(): string[] {
  const bins: string[] = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (/^CUDA_PATH_V12(_\d+)?$/iu.test(name) && value) {
      bins.push(join(value, "bin"));
    }
  }
  const programFiles = process.env.ProgramFiles;
  if (programFiles) {
    const toolkitRoot = join(programFiles, "NVIDIA GPU Computing Toolkit", "CUDA");
    for (const dir of subdirectories(toolkitRoot).toSorted().toReversed()) {
      if (/[\\/]v12(\.|$)/iu.test(dir)) {
        bins.push(join(dir, "bin"));
      }
    }
    // Standalone cuDNN 9 installer: `...\NVIDIA\CUDNN\v9.x\bin` and a
    // per-CUDA-major subdirectory beneath it.
    const cudnnRoot = join(programFiles, "NVIDIA", "CUDNN");
    for (const dir of subdirectories(cudnnRoot).toSorted().toReversed()) {
      const bin = join(dir, "bin");
      bins.push(bin);
      for (const sub of subdirectories(bin).toSorted().toReversed()) {
        bins.push(sub);
      }
    }
  }
  return bins;
}

/**
 * The ORDERED candidate directory list. Documented here because this list, and
 * its order, is the whole contract:
 *
 *   1. `cuda.searchPaths` from plugin config, in the order given.
 *   2. `CREATIVE_ENGINES_CUDA_SEARCH_PATHS` (PATH-delimited), same semantics.
 *   3. The bundled `binaries/` directory — so vendoring stays possible.
 *   4. Ollama's `lib\ollama\cuda_v12` (cublas / cublasLt / cudart).
 *   5. Python `site-packages`: `nvidia\<pkg>\bin` (the CUDA 12 wheels, e.g.
 *      `nvidia\cufft\bin`), then `torch\lib` and `ctranslate2` (cuDNN 9).
 *   6. A CUDA **12** toolkit `bin`, and a standalone cuDNN 9 `bin`.
 *
 * Only directories that exist are returned, de-duplicated, absolute.
 */
export function cudaCandidateDirectories(config?: CudaDiscoveryConfig): string[] {
  const candidates: (string | undefined)[] = [];
  for (const path of config?.searchPaths ?? []) {
    candidates.push(path);
  }
  for (const path of splitPathList(process.env[CUDA_SEARCH_PATHS_ENV])) {
    candidates.push(path);
  }
  candidates.push(bundledBinariesDir());
  for (const root of ollamaRoots()) {
    candidates.push(join(root, "lib", "ollama", "cuda_v12"));
  }
  for (const site of pythonSitePackagesRoots()) {
    for (const pkg of subdirectories(join(site, "nvidia"))) {
      candidates.push(join(pkg, "bin"));
    }
    candidates.push(join(site, "torch", "lib"));
    candidates.push(join(site, "ctranslate2"));
  }
  for (const bin of cuda12ToolkitBins()) {
    candidates.push(bin);
  }
  return uniqueExistingDirs(candidates);
}

/**
 * Publish `value` as the process's REAL `PATH`, not just Node's JS-side view.
 *
 * MEASURED, and the reason this function exists: inside a Node WORKER THREAD
 * `process.env` is a per-thread copy, so assigning `process.env.PATH` does not
 * reach the environment block Windows' loader reads and a later
 * `LoadLibrary("cublasLt64_12.dll")` still fails. On the main thread Node's
 * setter does call `SetEnvironmentVariableW` for you, so this is a no-op there.
 *
 * Proven with a two-way probe on this machine (bare-name `koffi.load` of
 * `cublasLt64_12.dll` after prepending its directory):
 *   main thread,   process.env only ............ OK
 *   worker thread, process.env only ............ FAILED (module not found)
 *   worker thread, + SetEnvironmentVariableW ... OK
 *
 * Without it, the CUDA provider silently fell back to the CPU provider in the
 * Vitest `pool: "threads"` lanes while working fine in the gateway — the exact
 * kind of context-dependent half-truth this plugin must not ship.
 *
 * Best-effort: returns the failure reason instead of throwing, and the CPU
 * provider path is unaffected either way.
 */
function publishProcessSearchPath(value: string): string | undefined {
  try {
    const kernel32 = koffi.load("kernel32.dll") as unknown as KoffiLib;
    const setEnv = kernel32.func("int __stdcall SetEnvironmentVariableW(str16 name, str16 value)");
    const ok = Number(setEnv("PATH", value));
    return ok === 0 ? "SetEnvironmentVariableW('PATH') returned 0" : undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** True when `dir` is already on `process.env.PATH` (case-insensitive). */
function alreadyOnPath(dir: string): boolean {
  const target = dir.toLowerCase().replace(/[\\/]+$/u, "");
  return splitPathList(process.env.PATH).some(
    (entry) => entry.toLowerCase().replace(/[\\/]+$/u, "") === target,
  );
}

/**
 * Record the plugin's `cuda` config for the discovery that runs when the first
 * engine starts. A no-op once discovery has already run, so the reported state
 * always matches the state actually applied to the process.
 */
export function configureCudaProviderDependencies(config: CudaDiscoveryConfig | undefined): void {
  if (cudaStatus) {
    return;
  }
  cudaConfig = config;
}

/**
 * Resolve each required CUDA 12 / cuDNN 9 library independently and prepend the
 * directories that actually contain them to `process.env.PATH`.
 *
 * Per-library resolution is the point: on a real machine `cublas*`/`cudart`
 * come from Ollama, `cufft` from an NVIDIA pip wheel and `cudnn` from `torch`.
 * A single "CUDA directory" assumption finds none of them.
 *
 * Idempotent, memoized, and NEVER throws or fails. A partial or empty result
 * leaves the CPU provider path exactly as it was.
 */
export function ensureCudaProviderDependencies(config?: CudaDiscoveryConfig): CudaDependencyStatus {
  if (cudaStatus) {
    return cudaStatus;
  }
  const effective = config ?? cudaConfig;

  if (effective?.enabled === false) {
    cudaStatus = {
      state: "disabled",
      reason:
        "CUDA provider dependency discovery is disabled by config (creative-engines.cuda.enabled = false); " +
        "ONNX ops run on the CPU provider.",
    };
    return cudaStatus;
  }

  // WINDOWS-ONLY BY DESIGN, not by oversight. Two reasons, neither of which is
  // a small edit: (a) the sonames differ entirely (`libcublas.so.12`,
  // `libcudnn.so.9`, `libcufft.so.11`, and `libcufft.11.dylib` does not exist
  // at all — there is no macOS CUDA); (b) glibc's loader reads
  // `LD_LIBRARY_PATH` ONCE at process start, so mutating it from inside the
  // process does not affect a later `dlopen`, and the same is true of
  // `DYLD_LIBRARY_PATH`. Doing this honestly on POSIX means a re-exec or
  // `dlopen`ing every dependency by absolute path first, which is a separate
  // change with its own verification. Until that is done and MEASURED on those
  // platforms, this reports an honest no-op instead of pretending.
  if (process.platform !== "win32") {
    cudaStatus = {
      state: "unsupported-platform",
      platform: process.platform,
      reason:
        `CUDA provider dependency discovery is implemented and verified on win32 only (running on ${process.platform}). ` +
        "On Linux/macOS the sonames differ and LD_LIBRARY_PATH/DYLD_LIBRARY_PATH are read at process start, so an " +
        "in-process PATH-style fix does not work; provision the CUDA 12 / cuDNN 9 runtime on the system loader path " +
        "instead. ONNX ops otherwise run on the CPU provider.",
    };
    return cudaStatus;
  }

  const searchedDirectories = cudaCandidateDirectories(effective);
  const libraries: CudaLibraryResolution[] = [];
  const missing: string[] = [];
  const wanted: string[] = [];

  for (const library of CUDA_PROVIDER_DEPENDENCIES) {
    const directory = searchedDirectories.find((dir) => existsSync(join(dir, library)));
    if (directory) {
      libraries.push({ library, directory });
      if (!wanted.includes(directory)) {
        wanted.push(directory);
      }
    } else {
      libraries.push({ library });
      missing.push(library);
    }
  }

  const addedDirectories: string[] = [];
  for (const dir of wanted) {
    if (alreadyOnPath(dir)) {
      continue;
    }
    addedDirectories.push(dir);
  }
  let searchPathError: string | undefined;
  if (addedDirectories.length > 0) {
    const updated = `${addedDirectories.join(delimiter)}${delimiter}${process.env.PATH ?? ""}`;
    process.env.PATH = updated;
    // Also write the real process environment, which is what the Windows loader
    // reads. Required inside worker threads; harmless on the main thread.
    searchPathError = publishProcessSearchPath(updated);
  }

  const found = CUDA_PROVIDER_DEPENDENCIES.length - missing.length;
  const complete = missing.length === 0 && !searchPathError;
  const base =
    `CUDA 12 / cuDNN 9 provider dependencies: ${found}/${CUDA_PROVIDER_DEPENDENCIES.length} resolved; ` +
    `${addedDirectories.length} directory/ies added to the library search path`;
  const fallbackTail =
    "ORT will report the CUDA execution provider unavailable and fall back to the CPU provider; " +
    "ONNX ops still work, just slower.";
  let summary: string;
  if (searchPathError) {
    summary = `${base}, but publishing the search path to the OS failed (${searchPathError}). ${fallbackTail}`;
  } else if (missing.length > 0) {
    summary = `${base}; missing ${missing.join(", ")}. ${fallbackTail}`;
  } else {
    summary = `${base}. ORT can load onnxruntime_providers_cuda.dll.`;
  }

  cudaStatus = {
    state: "searched",
    complete,
    libraries,
    missing,
    addedDirectories,
    searchedDirectories,
    summary,
    ...(searchPathError ? { searchPathError } : {}),
  };
  return cudaStatus;
}

/** Current discovery state without triggering it. */
export function cudaProviderDependencyStatus(): CudaDependencyStatus {
  return cudaStatus ?? { state: "not-attempted" };
}

/**
 * Whether every dependency of the CUDA execution provider resolved.
 *
 * NOTE this is NOT "GPU acceleration is active": it says the provider's imports
 * can be satisfied, not that ORT chose the provider or that a session was
 * created on it. ORT's own log line remains the authority on that, and the CPU
 * fallback stays reported.
 */
export function cudaProviderDependenciesResolved(): boolean {
  const status = cudaProviderDependencyStatus();
  return status.state === "searched" && status.complete;
}

/** Human-readable one-liner for diagnostics, in every state. */
export function describeCudaProviderDependencies(): string {
  const status = cudaProviderDependencyStatus();
  switch (status.state) {
    case "not-attempted":
      return "CUDA provider dependency discovery has not run yet (no engine started in this process).";
    case "disabled":
      return status.reason;
    case "unsupported-platform":
      return status.reason;
    case "searched":
      return status.summary;
  }
}

/**
 * Test-only: forget the memoized state so a fresh discovery can be exercised.
 *
 * Also re-publishes the CURRENT `process.env.PATH` to the real process
 * environment. A test that restores `process.env.PATH` cannot undo
 * {@link publishProcessSearchPath} by itself from inside a worker thread, and
 * leaving a truncated PATH in the real environment would sabotage anything that
 * spawns a child process later in the same worker (ffmpeg, ffprobe, python).
 */
export function resetCudaProviderDependenciesForTests(): void {
  cudaStatus = undefined;
  cudaConfig = undefined;
  if (process.platform === "win32") {
    publishProcessSearchPath(process.env.PATH ?? "");
  }
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
  if (ortStatus) {
    return ortStatus;
  }

  // Make the CUDA 12 / cuDNN 9 dependencies of `onnxruntime_providers_cuda.dll`
  // resolvable BEFORE ORT is mapped, so the provider's imports can be satisfied
  // whenever ORT gets around to loading it (session creation). Best-effort and
  // non-throwing: an incomplete result only means the CPU provider, which is a
  // supported, honestly-reported state — see the section above.
  ensureCudaProviderDependencies();

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

  ortStatus = providerPath
    ? { state: "loaded", path: corePath, providerPath }
    : { state: "loaded", path: corePath };
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
  if (status.state === "loaded") {
    return undefined;
  }
  if (status.state === "unavailable") {
    return status.reason;
  }
  return "ONNX Runtime sidecar preload has not run (engine not started); neural/ONNX ops are disabled.";
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
  if (!lib) {
    return undefined;
  }
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
