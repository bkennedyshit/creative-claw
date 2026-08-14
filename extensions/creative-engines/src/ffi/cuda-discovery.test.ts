import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import koffi from "koffi";
/**
 * CUDA 12 / cuDNN 9 provider-dependency discovery.
 *
 * These tests use SYNTHETIC directories holding zero-byte files with the real
 * DLL names, so they run on any machine and never touch a real CUDA install.
 * They pin the properties that matter and that are cheap to get wrong:
 *
 *   * per-library resolution (the five libraries legitimately come from
 *     DIFFERENT directories on a real machine, so a single "CUDA dir"
 *     assumption is wrong);
 *   * configured search paths win over every built-in candidate;
 *   * a partial or empty result NEVER throws and never disables anything — the
 *     CPU provider path has to survive, and the missing libraries have to be
 *     named so a user can act on them;
 *   * PATH is only ever prepended, and only with directories that were actually
 *     needed;
 *   * `CUDA_PATH` is not treated as authoritative (it points at 11.8 on the
 *     development machine, which satisfies none of these libraries).
 *
 * No speed assertion lives here on purpose: wall-clock inference time is
 * environment-dependent and would flake. The observable contract is which
 * provider CAN be loaded, which is what the diagnostics report.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  CUDA_PROVIDER_DEPENDENCIES,
  resetCudaProviderDependenciesForTests,
  configureCudaProviderDependencies,
  cudaCandidateDirectories,
  cudaProviderDependenciesResolved,
  cudaProviderDependencyStatus,
  describeCudaProviderDependencies,
  ensureCudaProviderDependencies,
} from "./loader.js";

const WINDOWS = process.platform === "win32";

let tempRoot: string;
let originalPath: string | undefined;

/**
 * Run `fn` with every environment variable the BUILT-IN candidates are derived
 * from blanked out, so a test can measure configured paths alone even on a
 * machine that really does have CUDA 12 / cuDNN 9 installed. Restores
 * everything, including on throw.
 */
function withoutHostCudaCandidates<T>(fn: () => T): T {
  const names = [
    "PATH",
    "LOCALAPPDATA",
    "APPDATA",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "VIRTUAL_ENV",
    "CONDA_PREFIX",
    "PYTHONHOME",
    ...Object.keys(process.env).filter((name) => /^CUDA_PATH_V12(_\d+)?$/iu.test(name)),
  ];
  const saved = new Map(names.map((name) => [name, process.env[name]] as const));
  const nowhere = join(tempRoot, "nowhere");
  mkdirSync(nowhere, { recursive: true });
  try {
    for (const name of names) {
      process.env[name] = name === "PATH" ? "" : nowhere;
    }
    return fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

/** Create `dir` holding zero-byte files named after `libraries`. */
function makeLibDir(name: string, libraries: readonly string[]): string {
  const dir = join(tempRoot, name);
  mkdirSync(dir, { recursive: true });
  for (const library of libraries) {
    writeFileSync(join(dir, library), "");
  }
  return dir;
}

beforeEach(() => {
  resetCudaProviderDependenciesForTests();
  tempRoot = mkdtempSync(join(tmpdir(), "creative-cuda-"));
  originalPath = process.env.PATH;
  delete process.env.CREATIVE_ENGINES_CUDA_SEARCH_PATHS;
});

afterEach(() => {
  // PATH first, then the reset: the reset re-publishes whatever `process.env.PATH`
  // then holds to the REAL process environment, which a plain assignment cannot
  // do from inside a Vitest worker thread. Without that, a truncated PATH would
  // leak into every later child process in this worker.
  process.env.PATH = originalPath;
  resetCudaProviderDependenciesForTests();
  delete process.env.CREATIVE_ENGINES_CUDA_SEARCH_PATHS;
  rmSync(tempRoot, { recursive: true, force: true });
  // The extensions lane runs with `isolate: false`, so sibling test FILES in the
  // same worker share this module's registry — and therefore its memo. Leave the
  // process in the state a normal engine start would have produced instead of
  // "never attempted", so another file's view of the discovery stays truthful.
  ensureCudaProviderDependencies();
});

describe("CUDA provider dependency list", () => {
  it("is the CUDA 12 / cuDNN 9 set that onnxruntime_providers_cuda.dll imports", () => {
    // Verified with `dumpbin /DEPENDENTS`. cufft64_11 is a CUDA *12* library:
    // CUDA 11.8 ships cufft64_10, the soname only bumps to 11 in CUDA 12. If
    // this list ever grows a `*_11.dll` cublas/cudart/cudnn entry, the provider
    // binary was swapped for a CUDA 11 build and the README is wrong again.
    expect([...CUDA_PROVIDER_DEPENDENCIES]).toEqual([
      "cublas64_12.dll",
      "cublasLt64_12.dll",
      "cudart64_12.dll",
      "cudnn64_9.dll",
      "cufft64_11.dll",
    ]);
  });
});

describe("discovery is disabled honestly", () => {
  it("reports the disabled state and touches nothing", () => {
    const before = process.env.PATH;
    const status = ensureCudaProviderDependencies({ enabled: false });
    expect(status.state).toBe("disabled");
    expect(process.env.PATH).toBe(before);
    expect(cudaProviderDependenciesResolved()).toBe(false);
    expect(describeCudaProviderDependencies()).toMatch(/disabled by config/u);
  });

  it("reports not-attempted before it runs", () => {
    expect(cudaProviderDependencyStatus()).toEqual({ state: "not-attempted" });
    expect(describeCudaProviderDependencies()).toMatch(/has not run yet/u);
  });
});

describe.skipIf(WINDOWS)("non-Windows platforms", () => {
  it("is an explicit, reported no-op rather than a pretend success", () => {
    const before = process.env.PATH;
    const status = ensureCudaProviderDependencies({ enabled: true });
    expect(status.state).toBe("unsupported-platform");
    expect(process.env.PATH).toBe(before);
    expect(cudaProviderDependenciesResolved()).toBe(false);
    expect(describeCudaProviderDependencies()).toMatch(/win32 only/u);
  });
});

describe.skipIf(!WINDOWS)("per-library resolution on Windows", () => {
  it("resolves each library independently and adds only the directories used", () => {
    // Mirrors the real machine: cublas/cublasLt/cudart from one place, cudnn
    // from another, cufft from a third.
    const a = makeLibDir("blas", ["cublas64_12.dll", "cublasLt64_12.dll", "cudart64_12.dll"]);
    const b = makeLibDir("dnn", ["cudnn64_9.dll"]);
    const c = makeLibDir("fft", ["cufft64_11.dll"]);
    const unused = makeLibDir("unused", []);

    const status = ensureCudaProviderDependencies({ searchPaths: [a, b, c, unused] });
    expect(status.state).toBe("searched");
    if (status.state !== "searched") {
      return;
    }

    expect(status.complete).toBe(true);
    expect(status.missing).toEqual([]);
    expect(Object.fromEntries(status.libraries.map((l) => [l.library, l.directory]))).toEqual({
      "cublas64_12.dll": a,
      "cublasLt64_12.dll": a,
      "cudart64_12.dll": a,
      "cudnn64_9.dll": b,
      "cufft64_11.dll": c,
    });
    expect(status.addedDirectories).toEqual([a, b, c]);
    expect(status.addedDirectories).not.toContain(unused);
    expect(cudaProviderDependenciesResolved()).toBe(true);
  });

  it("prepends the resolved directories to PATH and preserves the rest", () => {
    const dir = makeLibDir("all", CUDA_PROVIDER_DEPENDENCIES);
    const before = process.env.PATH ?? "";

    ensureCudaProviderDependencies({ searchPaths: [dir] });

    expect(process.env.PATH).toBe(`${dir}${delimiter}${before}`);
  });

  it("searches configured paths ahead of every built-in candidate", () => {
    const first = makeLibDir("first", CUDA_PROVIDER_DEPENDENCIES);
    const second = makeLibDir("second", CUDA_PROVIDER_DEPENDENCIES);
    const dirs = cudaCandidateDirectories({ searchPaths: [first, second] });
    expect(dirs[0]).toBe(first);
    expect(dirs[1]).toBe(second);
  });

  it("honours the env override after config, before the built-ins", () => {
    const configured = makeLibDir("cfg", ["cudnn64_9.dll"]);
    const fromEnv = makeLibDir("env", CUDA_PROVIDER_DEPENDENCIES);
    process.env.CREATIVE_ENGINES_CUDA_SEARCH_PATHS = fromEnv;

    const status = ensureCudaProviderDependencies({ searchPaths: [configured] });
    expect(status.state).toBe("searched");
    if (status.state !== "searched") {
      return;
    }
    expect(status.searchedDirectories.slice(0, 2)).toEqual([configured, fromEnv]);
    // cudnn comes from the config dir because it is searched first; the rest
    // fall through to the env dir.
    expect(status.libraries.find((l) => l.library === "cudnn64_9.dll")?.directory).toBe(configured);
    expect(status.libraries.find((l) => l.library === "cufft64_11.dll")?.directory).toBe(fromEnv);
  });

  it("never hard-fails when a dependency is missing, and names what is missing", () => {
    const partial = makeLibDir("partial", [
      "cublas64_12.dll",
      "cublasLt64_12.dll",
      "cudart64_12.dll",
    ]);
    // An empty configured path must not throw either.
    const empty = join(tempRoot, "does-not-exist");

    // Blank out every environment variable the built-in candidates are derived
    // from, so this test measures the CONFIGURED paths on a machine that does
    // have a real CUDA 12 / cuDNN 9 install (the development machine does).
    const status = withoutHostCudaCandidates(() =>
      ensureCudaProviderDependencies({ searchPaths: [partial, empty] }),
    );
    expect(status.state).toBe("searched");
    if (status.state !== "searched") {
      return;
    }

    expect(status.complete).toBe(false);
    expect(status.missing).toContain("cudnn64_9.dll");
    expect(status.missing).toContain("cufft64_11.dll");
    expect(cudaProviderDependenciesResolved()).toBe(false);
    // The summary has to say what happens next, not just "incomplete".
    expect(status.summary).toMatch(/fall back to the CPU provider/u);
    expect(status.summary).toContain("cufft64_11.dll");
    // Non-existent candidates are dropped rather than reported as searched.
    expect(status.searchedDirectories).not.toContain(empty);
    // The libraries that WERE found are still reported and still added.
    expect(status.addedDirectories).toEqual([partial]);
  });

  it("keeps complete and missing consistent on this machine, whatever is installed", () => {
    const status = ensureCudaProviderDependencies();
    expect(status.state).toBe("searched");
    if (status.state !== "searched") {
      return;
    }
    expect(status.complete).toBe(
      status.missing.length === 0 && status.searchPathError === undefined,
    );
    for (const entry of status.libraries) {
      expect(status.missing.includes(entry.library)).toBe(entry.directory === undefined);
    }
  });

  it("is memoized: the first call decides the state for the process", () => {
    const dir = makeLibDir("all", CUDA_PROVIDER_DEPENDENCIES);
    const first = ensureCudaProviderDependencies({ searchPaths: [dir] });
    const pathAfterFirst = process.env.PATH;

    const second = ensureCudaProviderDependencies({ searchPaths: [] });

    expect(second).toBe(first);
    expect(process.env.PATH).toBe(pathAfterFirst);
    expect(cudaProviderDependencyStatus()).toBe(first);
  });

  it("configure() only applies before discovery runs, so the report matches reality", () => {
    const dir = makeLibDir("all", CUDA_PROVIDER_DEPENDENCIES);
    configureCudaProviderDependencies({ searchPaths: [dir] });
    const status = ensureCudaProviderDependencies();
    expect(status.state).toBe("searched");
    if (status.state !== "searched") {
      return;
    }
    expect(status.searchedDirectories[0]).toBe(dir);

    // Too late now — the PATH has already been mutated.
    configureCudaProviderDependencies({ enabled: false });
    expect(cudaProviderDependencyStatus()).toBe(status);
  });

  it("does not treat CUDA_PATH as authoritative for a CUDA 12 requirement", () => {
    // CUDA_PATH points at whichever toolkit was installed last (11.8 on the
    // development machine), and 11.8 ships cufft64_10, not cufft64_11.
    const fake = makeLibDir("fake-toolkit", CUDA_PROVIDER_DEPENDENCIES);
    const previous = process.env.CUDA_PATH;
    process.env.CUDA_PATH = tempRoot;
    try {
      const dirs = cudaCandidateDirectories();
      expect(dirs).not.toContain(fake);
      expect(dirs).not.toContain(join(tempRoot, "bin"));
    } finally {
      if (previous === undefined) {
        delete process.env.CUDA_PATH;
      } else {
        process.env.CUDA_PATH = previous;
      }
    }
  });

  /**
   * THE regression test for the bug that made this feature work in the gateway
   * and silently not work here: inside a Vitest worker thread `process.env` is a
   * per-thread copy, so assigning `process.env.PATH` does not move the Windows
   * loader's search path and a bare-name `LoadLibrary` still fails. Discovery
   * therefore also publishes the path through `SetEnvironmentVariableW`.
   *
   * This test runs IN a worker thread, so it fails if that is ever removed.
   * `cudart64_12.dll` is the smallest of the five (a few hundred KB), so this
   * maps almost nothing.
   */
  it("makes a resolved library loadable by BARE NAME, proving the OS search path moved", () => {
    const status = ensureCudaProviderDependencies();
    expect(status.state).toBe("searched");
    if (status.state !== "searched") {
      return;
    }
    const cudart = status.libraries.find((entry) => entry.library === "cudart64_12.dll");
    if (!cudart?.directory) {
      // No CUDA 12 on this machine: nothing to prove, and nothing to fail.
      // eslint-disable-next-line no-console
      console.log(
        "[cuda-discovery] cudart64_12.dll not present on this machine; bare-name load not exercised",
      );
      return;
    }
    expect(status.searchPathError).toBeUndefined();
    expect(() => koffi.load("cudart64_12.dll")).not.toThrow();
  });

  it("always searches the bundled binaries dir, so vendoring stays possible", () => {
    const dirs = cudaCandidateDirectories();
    expect(
      dirs.some((dir) =>
        dir.toLowerCase().endsWith(join("creative-engines", "binaries").toLowerCase()),
      ),
    ).toBe(true);
  });
});
