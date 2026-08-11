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

| File | Engine | Notes |
| --- | --- | --- |
| `libomni_image_bridge.dll` | image | The only bridge that links ONNX Runtime |
| `libomni_audio_bridge.dll` | audio | Pure C++ DSP, no ONNX |
| `libomni_video_bridge.dll` | video | Pure C++ per-frame ops + ffmpeg pipeline ops, no ONNX |
| `libomni_vector_bridge.dll` | vector | Pure C++, no ONNX |

Use `.so` on Linux and `.dylib` on macOS; the loader tries both the `lib`-prefixed
and bare spellings for each platform.

### ONNX Runtime sidecar (required for the neural ops only)

| File | Required version | Notes |
| --- | --- | --- |
| `onnxruntime.dll` | **1.26** (API 26) | Verified good: `1.26.20260508.3.8c546c3` |
| `onnxruntime_providers_shared.dll` | same build as above | Optional in the strict sense — without it ORT runs CPU-only — but ship it |
| `onnxruntime_providers_cuda.dll` | same build as above | ~285 MB; only useful with the CUDA 11 runtime installed (see below) |

Keep all three from the **same** ORT build. A mismatched trio fails to load the
execution provider and silently drops to CPU.

### Models (`binaries/models/`)

The C++ `OnnxModelHost` resolves each model as the environment variable below
when set and non-empty, otherwise `models/<file>` **relative to the loaded
module's own directory** (i.e. this directory), independent of the working
directory.

| Model file | Env override | Model | Ops that use it |
| --- | --- | --- | --- |
| `u2net.onnx` | `OMNI_SEG_MODEL` | U2Net segmentation | `remove_background`, `get_foreground_mask`, `blur_background`, `segment_foreground` |
| `depth_anything_v2_small.onnx` (+ its `.onnx_data`) | `OMNI_DEPTH_MODEL` | Depth Anything v2 (small) | `neural_generate_depth_map`, `neural_depth_blur` |
| `colorization.onnx` | `OMNI_COLORIZE_MODEL` | Zhang et al. eccv16 colorization | `neural_colorize` |
| `fbcnn.onnx` | `OMNI_RESTORE_MODEL` | FBCNN blind compression-artifact removal | `neural_remove_compression_artifacts` |
| `face_parsing.onnx` | `OMNI_FACE_MODEL` | YuNet face detector (despite the file name) | `neural_smooth_skin` |

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

## CUDA: currently inactive, and honestly reported

`onnxruntime_providers_cuda.dll` for this ORT build depends on the **CUDA 11**
runtime. With `cufft64_11.dll` (and friends) absent, ORT logs

```
Error loading "...onnxruntime_providers_cuda.dll" which depends on
"cufft64_11.dll" which is missing. (Error 126)
[omni][onnx_model_host] model 'segment': CUDA execution provider unavailable
(...); falling back to CPU provider.
```

and every neural op then runs on the **CPU provider**. That is the state on the
development machine today: the ops work, they are just not GPU-accelerated, and
VRAM usage stays flat. Install the CUDA 11 runtime to change that. Nothing in
this plugin claims GPU acceleration is active — the GPU broker claim is wired
around the ONNX ops so it is correct once CUDA is available, not because it is
doing anything for VRAM right now.

## Verifying a fresh provision

```
node scripts/run-vitest.mjs run --config test/vitest/vitest.extensions.config.ts creative-engines
```

`src/ffi/neural-ops.integration.test.ts` skips itself and prints what is missing
when this directory is not fully provisioned, and runs a real `remove_background`
inference plus a real GPU-broker lease when it is. Point
`CREATIVE_ENGINES_NEURAL_FIXTURE` at a real photograph to also assert the alpha
matte contains both cut-away and kept pixels.
