---
summary: "Dated implementation handoff for turning the current media engines into the Creative Claw product"
read_when:
  - Planning or implementing the Creative Claw product
  - Integrating the conventional video engine with the AI/VFX node engine
  - Comparing another creator application before continuing implementation
title: "Creative Claw implementation handoff — August 31, 2026"
sidebarTitle: "Creative Claw handoff"
---

# Creative Claw implementation handoff

**Audit and handoff date:** August 31, 2026  
**Intended implementation start:** September 1, 2026  
**Repository:** `C:\Users\billk\projects\nepa-ai-monorepo.BAK\_product-repos\creative-claw`

## Executive decision

Creative Claw already has enough low-level media capability to become the product. The next release should concentrate on integration, workflow UX, packaging, and end-to-end proof rather than adding more isolated operations.

The intended product has four principal media surfaces:

1. **Image** — native C++ image editing plus neural/ONNX operations.
2. **Audio** — native DSP, extraction/replacement, transcription, narration, and silence-aware editing.
3. **Video Edit** — deterministic C++/FFmpeg editing, analysis, effects, captions, thumbnails, and platform exports.
4. **Video AI/VFX** — the typed node system currently in the sibling `video-agent-ai` repository: matting, depth, normals, relighting, VFX passes, compositing, and video-to-video.

Vector operations are already a useful fifth capability, but they are not the release blocker.

The largest gap is that Video Edit and Video AI/VFX are two functioning engines in two repositories, not one coherent Creative Claw workflow. The first major build should be a supported adapter and a shared graph contract between them.

## Verified state on August 31, 2026

### Creative Claw

- The creative engine exposes **280 catalogued operations**: 155 image, 45 audio, 46 video, and 34 vector.
- Native creative DLLs are present and load on the current Windows development machine.
- The video engine supports deterministic operations including cutting, silence removal, stabilization, speed ramps, subtitles, audio extraction/replacement, scene and silence detection, thumbnails, transitions, effects, and platform export.
- Video understanding performs real keyframe extraction and transcription.
- A JSON DAG executor exists and is accessible through `creative graph <file>`.
- Creative Studio exposes operation lists and apply forms, but it is not yet a real node editor.
- The Codex dynamic-tool bridge accepts Creative Claw tool names by mapping dotted public names such as `video.apply` to valid runtime identifiers such as `video_apply`.
- The focused Creative Claw composition, graph, and smoke suites pass. A smoke test creates a real MP4, runs `cut_clip -> thumbnail`, checks duration, decodes the output image, and verifies the artifacts.
- The Studio production build and the main TypeScript build complete successfully.

### Existing AI/VFX video application

The sibling repository is:

`C:\Users\billk\projects\nepa-ai-monorepo.BAK\_product-repos\video-agent-ai`

It contains the richer node-based AI video system that must not be lost or needlessly rebuilt:

- Typed-port DAG and executor.
- ReactFlow canvas, node palette, inspector, execution controls, and preview panel.
- C++ bridge and native dispatcher.
- Matting, depth, normal generation, relighting, VFX passes, compositing, grading, LUT, and video-to-video providers.
- Local and API provider abstractions.
- Python API, WebSocket progress path, CLI, and MCP surface.

Verified results on the current Windows machine:

- Native bridge, C++ nodes, dispatcher, graph, agent, and end-to-end suite: **91 passed** with live native execution.
- Non-API application suite: **421 passed, 22 skipped**. Skips are model/model-weight dependent.
- API and CLI suite in an isolated compatible environment: **27 passed**.
- ReactFlow frontend production build: passed.

This application is working source material and a likely orchestration backbone, not an abandoned prototype.

### Authentication

- The machine's Codex CLI is logged in with ChatGPT.
- Creative Claw contains the intended Codex-managed OAuth route.
- Creative Claw's current OpenAI OAuth profile is expired, and the runtime provider route is reported as missing.

Authentication therefore exists in code but is **not release-ready until a fresh login succeeds and a real agent turn is proven**. Use the auth-only flow instead of copying unrelated OpenClaw state:

```powershell
node openclaw.mjs models auth login --provider openai --force --set-default
```

Do not describe this as “hijacking tokens.” The supported product behavior is to use a user-authorized Codex/ChatGPT OAuth session through the existing provider route. Do not extract, copy, print, or persist raw credentials outside the established credential store.

## Phase 0: define the shared vertical-agent framework

The other application Bill recalled is the learning product at:

`C:\Users\billk\projects\learning-platform`

It is not a competing media editor or a replacement Creative Claw shell. It is a second vertical product that needs an OpenClaw-like AI framework for learning. Its public site at `https://learning.nepa-ai.com` is a working SEO/acquisition surface and must remain independently deployable.

Use the two products to establish a reusable architectural boundary:

| Shared framework responsibility | Creative Claw specialization               | Learning specialization                                  |
| ------------------------------- | ------------------------------------------ | -------------------------------------------------------- |
| Agent loop and model routing    | Creator intent and media planning          | Tutor intent and adaptive lesson planning                |
| Typed tool registry             | Image, audio, video, vector, and VFX tools | Curriculum, progress, practice, review, and tutor tools  |
| Sessions and durable state      | Projects, graphs, source assets, artifacts | Learner profile, mastery, misconceptions, and study plan |
| Jobs and progress               | Long media renders and model operations    | Content ingestion, assessment, and lesson generation     |
| Approval and safety             | Costly renders, overwrite, publish, upload | Minor safety, educator controls, grading, external links |
| Skills/workflow templates       | Creator workflows                          | Teaching strategies and learning loops                   |
| Observability                   | Graph execution and artifact provenance    | Tutor decisions, citations, progress, and outcomes       |

Do **not** merge either product frontend into the other. Do **not** move the learning catalog into Creative Claw. Extract or retain reusable runtime contracts only where they reduce duplicated infrastructure.

The current learning platform supplies useful domain code—grounded tutoring, RAG, progress, grasp scoring, spaced repetition, paths, practice selection, auth, and compliance—but it does not yet supply an agent runtime. It has no general tool-call loop, skills, dynamic tool registry, job lifecycle, approval system, or plugin boundary. Creative Claw/OpenClaw should remain the primary runtime donor.

Phase 0 deliverable: a short architecture decision record defining the minimal shared packages or protocol. It must prove one typed learning tool and one typed creative tool can use the same runtime contract while keeping storage, UI, deployment, and domain policy separate.

## Required implementation work

### P0 — create a supported Video AI/VFX adapter

Add a bundled Creative Claw extension, provisionally named `video-vfx`, that initially manages the existing Python service rather than porting it.

Minimum agent and Gateway surface:

- `vfx.list_nodes`
- `vfx.node_info`
- `vfx.graph_validate`
- `vfx.graph_run`
- `vfx.job_status`
- `vfx.job_cancel`

Requirements:

- Spawn, discover, health-check, and stop the service predictably.
- Use a versioned request/response contract.
- Stream node progress and surface useful failures.
- Return artifact metadata, not only filesystem strings.
- Cancel work without leaving child processes or locked files.
- Keep model downloads explicit and observable.
- Never expose provider credentials through tool responses or logs.

Acceptance test: from a Creative Claw agent turn, validate and run a graph that reads a real clip, performs at least one real AI/VFX operation, writes a playable output, reports progress, and leaves no service process behind after shutdown.

### P0 — establish one authoritative graph contract

Use the typed-port graph model from `video-agent-ai` as the starting point. The current simple Creative Claw graph should either become a compatible subset or receive a deterministic converter. Do not maintain two unrelated saved-project formats.

The shared graph must support:

- Versioned serialization and migration.
- Typed input and output ports.
- Static connection and parameter validation.
- Branching, merging, and reusable subgraphs.
- Deterministic topological execution.
- Per-node progress, logs, cancellation, retry, and failure state.
- Artifact identity, media metadata, provenance, and cacheability.
- Native Creative Claw image/audio/video/vector operations registered as graph nodes.
- AI/VFX nodes executed through the adapter.
- Provider-backed generation nodes where a configured provider exists.
- A dry-run/estimate stage before expensive or destructive execution.

Acceptance test: save, reload, validate, and execute a mixed graph containing at least one native video node and one AI/VFX node without hand-editing JSON.

### P0 — complete authorized Codex authentication

After performing the auth-only login command:

- Confirm `models status` reports a valid OpenAI route.
- Run a normal Creative Claw agent turn with the selected Codex model.
- Call one read-only creative tool from the model.
- Restart the application and prove the session is still resolved through the supported credential store.
- Test expired-session and revoked-session UX without exposing token material.

Acceptance test: a clean user can authenticate interactively, restart, run an agent turn, and revoke access with clear status at every stage.

### P1 — turn Creative Studio into the product workspace

Embed or adapt the existing `video-agent-ai` ReactFlow editor rather than recreating a canvas from scratch.

Creative Studio needs four top-level workspaces:

- **Image**
- **Audio**
- **Video Edit**
- **Video AI/VFX**

They should share projects, source assets, graph persistence, job history, artifacts, and agent chat. Required interaction pieces:

- Node palette with search and capability grouping.
- Canvas with typed compatible connections.
- Inspector generated from operation schemas.
- Media preview with before/after comparison.
- Video scrubbing and frame selection.
- Execution bar with validate, run, cancel, retry, and progress.
- Artifact browser with “open location,” metadata, and provenance.
- Agent-generated graph proposal shown as a visible diff.
- Approval before a costly model job, overwrite, publish, or external upload.

Acceptance test: a user creates and modifies the mixed graph from the previous section entirely in the UI and can see which nodes were proposed by the agent.

### P1 — ship creator workflows, not only operations

Each workflow must be an editable graph template with sample input, an agent prompt, validation rules, expected artifacts, and a real-media integration test.

#### 1. Long BMX video to usable riding clips

- Inspect source video and find riding segments.
- Preserve horizontal source framing.
- Cut each segment into a separate clip.
- Optionally stabilize and normalize audio.
- Produce contact sheet and metadata manifest.
- Keep this extraction workflow separate from final vertical reel composition.

#### 2. Talking-head video to cross-platform shorts

- Transcribe and detect silence.
- Propose strong segments with editable in/out points.
- Remove silence and add captions.
- Reframe into 9:16 while keeping the speaker visible.
- Normalize dialogue and optionally add ducked music.
- Export TikTok/Reels/Shorts variants plus a thumbnail.

#### 3. AI-relit product or action clip

- Select a representative frame or clip range.
- Generate matte, depth, and normals as required.
- Relight foreground while preserving identity and motion.
- Composite, grade, and compare with the source.
- Export the final video plus intermediate diagnostic passes.

#### 4. Podcast episode to social package

- Transcribe and identify self-contained moments.
- Cut clips and clean dialogue.
- Create branded captions and speaker-aware framing.
- Generate one landscape and one vertical package.
- Produce titles, descriptions, thumbnail candidates, and a manifest.

#### 5. Prompt-directed mixed-engine edit

Target prompt:

> Find the BMX riding sections, stabilize them, relight the dark footage, add readable captions, make vertical social versions, and create thumbnails. Show me the graph and estimated work before running it.

The app must propose a graph, validate it, request approval for expensive stages, execute both video engines, and return playable outputs with provenance.

### P1 — package a reproducible Windows application

Define one supported development bootstrap and one release packaging path for:

- Node/pnpm application dependencies.
- Native Creative Claw DLLs.
- `omni_video_bridge.dll` and its ABI/version check.
- Python runtime and locked Python dependencies.
- FFmpeg/ffprobe discovery.
- ONNX Runtime and optional CUDA provider.
- Whisper runtime/model configuration.
- Optional AI/VFX model weights and checksums.
- Optional local Ollama connection.

Requirements:

- No dependency on an accidental global Python or npm environment.
- Preflight reports missing runtimes, incompatible DLLs, models, disk space, and GPU support.
- CPU fallback is explicit; GPU-only nodes explain their requirements.
- Models live outside the application bundle and can be verified, relocated, or removed.
- Third-party notices and licenses ship with the application.

Acceptance test: install on a clean Windows user profile, authenticate, open sample media, run a native workflow, and run or honestly skip a model workflow based on preflight results.

### P1 — consolidate release validation

Create a root-level release command that produces a machine-readable report covering:

- Type checking, formatting, and unit tests.
- Creative Claw extension composition and tool-schema tests.
- Codex dynamic-tool mapping, collision, reserved-name, and length tests.
- Native image/audio/video/vector smoke tests.
- Real MP4 graph execution.
- AI/VFX native bridge and Python API tests.
- Studio and ReactFlow production builds.
- Mixed-engine graph execution.
- OAuth happy path and expired/revoked UX using safe test doubles where live login is unsuitable.
- Process cleanup, cancellation, and artifact integrity.

Do not turn missing model weights or CUDA into silent success. The report must distinguish **pass**, **fail**, **supported skip**, and **not configured**.

## Recommended execution order for Kiro

1. Complete Phase 0 and commit the shared-runtime architecture decision.
2. Write the versioned shared graph schema and compatibility fixtures.
3. Build the read-only `video-vfx` discovery/validation adapter.
4. Add run, progress, artifacts, cancellation, and lifecycle management.
5. Register native Creative Claw operations in the shared graph.
6. Complete and verify the supported OAuth path.
7. Integrate the existing ReactFlow canvas into Creative Studio.
8. Implement the mixed-engine prompt-directed workflow first.
9. Add the remaining creator templates and real-media fixtures.
10. Lock packaging and make the consolidated release report green.

Every step should leave a runnable vertical slice. Avoid a long-lived branch that changes the graph, service, UI, and packaging without an end-to-end test.

## Guardrails

- Preserve current uncommitted work in both repositories; inspect diffs before editing overlapping files.
- Do not rewrite working C++ engines in TypeScript or Python merely to unify the stack.
- Do not copy OAuth secrets, model tokens, or provider keys into configuration files, test fixtures, logs, or prompts.
- Do not call UI-only demos complete; verify decoded media outputs.
- Do not hard-code local absolute paths into product code or saved projects.
- Do not silently download multi-gigabyte models during normal editing.
- Do not publish or upload creator media without an explicit approval boundary.
- Keep source assets immutable by default and write versioned artifacts.
- Preserve `video-agent-ai` until mixed-engine workflow parity and artifact equivalence are proven.

## Release definition of done

Creative Claw is ready for a creator test when all of the following are true:

- A clean user can launch the app and complete supported Codex OAuth.
- Image, audio, Video Edit, and Video AI/VFX appear as coherent workspaces.
- The agent can discover operations and propose a valid, visible graph.
- The user can edit and approve that graph before execution.
- One graph can cross the native video and AI/VFX engines.
- Progress, cancellation, errors, and artifacts work across process boundaries.
- At least the five creator workflows above run against real fixtures.
- The Windows package passes preflight on a clean user profile.
- The consolidated release report contains no unexplained skips.
- The original source media remains untouched and every generated artifact has provenance.

At that point the app is no longer a collection of engines with a branded panel; it is a testable Creative Claw product.
