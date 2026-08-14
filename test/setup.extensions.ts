// Extension test setup installs extension-specific mocks and cleanup.
import { afterAll, beforeAll, beforeEach, expect, vi } from "vitest";
import { acquireNativeEngineLock, type NativeEngineLockHandle } from "./native-engine-lock.js";
import { installSharedTestSetup } from "./setup.shared.js";
import { isNativeEngineTestFile } from "./vitest/vitest.native-engine-paths.mjs";

const testEnv = installSharedTestSetup({ loadProfileEnv: false });

beforeEach(() => {
  vi.useRealTimers();
});

/**
 * Resolve the test file this setup instance is running for.
 *
 * `expect.getState().testPath` is the supported spelling: in Vitest 4 a hook's
 * first argument is a FIXTURE object, so the old `beforeAll((suite) => …)`
 * spelling throws `FixtureParseError` instead of handing over the file suite.
 */
function resolveTestPath(): string | undefined {
  return expect.getState().testPath ?? undefined;
}

// Serialize the test files that map the real native engines into this process.
// See test/vitest/vitest.native-engine-paths.mjs for the measurements: running
// them concurrently stacks their peak footprint in one address space, and a
// failed ONNX Runtime session allocation escapes an unguarded C ABI export and
// __fastfails the whole worker process (exit -1073740791).
let nativeEngineLock: NativeEngineLockHandle | undefined;

beforeAll(async () => {
  const testPath = resolveTestPath();
  if (!isNativeEngineTestFile(testPath)) {
    return;
  }
  nativeEngineLock = await acquireNativeEngineLock(
    testPath?.replaceAll("\\", "/").split("/extensions/").pop() ?? "native-engine-test",
  );
  // Above the lock's own 30-minute acquire deadline so the lock reports the
  // queue itself rather than the hook dying with a bare timeout.
}, 35 * 60_000);

afterAll(() => {
  nativeEngineLock?.release();
  nativeEngineLock = undefined;
  testEnv.cleanup();
});
