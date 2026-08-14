# Requirements Document

## Introduction

**Creative Claw** is a fork of **OpenClaw** into a local-first creative suite. This spec wires the maintainer's four compiled-C++ **creative engines** — **image, audio, video, vector** — into Creative Claw as **native agent capabilities**, so the OpenClaw assistant can drive real media edits across all four media types. With the GPU broker (separate spec) handling VRAM and the visual memory (separate spec) handling recall, the creative engines are the **hands** of the suite.

Each engine is already a proven, self-contained stack (verified in the `*-workspace` repos):
- a **compiled C++ engine** (`libomni_*_bridge.{dll,so}`) exposing real media ops,
- a **by-name dispatcher** (`bridges/omni_dispatch.py`: `list_ops`/`list_filters`/`op_info`/`apply_op`/`apply_filter`/`apply_chain`) marshalling file-path-in → file-path-out ops onto the C++ surface,
- an **MCP server** (`mcp/mcp_server.py`) already promoting the dispatcher catalog as tools,
- an **agentic layer**: the image engine has the full single-image studio (Gemma-4 plan → C++ execute → Anti_Fake_Guard → versioned edit session), and **all four now have the batch-pipeline** (apply one op or a multi-step chain across many files, with per-item honest results + a run manifest — just built),
- and a **node-graph executor** (the video-agent-ai `PipelineExecutor`/`Graph` line; image/audio/video/vector ops are node-graph-addressable through the shared dispatcher contract).

The integration question, and the maintainer's explicit constraint: **wire them in at the same architecture level as the rest of the suite — native, not as per-session MCP child processes.** OpenClaw *can* consume external MCP servers (`src/agents/agent-bundle-mcp-materialize.ts`), but that path spawns/reaps a server **per session** and serializes everything over stdio/JSON — which is genuinely bad for long-running C++ engines and for moving image/frame payloads. `INTEGRATION_ANALYSIS.md` flags this exact risk. So Creative Claw integrates each engine as a **long-lived capability** — a `registerService`-managed engine process (or in-process binding) reachable by the agent through `registerTool` ops — not a per-session stdio spawn. The engines speak **file paths** (the dispatcher contract), so the agent passes paths, not megabytes of base64; the heavy pixel/frame data stays on disk and in the C++ engine.

This is **wiring, not re-implementation.** The C++ engines, dispatchers, agentic edit session, batch runners, and Gemma-4 planner already exist and are tested. This spec exposes them through OpenClaw's plugin surface and preserves their guarantees (C++-first, honesty/Anti_Fake_Guard, single-image stacking, batch manifests).

Grounded in the verified source:
- **Dispatcher contract** (per engine, e.g. image `bridges/omni_dispatch.py`): `list_filters()`/`filter_info(name)`/`apply_filter(path,name,out,**params)`/`apply_chain(path,steps,out)`; video/vector/audio mirror it as `list_ops`/`op_info`/`apply_op`/`apply_chain` (audio: `list_effects`/`apply_effect`). Known-broken/mask ops are gated.
- **Image agentic layer**: single-model Gemma-4 multimodal planner (`mcp/scripts/image_agent.py`), `edit_session/` (SessionManager.plan/preview/confirm, PlanExecutor, Anti_Fake_Guard, version history), single-image stacking flow + revert (just built), real Real-ESRGAN GPU upscale in `bin/`.
- **Batch** (all four): `mcp/scripts/batch/` (input_set/output/batch_runner/cli) + a `batch_*` MCP tool — apply a pipeline across many files, honest ItemResults, run manifest, idempotent resume (just built).
- **Node-graph**: video-agent-ai `core/` `Node`/`Graph`/`PipelineExecutor` (typed ports, cycle detection, topo-sort) — the orchestration backbone.
- **OpenClaw seams** (`api-builder.ts`): `registerTool`, `registerService`, `registerImageGenerationProvider`/`registerVideoGenerationProvider`/`registerMusicGenerationProvider`/`registerMediaUnderstandingProvider`, `registerControlUiDescriptor`, `registerHttpRoute`, `registerCli`. `extensions/comfy/` is the precedent: a compiled external engine + a node-graph `workflow-runtime.ts` wired as a code plugin with provider registration.

The requirements below cover: a long-lived engine runtime (no per-session spawn); exposing each engine's op catalog as agent tools by name; the single-image stacking + agentic edit-session flow (image, the reference); the batch flow (all four); the node-graph surface; provider registration where it fits OpenClaw's media-gen seams; honesty/C++-first preservation; GPU-broker cooperation; and end-to-end verification on real media.

## Glossary

- **Creative_Claw**: The OpenClaw fork (the creative suite). OpenClaw is the spine.
- **Engine**: One of the four compiled C++ media engines — image / audio / video / vector — with its dispatcher + agentic/batch layers.
- **Dispatcher**: The by-name op surface over an Engine's C++ bridge (`list_ops`/`op_info`/`apply_op`/`apply_chain`; image uses `list_filters`/`apply_filter`, audio `list_effects`/`apply_effect`).
- **Engine_Op**: A single named media operation routed by the Dispatcher onto the real C++ engine (file-path in → file-path out).
- **Engine_Runtime**: A long-lived, gateway-lifetime process/binding hosting an Engine (NOT spawned/reaped per session), reached by the agent through tools.
- **Edit_Session**: The image engine's stateful plan→preview→confirm→version flow with the Anti_Fake_Guard (the reference agentic layer).
- **Single_Image_Stacking**: The image studio flow where an edit's result becomes the working image (edits stack) and only the result is shown, with revert-to-original.
- **Batch_Run**: Applying one Pipeline (single op or chain) across many inputs with per-item honest results + a run manifest (exists for all four engines).
- **Node_Graph**: The typed-port DAG executor (`Node`/`Graph`/`PipelineExecutor`) that wires Engine_Ops/AI ops into a runnable graph.
- **Anti_Fake_Guard**: The post-op verification that an op genuinely changed the media it claimed to (no unchanged-input-as-success); honesty invariant across the suite.
- **Cpp_First**: An op with a real C++ equivalent runs on the compiled engine; learned-model passes run only where no C++ equivalent exists.
- **Media_Tool**: An agent-callable tool exposing an Engine capability (an op, a batch run, a session action, a node-graph run).
- **Real_Media**: Genuine image/audio/video/vector files used for verification, not synthetic-only.

## Requirements

### Requirement 1: Long-lived engine runtime (no per-session MCP spawn)

**User Story:** As the architect, I want the C++ engines hosted as long-lived capabilities, so they're not spawned/torn down every session and don't serialize heavy media over stdio.

#### Acceptance Criteria

1. THE feature SHALL host each Engine as an Engine_Runtime managed by `api.registerService` (gateway-lifetime), NOT via OpenClaw's per-session bundle-MCP materialization.
2. THE agent SHALL reach Engine capabilities through tools registered via `api.registerTool` that call the long-lived Engine_Runtime, passing FILE PATHS (the Dispatcher contract), not inlined media bytes.
3. WHEN an Engine_Runtime is unavailable (binary missing / failed to start), THE affected Media_Tools SHALL report the engine unavailable with a reason rather than faking success.
4. THE Engine_Runtime SHALL be reused across sessions and agent runs for the gateway lifetime, and torn down only at gateway shutdown.
5. WHERE an Engine is most cleanly hosted as a co-process (e.g. a persistent dispatcher server) vs an in-process binding, THE choice SHALL be per-engine, but in all cases it SHALL be long-lived (Req 1.1) and SHALL NOT serialize bulk pixel/frame data over the agent boundary.

### Requirement 2: Expose each engine's op catalog as agent tools by name

**User Story:** As the agent, I want to list and apply each engine's real ops by name, so I can edit any media type.

#### Acceptance Criteria

1. THE feature SHALL expose, per Engine, a way for the agent to enumerate the Engine's available ops (the Dispatcher `list_ops`/`list_filters`/`list_effects` catalog) and their parameters (`op_info`/`filter_info`).
2. THE feature SHALL expose an apply tool per Engine that runs a named Engine_Op (or an `apply_chain` step list) on a real input path and writes a real output path.
3. WHEN the agent requests an unknown or gated (known-broken/mask-only) op, THE tool SHALL return an explanatory error and execute nothing (preserving the Dispatcher's guards).
4. THE op tools SHALL be available in Creative_Claw's default tool profile and namespaced per engine so the agent can target the right medium.
5. THE op execution SHALL run on the real compiled C++ engine (Cpp_First); a tool SHALL NOT simulate in the host an op the engine performs.

### Requirement 3: Image agentic edit session + single-image stacking (the reference)

**User Story:** As a creator, I want the full conversational image-editing flow inside Creative Claw, so "make it warmer, now add grain" works with stacking edits and honest results.

#### Acceptance Criteria

1. THE feature SHALL expose the image Edit_Session (plan → preview → confirm → versioned commit) so a natural-language instruction is planned by the Gemma-4 multimodal model and executed on the real C++ engine with the Anti_Fake_Guard.
2. THE feature SHALL preserve Single_Image_Stacking: a committed edit's result becomes the working image (edits stack), only the result is presented, and revert-to-original is available.
3. WHEN an edit produces no real change (Anti_Fake_Guard trips), THE feature SHALL report it honestly (not present the unchanged input as success).
4. THE image flow SHALL cooperate with the GPU broker: planning/diffusion/upscale claim VRAM through the broker and release it for other work.
5. THE seed end-to-end demonstration SHALL be: load Real_Media → natural-language instruction → planned C++ ops → real result, all inside Creative Claw.

### Requirement 4: Batch flow across all four engines

**User Story:** As a content creator, I want "apply this to a whole folder" for any media type, so the suite is a content multiplier.

#### Acceptance Criteria

1. THE feature SHALL expose each Engine's Batch_Run (the existing `batch/` runner) as a Media_Tool: apply one Pipeline (single op or chain) across an Input_Set (folder/glob/list) producing per-item ItemResults + a run manifest.
2. THE Batch_Run tools SHALL preserve the existing honesty guarantees: an `ok` item is a real content-changed output; failures/skips carry reasons; one item failure never aborts the run; idempotent re-run skips already-done items.
3. WHEN a batch step needs a learned-model pass (e.g. Real-ESRGAN upscale, segmentation) and its dependency is absent, THE affected items SHALL be skipped/failed with a reason (no fake degrade).
4. THE Batch_Run tools SHALL cooperate with the GPU broker for model-heavy pipelines.

### Requirement 5: Node-graph creative surface

**User Story:** As a creator, I want to wire engine ops (and AI passes) into a runnable graph, so multi-step cross-op creative pipelines are first-class.

#### Acceptance Criteria

1. THE feature SHALL expose the Node_Graph executor (typed-port `Node`/`Graph`/`PipelineExecutor`) as a Creative_Claw surface where nodes are real Engine_Ops (and legitimate AI passes), executed through the long-lived Engine_Runtime.
2. WHEN a graph is run, IT SHALL execute through the real `PipelineExecutor` against the real engines and produce real outputs, reporting per-node success/failure.
3. WHEN a node corresponds to a Dispatcher op, IT SHALL route to the same verified op surface the op tools use (one shared catalog, no divergent path).
4. WHERE OpenClaw's `extensions/comfy/workflow-runtime.ts` is the precedent, THE node-graph surface MAY follow that pattern (a workflow runtime exposed as tools and/or a Control UI), without claiming a node-graph core concept OpenClaw lacks.
5. IF a node fails or produces no change, THE surface SHALL report the failure (Anti_Fake_Guard), not present an unchanged result as success.

### Requirement 6: Provider registration where it fits OpenClaw's media seams

**User Story:** As the integrator, I want the engines to also light up OpenClaw's native media-generation/understanding seams where they map cleanly, so the assistant uses them through first-class provider hooks too.

> **CORRECTION — no media seam maps, and none is registered.** Verified against
> the shipping `libomni_{image,audio,video}_bridge` DLLs: the op catalogs hold
> 155 / 45 / 46 ops and NONE is `generate`. These are deterministic C++ editing
> engines; nothing in them turns a text prompt into media, so criterion 1's
> "WHERE an Engine maps onto a media-provider seam" is never satisfied for
> generation, and the media-understanding seam has no analysis hook to fill.
> The generation + id-only understanding registrations that used to exist were
> false claims (each call failed with `unknown op 'generate'`) and were removed,
> along with the `providers` / `imageGenerationProviders` /
> `musicGenerationProviders` / `videoGenerationProviders` declarations in
> `openclaw.plugin.json`. Criterion 3 is the operative one: every real
> capability ships through `registerTool`.

#### Acceptance Criteria

1. WHERE an Engine maps onto an OpenClaw media-provider seam, THE feature MAY register it: image → `registerImageGenerationProvider` (+ `registerMediaUnderstandingProvider` for analysis), audio → `registerMusicGenerationProvider`/speech, video → `registerVideoGenerationProvider`, vector → `registerTool`. — *Not exercised: no such seam maps (see correction above).*
2. THE provider registration SHALL be additive — it SHALL NOT replace or break OpenClaw's existing providers (e.g. comfy), and SHALL route to the real C++ engine. — *Satisfied trivially: nothing is registered, so nothing can shadow comfy, and no path claims a route that does not exist.*
3. WHERE a clean provider seam does not exist for a capability (e.g. vector path ops, the agentic edit session), THE capability SHALL be exposed via `registerTool` instead (Req 2/3). — *This is the path ALL engine capabilities take.*

### Requirement 7: Honesty and C++-first preserved end to end

**User Story:** As a reviewer, I want the suite's honesty guarantees to survive integration, so nothing fakes a media edit.

#### Acceptance Criteria

1. THE Anti_Fake_Guard SHALL run on integrated edits such that an `ok` result is a real, content-changed output; a no-op is reported as failure, never success.
2. THE Cpp_First principle SHALL hold: every integrated op with a real C++ equivalent runs on the compiled engine; the host SHALL NOT reimplement a C++ op.
3. WHEN an engine binary or a model dependency is unavailable, THE affected capability SHALL skip/fail with a reason rather than substitute synthetic output.
4. THE feature SHALL report, per integrated op/tool, which engine/path executed it (real C++ engine vs a learned-model pass) so the active path is honest.

### Requirement 8: GPU-broker cooperation

**User Story:** As the user, I want the engines to share the GPU with me and the LLM via the broker, so nothing thrashes VRAM.

#### Acceptance Criteria

1. WHEN a model-heavy Engine op runs (diffusion, upscale, segmentation, CLIP), IT SHALL coordinate VRAM through the GPU broker (claim/recalibrate/release) rather than loading blindly.
2. WHEN the GPU is user-claimed/draining, THE GPU-heavy Engine ops SHALL honor the claim (defer or report unavailable) consistent with the agent run gate.
3. THE pure-C++ (non-GPU) Engine ops SHALL run without a broker claim (they don't need VRAM).

### Requirement 9: End-to-end verification on Real_Media

**User Story:** As a reviewer, I want the integration proven on real files across the engines, not assumed.

#### Acceptance Criteria

1. THE feature SHALL include a per-engine smoke test: the agent (or the tool path) applies a real Engine_Op to Real_Media and gets a real, content-changed output (skip-with-reason when an engine binary/dependency is absent).
2. THE feature SHALL include an image end-to-end test: natural-language instruction → planned C++ ops → real result via the Edit_Session, inside Creative Claw.
3. THE feature SHALL include a batch smoke test for at least one engine: a Pipeline across a small Input_Set produces per-item results + a manifest.
4. THE feature SHALL include a node-graph smoke test: a small graph of real Engine_Ops runs through the PipelineExecutor and produces a real output.
5. WHEN a check needs an engine binary / model / GPU unavailable in the environment, IT SHALL skip-with-reason, never fake a pass.

## Open Questions

1. **In-process binding vs co-process per engine.** The engines' dispatchers are Python (image/audio/video/vector) calling C++ via ctypes; OpenClaw is TS. Options per engine: (a) a long-lived dispatcher **co-process** (the engine's own `mcp_server.py` or a thin persistent HTTP/stdio server) the Engine_Runtime keeps alive for the gateway lifetime, OR (b) reimplement the thin dispatcher in TS calling the C++ `.dll/.so` directly via a Node FFI (koffi/node-ffi-napi) — fully native, no Python. Decide per engine; the file-path contract makes a long-lived co-process acceptable (small JSON: op name + paths + params, not pixels). The maintainer's "native, no MCP" intent points to FFI long-term, but a long-lived co-process is the pragmatic first step and still avoids per-session spawn.
2. **Which transport for the co-process (if chosen).** A persistent local HTTP server per engine (long-lived, not per-session) vs a single kept-alive stdio process managed by `registerService`. HTTP is simpler to keep warm and health-check.
3. **Gemma-4 planner reuse.** The image planner is Python (`image_agent.py`). Does Creative Claw call it via the engine co-process, or does the OpenClaw agent itself (already multimodal-capable) become the planner, emitting the op/chain plan directly to the dispatcher tools? The latter is more native and removes a Python planner — likely preferred.
4. **Node-graph ownership.** OpenClaw has no node-graph core; the video-agent-ai `PipelineExecutor` is Python. Port it to TS (matches the visual-memory rewrite philosophy) or run it inside an engine co-process? Decide alongside OQ1.
5. **Studio UI.** The existing studios are a React/Vite popup-viewer. Reuse it as an OpenClaw Control UI surface, or rebuild the creative surface in OpenClaw's `ui` package? (Ties into the maintainer's separate "move off the browser / native desktop" thought.)
6. **Engine packaging.** How the compiled `.dll/.so` + models (Real-ESRGAN bin, ONNX weights) ship with Creative Claw (bundled in `extensions/creative-*/` vs a setup-time provisioning step), given they're large and platform-specific.
