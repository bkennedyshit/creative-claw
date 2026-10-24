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
- `/plugins/creative-engines/artifacts/<artifact-id>`: authenticated media preview
  for recorded artifacts only. Studio fetches the preview with Gateway credentials.

This slice supplies one operation per saved graph. A general node canvas and the
Video AI/VFX adapter are separate follow-up work.

## Verify locally

```powershell
corepack pnpm test extensions/creative-engines/src/studio.test.ts extensions/creative-engines/src/capabilities.test.ts extensions/creative-engines/src/tools/discovery.test.ts
```

These tests use real native libraries and FFmpeg. They check exact inverted
pixels, requested resize dimensions, video duration, immutable sources, schema
validity, rejection of existing export targets, and recovery after SQLite closes
and reopens. Missing native dependencies fail the tests explicitly.

For Gateway authentication and access, see the
[Control UI guide](https://docs.openclaw.ai/web/control-ui).
