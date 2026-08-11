// Test files that drive the REAL compiled native engines in-process.
//
// These are the only extension tests that map `libomni_*_bridge` (and, through
// it, ONNX Runtime) into the Vitest worker and then do heavy real work: ONNX CPU
// sessions over 100-300 MB models, whole-video ffmpeg passes, and local vision
// model calls. Everything else in the extensions lane is pure TypeScript or
// koffi stubs.
//
// WHY THIS LIST EXISTS (measured, not assumed):
//
// The extensions lane runs with `isolate: false`, `pool: "threads"` and
// `fileParallelism: true`, so up to `maxWorkers` test FILES execute
// concurrently as worker threads inside ONE process (6 on a 32-core/64 GB host).
// That means the files below stack their peak footprint on top of each other and
// on top of five other warm module graphs, in a single address space, at the
// exact moment ONNX Runtime builds its CPU arena for `u2net.onnx`.
//
// On Windows the resource that runs out first is the COMMIT CHARGE, not physical
// RAM. Measured on the host that reported this flake, while the lane was
// running: available commit fell to 285 MB and the system auto-grew the
// pagefile (commit limit 90703 MB -> 99167 MB) while 22 GB of physical RAM was
// still free. ORT then throws `bad allocation` from
// `InferenceSession::Initialize`.
//
// That allocation failure is recoverable in principle, but the C ABI exports it
// escapes through are NOT exception-guarded — `bridge_remove_background`,
// `bridge_get_foreground_mask` and `bridge_blur_background` are
// `extern "C" void` with no try/catch (omni_image_bridge.cpp), unlike the
// `bridge_neural_*` family which returns `BridgeOpStatus`. A C++ exception
// crossing the koffi boundary calls `std::terminate`, which `__fastfail`s: the
// process dies with STATUS_STACK_BUFFER_OVERRUN (0xC0000409 / -1073740791) and
// takes every other test file in that worker process with it, which is why the
// run printed no Vitest summary at all.
//
// Serializing these files (see `test/native-engine-lock.ts`, wired in
// `test/setup.extensions.ts`) removes the stacking: at most one of them runs at
// a time, so at most one ORT session is being built at a time and the rest of
// the lane is not holding its peak while that happens.
export const nativeEngineTestFiles = [
  // Real ONNX Runtime inference (u2net "segment" + depth_anything "depth").
  "extensions/creative-engines/src/ffi/neural-ops.integration.test.ts",
  // Real image + video bridges: decode/resize/crop/seam-carve real buffers.
  "extensions/creative-engines/src/ffi/dispatch.resizing.test.ts",
  // Real image/audio/video/vector bridges across the whole plugin surface.
  "extensions/creative-claw-smoke.test.ts",
  // Real ffmpeg passes plus a local Ollama vision model per keyframe.
  "extensions/creative-engines/src/media/video-understanding.integration.test.ts",
  // Real video bridge + ffmpeg demux + a local ASR command (faster-whisper).
  "extensions/creative-engines/src/media/audio-narration.integration.test.ts",
];

/** True when `filePath` is one of the real-native-engine test files. */
export function isNativeEngineTestFile(filePath) {
  if (!filePath) {
    return false;
  }
  const normalized = String(filePath).replaceAll("\\", "/");
  return nativeEngineTestFiles.some((candidate) => normalized.endsWith(candidate));
}
