# `creative-engines/binaries/` — provisioning the native runtime

Everything in this directory except this README is **gitignored** (~1,055 MB of
compiled engines, ONNX Runtime and model weights). It has to be provisioned by
hand on each machine. Nothing here is committed — do not `git add -f` any of it.

The plugin degrades honestly at every level: with an empty directory all engines
report `available: false`; with the engine libraries but no ONNX Runtime the pure
C++ ops work and the neural ops return `ok: false` with a reason naming what to
provision.

## Read this before you touch `onnxruntime.dll`

`libomni_image_bridge` was built against a modern ONNX Runtime and requests
**ORT API version 26**. Windows resolves an implicit `onnxruntime.dll` import for
a module loaded by absolute path against **`C:\Windows\System32` before the
module's own directory and before `PATH`**, and System32 ships **ORT 1.17.1**
(API ≤ 17). When the bridge binds against that copy, ORT prints

```
The requested API version [26] is not available, only API versions [1, 17] are
supported in this build. Current ORT Version is: 1.17.1
```

hands back a null API table, and the bridge dereferences it — a native access
violation (`0xC0000005`) that **kills the entire gateway process**. It is not
catchable from JavaScript.

Two things follow:

- **Copying the right DLL into this directory is not sufficient on its own.**
  System32 still wins the search, and prepending to `process.env.PATH` does not
  change that.
- The plugin fixes it by **load order, not search order**: `src/ffi/loader.ts`
  `koffi.load()`s `onnxruntime_providers_shared` and then `onnxruntime` from this
  directory **by absolute path, before any engine bridge is loaded**. Once ORT is
  mapped under that base name, the bridge's import binds to the already-loaded
  module and no disk search happens.

If that preload is ever bypassed or the sidecar is absent, the neural ops are
gated off in `src/ffi/dispatch.ts` and fail honestly rather than reaching the
bridge. Do not remove that gate.

## Files

### Engine libraries (required, one per engine you want available)

| File                        | Engine | Notes                                                 |
| --------------------------- | ------ | ----------------------------------------------------- |
| `libomni_image_bridge.dll`  | image  | The only bridge that links ONNX Runtime               |
| `libomni_audio_bridge.dll`  | audio  | Pure C++ DSP, no ONNX                                 |
| `libomni_video_bridge.dll`  | video  | Pure C++ per-frame ops + ffmpeg pipeline ops, no ONNX |
| `libomni_vector_bridge.dll` | vector | Pure C++, no ONNX                                     |

Use `.so` on Linux and `.dylib` on macOS; the loader tries both the `lib`-prefixed
and bare spellings for each platform.

### ONNX Runtime sidecar (required for the neural ops only)

| File                               | Required version    | Notes                                                                            |
| ---------------------------------- | ------------------- | -------------------------------------------------------------------------------- |
| `onnxruntime.dll`                  | **1.26** (API 26)   | Verified good: `1.26.20260508.3.8c546c3`                                         |
| `onnxruntime_providers_shared.dll` | same build as above | Optional in the strict sense — without it ORT runs CPU-only — but ship it        |
| `onnxruntime_providers_cuda.dll`   | same build as above | ~285 MB; only useful with a **CUDA 12 + cuDNN 9** runtime resolvable (see below) |

Keep all three from the **same** ORT build. A mismatched trio fails to load the
execution provider and silently drops to CPU.

### Models (`binaries/models/`)

The C++ `OnnxModelHost` resolves each model as the environment variable below
when set and non-empty, otherwise `models/<file>` **relative to the loaded
module's own directory** (i.e. this directory), independent of the working
directory.

| Model file                                          | Env override          | Model                                       | Ops that use it                                                                     |
| --------------------------------------------------- | --------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `u2net.onnx`                                        | `OMNI_SEG_MODEL`      | U2Net segmentation                          | `remove_background`, `get_foreground_mask`, `blur_background`, `segment_foreground` |
| `depth_anything_v2_small.onnx` (+ its `.onnx_data`) | `OMNI_DEPTH_MODEL`    | Depth Anything v2 (small)                   | `neural_generate_depth_map`, `neural_depth_blur`                                    |
| `colorization.onnx`                                 | `OMNI_COLORIZE_MODEL` | Zhang et al. eccv16 colorization            | `neural_colorize`                                                                   |
| `fbcnn.onnx`                                        | `OMNI_RESTORE_MODEL`  | FBCNN blind compression-artifact removal    | `neural_remove_compression_artifacts`                                               |
| `face_parsing.onnx`                                 | `OMNI_FACE_MODEL`     | YuNet face detector (despite the file name) | `neural_smooth_skin`                                                                |

`depth_anything_v2_small.onnx` uses ONNX external-data format: the companion
`.onnx_data` file must sit next to it or session creation fails.

**These op names lie in both directions — do not infer the list from the names.**
The following are pure CPU loops in `neural_filters.cpp` and need no model and no
ONNX Runtime: `neural_smart_denoise`, `neural_smart_sharpen`, `restore_photo`,
`ai_deblur`, `ai_denoise`.

## Where the known-good copies live

```
<your-workspace>\image-workspace\bridges\
```

That directory holds a matching `onnxruntime.dll`,
`onnxruntime_providers_shared.dll`, `onnxruntime_providers_cuda.dll` and a
`models/` tree. Copy the DLLs into this directory and the model files into
`binaries/models/`.

## CUDA: auto-discovered, optional, and honestly reported

### It is CUDA 12 + cuDNN 9, not CUDA 11

`dumpbin /DEPENDENTS onnxruntime_providers_cuda.dll` (CRT/KERNEL32 elided):

```
cublas64_12.dll  cublasLt64_12.dll  cudart64_12.dll  cudnn64_9.dll
cufft64_11.dll   onnxruntime_providers_shared.dll
```

`cufft64_11.dll` is a **CUDA 12** library, not a CUDA 11 one: CUDA 11.8 ships
`cufft64_10.dll`, and cuFFT's soname only bumps to 11 in CUDA 12. A CUDA 11.8
toolkit satisfies none of these five. In particular **do not trust `CUDA_PATH`**
— NVIDIA points it at whichever toolkit was installed last, and on the
development machine that is `...\CUDA\v11.8`, which is useless here. The loader
deliberately ignores `CUDA_PATH` and only looks at versioned `CUDA_PATH_V12_*`
variables and explicit `v12.*` toolkit directories.

`cudnn64_9.dll` is a ~0.4 MB **shim**: its only static import is KERNEL32, and it
`LoadLibrary`s `cudnn_ops64_9.dll`, `cudnn_graph64_9.dll`,
`cudnn_engines_precompiled64_9.dll` and friends by base name at runtime (~990 MB
in total). Whatever satisfies it has to make the whole **directory** searchable,
not just that one file.

### Nothing is vendored here for it

`cublasLt64_12.dll` alone is ~660 MB and the cuDNN set is ~990 MB, so vendoring
would add ~2 GB to this directory. Instead `src/ffi/loader.ts`
(`ensureCudaProviderDependencies`) resolves **each** library independently and
prepends the directories that actually contain them to `process.env.PATH` before
ORT is mapped. Unlike `onnxruntime.dll`, PATH is sufficient for these: none of
the five exist in System32, so there is no System32-wins-the-search problem.

Ordered candidate directories:

1. `creative-engines.cuda.searchPaths` from plugin config, in order.
2. `CREATIVE_ENGINES_CUDA_SEARCH_PATHS` (PATH-delimited), same semantics.
3. **This directory** — so vendoring stays possible if you want it.
4. Ollama's `lib\ollama\cuda_v12`.
5. Python `site-packages`: `nvidia\<pkg>\bin` (the CUDA 12 wheels), then
   `torch\lib`, then `ctranslate2`. The interpreter is derived (venv/conda,
   `python.exe` on PATH, the default per-user install), never hardcoded.
6. A CUDA **12** toolkit `bin`, and a standalone cuDNN 9 `bin`.

On the development machine the five resolve from three different places, which
is exactly why resolution is per-library:

```
cublas64_12.dll    <LOCALAPPDATA>\Programs\Ollama\lib\ollama\cuda_v12
cublasLt64_12.dll  <LOCALAPPDATA>\Programs\Ollama\lib\ollama\cuda_v12
cudart64_12.dll    <LOCALAPPDATA>\Programs\Ollama\lib\ollama\cuda_v12
cudnn64_9.dll      <site-packages>\torch\lib
cufft64_11.dll     <site-packages>\nvidia\cufft\bin      (nvidia-cufft-cu12)
```

`pip install nvidia-cufft-cu12` is enough to supply `cufft64_11.dll` if nothing
else on the machine has it.

### It is an optimization, never a requirement

Discovery cannot fail the load, gate an op, or throw. When any dependency is
missing ORT logs

```
Error loading "...onnxruntime_providers_cuda.dll" which depends on
"cufft64_11.dll" which is missing. (Error 126)
[omni][onnx_model_host] model 'segment': CUDA execution provider unavailable
(...); falling back to CPU provider.
```

and every neural op runs on the **CPU provider** — slower, same result, still
`ok: true`. That fallback is a supported state and is reported, not hidden.
Verified both ways on the development machine (5 warm `remove_background` passes
on one 4032x3024 JPEG, `u2net.onnx`):

| Provider                                                      | Cold pass  | Warm passes | VRAM delta  |
| ------------------------------------------------------------- | ---------- | ----------- | ----------- |
| CUDA (all 5 resolved)                                         | ~1.7-1.9 s | ~605-650 ms | **+771 MB** |
| CPU (`cuda.enabled: false`, or `cufft64_11.dll` renamed away) | ~1.6-1.7 s | ~856-945 ms | ~0 MB       |

Read those numbers carefully: ~760 ms of every call is the sharp JPEG decode +
PNG encode both providers pay identically (measured with `grayscale`, a pure C++
op on the same image through the same dispatch path), so the **end-to-end**
speedup on a large photo is only ~1.4x even though the inference itself is much
faster. A small input, or a chain that decodes once, sees more of it.

Inspect what was found:

```
openclaw creative onnx-status
```

It prints the ONNX Runtime sidecar state, which sidecar files exist, and per
library the directory it came from or that it is missing. It reports a
**capability** — ORT can load the CUDA provider — not a claim that any particular
session ran on the GPU, and it never loads a native library to answer. In a
short-lived CLI process nothing has mapped ORT yet, so `onnxRuntime.state` is
`not-attempted` there while the CUDA block is fully populated: the command runs
the discovery itself (idempotent, filesystem probing plus this process's own
search path) so it can answer something useful.

Force the CPU path (useful for comparison, or on a machine where the discovered
CUDA is the wrong one):

```jsonc
{ "plugins": { "creative-engines": { "cuda": { "enabled": false } } } }
```

### The GPU broker claim

`withGpuClaim` wraps the ONNX ops at the single dispatch chokepoint, and that is
now genuinely load-bearing: the ops really do consume ~740-770 MB of VRAM once
the CUDA provider loads. It is deliberately NOT wrapped around the keyframe
vision call — `release()` evicts every resident Ollama model, which is the very
model that call is about to use. There is a test that greps for this; do not
"fix" it.

### Platform support

Windows only, on purpose. On Linux/macOS the sonames differ entirely
(`libcublas.so.12`, `libcudnn.so.9`, `libcufft.so.11`; there is no macOS CUDA at
all) and `LD_LIBRARY_PATH`/`DYLD_LIBRARY_PATH` are read once at process start, so
mutating them in-process does not affect a later `dlopen`. Discovery reports an
explicit `unsupported-platform` no-op there rather than pretending; provision the
CUDA 12 / cuDNN 9 runtime on the system loader path instead.

## Verifying a fresh provision

```
node scripts/run-vitest.mjs run --config test/vitest/vitest.extensions.config.ts creative-engines
```

`src/ffi/neural-ops.integration.test.ts` skips itself and prints what is missing
when this directory is not fully provisioned, and runs a real `remove_background`
inference plus a real GPU-broker lease when it is. Point
`CREATIVE_ENGINES_NEURAL_FIXTURE` at a real photograph to also assert the alpha
matte contains both cut-away and kept pixels.

`src/ffi/cuda-discovery.test.ts` covers the discovery itself with synthetic
directories, so it runs anywhere and needs no CUDA. On a machine that is supposed
to have CUDA 12 + cuDNN 9, set `CREATIVE_ENGINES_EXPECT_CUDA=1` to turn a silent
CPU fallback into a test failure. No wall-clock speed is asserted anywhere —
that flakes; provider selection and the diagnostics are asserted instead.
