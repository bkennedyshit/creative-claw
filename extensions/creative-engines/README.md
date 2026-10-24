# Creative Studio

Creative Studio runs local media operations and preserves the source, typed
operation graph, parameters, and completed output for later inspection.

## Run an operation

Start the Gateway with `corepack pnpm openclaw gateway`, then open
`http://127.0.0.1:18789/creative` using the configured dashboard authentication.
The native engine libraries must be installed. Audio and video also need
FFmpeg and FFprobe on PATH or configured through the plugin's existing codec
settings.

1. Select Image or Video and enter an input file's absolute path.
2. Select an operation. Its descriptor supplies the parameter controls and defaults.
3. For an image, try `invert` or `scale` with explicit width and height.
4. For a video, try `cut_clip` with `start_sec=1`, `end_sec=3`, and
   `stream_copy=false` for a re-encoded cut. Stream copying cuts at keyframes;
   `end_sec=0` runs through the end of the source.
5. Leave Export path empty to keep the result in the project. An explicit export
   path must not already exist. The source and existing exports are preserved.
6. Run, then inspect the output preview. Recent outputs remain available after
   restarting the Gateway and reloading Studio. The latest saved operation and
   parameters are restored; its export path is cleared to prevent accidental reuse.

Image effects and video frame effects use native C++ through koffi. File-level
video edits such as trimming use FFmpeg. Analysis operations and operations that
need multiple inputs or specialized editor state are outside this single-input
workflow and report an error rather than recording a successful artifact.

## Search source media

Index a folder through the `media_index` agent tool or the authenticated Gateway
method `visual-memory.index.v1` with `{ "directory": "<absolute-folder>" }`.
Studio's search field calls `visual-memory.search.v1`; a blank query lists recent
indexed assets. Selecting a result fills the input path. An empty index is a
valid state. A missing search service is shown explicitly.

The current hash embedder provides lexical/byte similarity, not semantic vision.

## Edit and run a workflow

The **Workflow launchpad** offers 35 editable starting points: seven real-model
AI foreground workflows plus cinematic warm
film, monochrome, golden-hour and cool grades, dreamy motion, retro chromatic
film, ACES/Reinhard tone mapping, flips, speed changes, sharpening, five social
exports, three thumbnail workflows, soundtrack extraction/cleanup, and four
image workflows. Search by name or operation, or filter by category. Unavailable
engines disable the relevant starter rather than pretending it can run.

Choose **Use …** to create an independent saved graph. Every parameter and
connection remains editable; the recipes are starting points, not limits.
Save an edited draft before loading another starter. **Duplicate workflow**
copies the current graph, including unsaved edits, without overwriting the
original. **Export workflow JSON** downloads a portable canonical graph;
**Import workflow JSON** validates it on the Gateway and saves it under a new
ID. Imported paths and parameters are retained; inspect them before running.
Import is capped at 64 KB, matching the workflow store's record size.

Social presets fit/pad rather than stretch or automatically crop/reframe.
Slow motion changes playback speed; it does not synthesize new frames. Audio
cleanup exports mono WAV, not a cleaned soundtrack remuxed into the video.
Video speed changes support clips with or without audio and match audio tempo
to the selected speed multiplier.

1. In **Editable workflows**, choose **New workflow**, name it, and enter the
   absolute source path. Select the source's media type.
2. Use **Add operation** to insert nodes. Compatible operations connect to the
   previous result automatically. A workflow supports up to 32 operations,
   each with one file input and one file output.
3. Select a node to edit its parameters or **Node input** connection. Choose
   **Workflow result** to select the final output. Removing a node removes its
   connections; reconnect affected inputs explicitly.
4. Drag nodes to arrange the canvas, or focus a node and use the arrow keys.
5. Choose **Save & validate**. Drafts can be saved with structural issues, but
   cycles, incompatible media types, missing connections, unsupported operations,
   and invalid parameters block execution. Save before switching workflows.
6. Choose **Run workflow**. Studio saves a new revision, validates it, and runs
   that exact revision in dependency order. Sources remain immutable. Every
   completed node records its artifact and parentage; the final result is
   previewed. Use **Workflow export** for an optional new export file; leave it
   blank to keep the result in the project.

Workflow names, parameters, connections, positions, and source paths persist in
SQLite and restore after reload. Revisions use atomic checks: if another tab
saves newer edits, reload before saving or running the stale copy.

Only file-producing operations are offered by this editor. Specialized buffer,
mask, analysis, generator, and multi-input operations need their own editor.
Disabled nodes do not bypass processing: reconnect any inputs that reference them.

## Configure the Video AI/VFX bridge

The **VFX** tab adds native image/video color grading and tone mapping from
the `video-agent-ai` C++ bridge. Set
`plugins.entries.creative-engines.config.vfx.binaryPath` to the absolute bridge
library file. On Windows, the sibling repository builds
`engine-src/lib/omni_video_bridge.dll`; Linux builds `libomni_video_bridge.so`.
Alternatively, package that bridge as `omni_vfx_bridge` in the plugin's
`binaries/` directory using the platform's library suffix/prefix.

Do not substitute Creative Claw's existing video library: despite similar
names, its RGBA ABI differs from the sibling bridge's RGB8 ABI. Studio adapts
RGBA frames to RGB8 and back, preserves image alpha, and re-muxes video audio.
The engine reports unavailable if its bridge is missing or incompatible.
Restart the Gateway after changing the configured library.

Color grading exposes exposure, saturation, contrast, temperature, and tint.
Tone mapping exposes Reinhard (`mode=0`) and ACES (`mode=1`) plus white point.
Native frame effects and VFX stream frames through bounded, backpressured codec
pipes instead of buffering the whole clip. Processing supports up to 16 megapixels
per frame and 240 fps; odd dimensions are padded to even dimensions for H.264.
Rotation metadata is normalized into the output geometry. Variable-frame-rate
sources are normalized to their average frame rate, so timing can differ by a frame.

These four VFX operations do not use AI models. Existing model-backed native
operations remain available when their required models are installed; the
inspector labels model requirements. Python-only AI nodes from the sibling
project are not integrated into this native runtime.

## Native AI foreground effects

The **Native AI** tab and **AI foreground** starters run real local U2Net
segmentation through the image engine's guarded C++/ONNX Runtime boundary.
Image operations provide transparent PNG cutout, background blur, solid-color
background replacement, and grayscale matte. Video operations provide background
blur, solid-color replacement, and matte inspection in MP4 while preserving audio.
They do not use a hosted AI service or upload source media.

Video inference is per-frame with optional exponential mask smoothing. It is
not recurrent RVM matting: fast motion may show mask trails, and reducing
`temporal_smoothing` to zero disables that blending. Video outputs are opaque
H.264; transparent video export is not implemented. Inspect the matte before
using an output in a public demo.

The model must exist at `binaries/models/u2net.onnx` or the existing
`OMNI_SEG_MODEL` override. A matching ONNX Runtime sidecar and the guarded native
bridge are required. The Native AI engine reports unavailable with a reason if
those dependencies or exports are missing. Completed artifacts record the model
path, SHA-256, and actual CPU/CUDA provider, not merely GPU availability.

`native/guarded-segment.cpp` adds the missing status-returning segmentation ABI.
It catches native exceptions, rejects invalid buffers/dimensions, and never treats
an exception sentinel as a valid matte. The CMake injection builds an additional
translation unit and a generated model-host copy without modifying the source
engine checkout. Disabling CUDA discovery also enforces CPU session creation
in the guarded host, even when CUDA DLLs were inherited on PATH. Re-enabling CUDA
requires a process restart. A CUDA runtime can still fail outside C++ exception
handling; validate it independently before enabling it on a production gateway.

From a Visual Studio x64 developer PowerShell with CMake/Ninja available:

```powershell
./extensions/creative-engines/native/build-guarded-image.ps1 -EngineSource '<engine-source>/omni_image_processing' -BuildDirectory '<build-directory>' -OnnxRuntimeRoot '<matching-onnxruntime-sdk>'
```

The engine source must include the GAP-2 ONNX host and segmentation adapter.
Stop the Gateway, preserve the old library, and install the built image bridge
into the existing `binaries/` directory alongside its matching runtime and models.
Do not commit binary/model files. See `binaries/README.md` for load-order and
dependency requirements. CPU mode uses the existing plugin setting
`plugins.entries.creative-engines.config.cuda.enabled=false`. Validate CUDA separately
before enabling it; a native GPU-driver failure can terminate the gateway process.

## Progress, cancellation, and restart recovery

**Run workflow** now starts a durable Gateway job and returns immediately.
Studio displays the active node, processed frame count, estimated total frames,
and a cancel control. Native segmentation runs asynchronously, so Gateway status
requests remain responsive during inference. One workflow executes at a time;
up to eight additional jobs can wait without competing for GPU/model memory.

Reloading the page reattaches to the active job. Queued graphs are immutable
snapshots of their saved revision, so edits cannot change work already submitted.
Cancellation stops codecs and prevents later nodes from dispatching; a current
native inference must return before it can be cancelled. Temporary encoded output
is cleaned up, original sources and existing export targets are preserved, and
completed upstream artifacts remain available.

Job states and throttled progress are stored in SQLite. If the Gateway stops
mid-job, the next startup marks pending/running work **interrupted**, with a clear
instruction to rerun; it does not fabricate completion or silently repeat exports.

## Durable records and discovery

Studio uses the host's plugin-state SQLite store for project, source, graph, and
artifact records. Managed source copies and completed media live beneath the
configured state directory at `creative-claw/projects/studio/`. Only finalized,
nonempty outputs are registered. Artifact records include SHA-256 identity,
source parentage, capability version, and resolved parameters.

- `creative.capabilities.search`: compact agent discovery; defaults to 10 results,
  capped at 50. `creative.capabilities.get` returns the selected descriptor.
- `creative.graph.validate`: checks the canonical graph wire shape and typed
  connections without executing media.
- `creative.studio.run`: accepts `engine`, `input`, `op`, optional `output`, and
  a `params` object. Validates parameters and graph before dispatch.
- `creative.studio.snapshot`: returns the project, recent runs, and preview references.
- `creative.studio.graph.save`: accepts a canonical `graph`, atomically increments
  its revision, and returns the saved graph and structural validation issues.
- `creative.studio.graph.get`: accepts `id` and returns the saved graph.
- `creative.studio.graph.run`: accepts `id`, the expected `revision`, `input`, and
  optional `output`. Validates and executes the stored graph, returning per-node results.
- `vfx.list_ops`: reports bridge availability and the four native VFX descriptors.
- `creative.studio.recipes`: lists the editable starter workflows.
- `creative.studio.recipe.create`: accepts recipe `id` and optional source `input`,
  creating an independent saved graph.
- `creative.studio.graph.copy`: accepts canonical `graph` JSON and saves a new
  independent graph, remapping graph-boundary connections to the new ID.
- `ai.list_ops`: reports guarded bridge/model readiness and seven AI descriptors.
- `creative.studio.job.start`: accepts saved graph `id`, expected `revision`,
  source `input`, and optional export `output`; returns an immediately trackable `job`.
- `creative.studio.job.get`, `.cancel`: accept job `id`; return its current `job`.
- `creative.studio.job.list`: returns recent durable `jobs`.
- `/plugins/creative-engines/artifacts/<artifact-id>`: authenticated media preview
  for recorded artifacts only. Studio fetches the preview with Gateway credentials.

## Verify locally

```powershell
corepack pnpm test extensions/creative-engines/src/studio.test.ts extensions/creative-engines/src/capabilities.test.ts extensions/creative-engines/src/tools/discovery.test.ts
```

These tests use real native libraries and FFmpeg. They check exact inverted
pixels, requested resize dimensions, video duration, immutable sources, schema
validity, rejection of existing export targets, and recovery after SQLite closes
and reopens. Mixed native/VFX graph and audio/alpha tests run when the sibling
bridge exists, or when `VFX_NATIVE_TEST_BINARY` points to a built bridge. Without
that optional bridge, those tests are explicitly skipped. The core native tests
still require their native libraries and FFmpeg.

The UI controller tests cover graph authoring, typed connections, parameter and
layout edits, save conflicts, restore, and running the saved revision.

The additional `runtime/ai.test.ts`, `ffi/video-stream.test.ts`,
`ffi/native-guard.test.ts`, and `studio-jobs.test.ts` suites cover real segmentation,
transparent cutouts, audio preservation, rotation, encoder failure, cancellation,
corrupt-model isolation, queue bounds, and SQLite restart recovery. Native AI
tests use CPU by default; `CREATIVE_ENGINES_EXPECT_CUDA=1` explicitly opts into
GPU validation. `studio.test.ts` executes every installed starter recipe against
real fixture media. Run these native suites with `--fileParallelism=false` to
avoid competing model sessions. The UI job tests also cover reconnecting to a
running job and retaining its execution trace when the saved graph is restored.

For Gateway authentication and access, see the
[Control UI guide](https://docs.openclaw.ai/web/control-ui).
