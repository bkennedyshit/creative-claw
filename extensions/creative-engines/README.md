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

The **AI / VFX** tab adds native image/video color grading and tone mapping from
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
Video frame effects currently decode the clip into memory: test with short,
low-resolution clips before larger jobs.

These four VFX operations do not use AI models. Existing model-backed native
operations remain available when their required models are installed; the
inspector labels model requirements. Python-only AI nodes from the sibling
project are not integrated into this native runtime.

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

For Gateway authentication and access, see the
[Control UI guide](https://docs.openclaw.ai/web/control-ui).
