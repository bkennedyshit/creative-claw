# Creative Engines Integration — Design

## Overview

Wire the four compiled-C++ creative engines (image/audio/video/vector) and their batch + node-graph surfaces into Creative Claw as **native, long-lived agent capabilities** — not per-session MCP child processes. The engines, dispatchers, image agentic edit-session, batch runners, and node-graph executor already exist and are tested; this is **wiring through OpenClaw's plugin surface**, preserving Cpp_First and the Anti_Fake_Guard.

The architecture decision that shapes everything: OpenClaw's bundle-MCP path spawns a server **per session** and serializes over stdio — bad for long-running C++ engines and heavy media. So each engine is hosted as a **gateway-lifetime Engine_Runtime** (`api.registerService`), reached by the agent through `api.registerTool` ops that pass **file paths** (the dispatcher contract), keeping pixel/frame bulk on disk and in the engine.

Grounded in verified source:
- **Dispatchers** (file-path in→out): image `bridges/omni_dispatch.py` (`list_filters`/`filter_info`/`apply_filter`/`apply_chain`); video/vector (`list_ops`/`op_info`/`apply_op`/`apply_chain`); audio (`list_effects`/`apply_effect`/`apply_chain`). Known-broken/mask ops gated.
- **Image agentic layer**: `mcp/scripts/image_agent.py` (single-model Gemma-4 plan), `edit_session/` (SessionManager.plan/preview/confirm, PlanExecutor, Anti_Fake_Guard, version history), single-image stacking + revert, Real-ESRGAN GPU upscale.
- **Batch** (all four): `mcp/scripts/batch/` + a `batch_*` MCP tool — pipeline across many files, honest ItemResults, manifest, idempotent resume.
- **Node-graph**: video-agent-ai `core/` `Node`/`Graph`/`PipelineExecutor`.
- **OpenClaw seams** (`api-builder.ts`): `registerService`, `registerTool`, `registerImage/Video/MusicGenerationProvider`, `registerMediaUnderstandingProvider`, `registerControlUiDescriptor`, `registerHttpRoute`, `registerCli`. Precedent: `extensions/comfy/` (compiled external engine + `workflow-runtime.ts` node graph as a code plugin).

> **`requirements.md` is the source of truth.** Open Questions resolved at the end.

## Architecture

```
   Creative Claw gateway (OpenClaw spine)  ── GPU broker (separate spec) coordinates VRAM
        │
        ▼
   ┌──────── extensions/creative-engines/ (NEW code plugin, umbrella) ──────────┐
   │ index.ts definePluginEntry({ id:"creative-engines", register(api){...} })   │
   │   per engine (image/audio/video/vector):                                    │
   │     api.registerService(engineRuntime)   ── gateway-lifetime, kept warm     │
   │     api.registerTool(<engine>.list_ops / op_info / apply / apply_chain)     │
   │     api.registerTool(<engine>.batch)     ── the batch runner                │
   │   image only:                                                               │
   │     api.registerTool(image.edit_session.{plan,preview,confirm,revert})      │
   │     api.registerImageGenerationProvider / registerMediaUnderstandingProvider│
   │   shared:                                                                   │
   │     api.registerTool(creative.graph.run)  ── node-graph executor            │
   │     api.registerControlUiDescriptor / registerCli  ── studio surface        │
   └───────────────┬──────────────────────────────────────────────────────────┘
                   ▼ file paths + op names + params (small JSON; NOT pixels)
   ┌──────── Engine_Runtime (per engine, LONG-LIVED) ───────────────────────────┐
   │  Option A (first step): kept-warm dispatcher co-process (HTTP) — the         │
   │   engine's persistent server; registerService starts/health-checks/stops it │
   │  Option B (native end-state): TS dispatcher via Node FFI (koffi) → C++       │
   │   libomni_<engine>_bridge.{dll,so} directly, no Python                       │
   └───────────────┬──────────────────────────────────────────────────────────┘
                   ▼
   ┌──────── Compiled C++ engines (real media ops) + model passes ──────────────┐
   │  libomni_image/audio/video/vector_bridge.{dll,so}; Real-ESRGAN; ONNX/CLIP   │
   │  (GPU passes claim VRAM via the GPU broker)                                  │
   └────────────────────────────────────────────────────────────────────────────┘
```

## Components and Interfaces

### Component 1: Engine_Runtime (`src/runtime/`) — long-lived host per engine

A `registerService`-managed object per engine that owns the engine's execution path for the gateway lifetime (Req 1.1, 1.4):
- **Phase 1 (co-process, pragmatic):** start the engine's persistent dispatcher as a **kept-warm local HTTP server** (one per engine), health-check it, restart on crash, stop at shutdown. The agent boundary carries op-name + file-paths + params (small JSON), never pixels (Req 1.2, 1.5). This avoids per-session spawn while reusing the proven Python dispatcher unchanged.
- **Phase 2 (native end-state, OQ1):** replace the co-process with a **TS dispatcher over Node FFI (koffi)** calling `libomni_<engine>_bridge.{dll,so}` directly — fully native, no Python, matching the visual-memory rewrite philosophy. The tool surface is identical, so this swap is invisible to the agent.

```ts
interface EngineRuntime {
  readonly engine: "image" | "audio" | "video" | "vector";
  readonly available: boolean;            // binary/server up?
  listOps(): Promise<OpCatalog>;           // list_ops/list_filters/list_effects
  opInfo(name: string): Promise<OpInfo>;
  apply(input: string, op: string, output: string, params?: object): Promise<ApplyResult>;
  applyChain(input: string, steps: Step[], output: string): Promise<ApplyResult>;
  shutdown(): Promise<void>;
}
```
Unavailable engine → tools report unavailable with reason (Req 1.3, 7.3).

### Component 2: Op tools (`src/tools/ops.ts`)

Per engine, register via `api.registerTool` (default profile, namespaced — Req 2.4):
- `<engine>.list_ops` → the Dispatcher catalog (Req 2.1)
- `<engine>.op_info` → params/defaults (Req 2.1)
- `<engine>.apply` → run one Engine_Op on a real path → real output (Req 2.2)
- `<engine>.apply_chain` → a step list in one pass (Req 2.2)
Unknown/gated op → explanatory error, nothing executed (Req 2.3). Runs on the real C++ engine (Cpp_First, Req 2.5, 7.2). Each result reports the executing path (Req 7.4).

### Component 3: Image Edit_Session + single-image stacking (`src/image/`)

Expose the image agentic flow (Req 3):
- `image.edit_session.plan/preview/confirm/revert` tools backed by the existing `edit_session/` (SessionManager/PlanExecutor/Anti_Fake_Guard/version history).
- Single_Image_Stacking preserved: a confirmed result becomes the working image, only the result shown, revert-to-original (Req 3.2).
- **Planner (OQ3):** prefer the **OpenClaw agent itself as the planner** — it's already multimodal; it emits the op/chain plan to the dispatcher tools, removing the Python `image_agent.py` planner. Fallback: call the planner via the engine co-process. Either way, plan → C++ execute → Anti_Fake_Guard (Req 3.1, 3.3).
- GPU cooperation: diffusion/upscale claim VRAM via the broker (Req 3.4, 8.1).

### Component 4: Batch tools (`src/tools/batch.ts`)

Per engine, register `<engine>.batch` backed by the existing `mcp/scripts/batch/` runner (Req 4): an Input_Set + Pipeline → per-item ItemResults + run manifest, preserving honesty (ok ⇒ real change, failures/skips with reasons, one failure never aborts, idempotent resume — Req 4.2). Model-heavy steps skip-with-reason when the dependency is absent (Req 4.3) and coordinate VRAM via the broker (Req 4.4).

### Component 5: Node-graph surface (`src/graph/`)

Expose the node-graph executor as `creative.graph.run` (Req 5). Two paths (OQ4): port the video-agent-ai `PipelineExecutor`/`Graph` to **TS** (matches the visual-memory rewrite, native), or run it inside an engine co-process. Nodes are real Engine_Ops routed through the same Engine_Runtime/Dispatcher the op tools use (one shared catalog, Req 5.3); the graph runs through the real executor → real outputs + per-node status (Req 5.2); a failing/no-change node is reported, not faked (Req 5.5). Follows the `extensions/comfy/workflow-runtime.ts` pattern (Req 5.4).

### Component 6: Provider registration (`src/providers.ts`)

Additively register engines on OpenClaw media seams where they map (Req 6): image → `registerImageGenerationProvider` + `registerMediaUnderstandingProvider`; audio → `registerMusicGenerationProvider`/speech; video → `registerVideoGenerationProvider`; vector → tools only. Must not break existing providers (comfy) and must route to the real C++ engine (Req 6.2). Capabilities without a clean seam (vector path ops, edit session) stay on `registerTool` (Req 6.3).

### Component 7: GPU-broker cooperation (`src/gpu-coop.ts`)

Model-heavy ops (diffusion/upscale/segmentation/CLIP) claim VRAM through the GPU broker (separate spec) before loading, recalibrate after warm, release after (Req 8.1); honor a user-claimed/draining GPU (defer/report unavailable, Req 8.2). Pure-C++ ops run with no claim (Req 8.3).

### Component 8: Studio/operator surface (`src/surface.ts`)

`api.registerControlUiDescriptor` + `api.registerHttpRoute` and/or `api.registerCli("creative", ...)` to drive op/batch/session/graph from the operator side (Req 2.4, studio). Reuse vs rebuild of the React popup-viewer is OQ5 (ties into the maintainer's native-desktop idea).

## Data Models

- **OpCatalog**: `{ engine, ops: [{ name, params: [{name, default, required}] }] }` (from `list_ops`+`op_info`).
- **Step**: `{ op|filter|effect: string, params: object }` (the dispatcher chain shape per engine).
- **ApplyResult**: `{ ok, output?, engine_path: "cpp"|"model"|"ffmpeg", changed: bool, reason? }`.
- **Batch ItemResult / Run_Manifest**: as built — `{ input, output|null, status: ok|skipped|failed, ops_applied, reason? }` + manifest `{ pipeline, input_set, items, counts, output_dir, ... }`.
- **Edit_Session Version**: as built — immutable snapshot + plan/tool-calls/parent metadata.
- **Graph plan**: the `Graph.to_dict()` `{ name, nodes, connections }` shape.

## Correctness Properties

### Property 1: Long-lived runtime, not per-session
An Engine_Runtime started for the gateway is reused across ≥2 agent runs/sessions (same process/binding), and is not spawned per request.
**Validates: Requirements 1.1, 1.4**

### Property 2: Ops run on the real C++ engine (Cpp_First)
An `<engine>.apply` produces a real content-changed output via the compiled engine; the host does not reimplement the op; the result reports `engine_path` truthfully.
**Validates: Requirements 2.5, 7.2, 7.4**

### Property 3: Honesty / Anti_Fake_Guard preserved
An op/edit that produces no real change is reported failed (not ok); an unknown/gated op executes nothing and errors.
**Validates: Requirements 2.3, 7.1**

### Property 4: Single-image stacking + edit session
A confirmed edit's result becomes the working image (next edit stacks on it); revert restores the original; a no-op edit is reported, not presented as success.
**Validates: Requirements 3.2, 3.3**

### Property 5: Batch honesty preserved through integration
A batch tool run yields one ItemResult per input; ok ⇒ real change; one failure doesn't abort; idempotent re-run skips done items.
**Validates: Requirements 4.1, 4.2**

### Property 6: Node-graph runs real ops
A small graph of real Engine_Ops executes through the PipelineExecutor against the real engine, produces a real output, reports per-node status, and routes through the same catalog as the op tools.
**Validates: Requirements 5.1, 5.2, 5.3**

### Property 7: GPU cooperation
A model-heavy op claims/releases VRAM via the broker and honors a user claim; a pure-C++ op runs with no claim.
**Validates: Requirements 8.1, 8.2, 8.3**

> Non-property checks: engine-unavailable → honest tool error (Req 1.3); tools in default profile + namespaced (Req 2.4); provider registration additive, doesn't break comfy (Req 6.2); end-to-end smokes per engine (Req 9).

## Error Handling

| Scenario | Behavior |
|---|---|
| Engine binary/server down | Tools report engine unavailable + reason; no fake (Req 1.3, 7.3). |
| Unknown/gated op | Explanatory error, nothing executed (Req 2.3). |
| Op produces no change | Anti_Fake_Guard → reported failure, not success (Req 7.1). |
| Model dep absent (Real-ESRGAN/ONNX) | Skip/fail with reason; no synthetic substitute (Req 4.3, 7.3). |
| GPU user-claimed | Model-heavy op defers/reports unavailable (Req 8.2). |
| Co-process crash | registerService restarts it; in-flight op errors honestly. |
| Batch item failure | Recorded failed; run continues (Req 4.2). |
| Node fails in a graph | Per-node failure reported; not presented as success (Req 5.5). |

## Testing Strategy

Two tiers:
- **Always-runnable (logic, no engine):** runtime-lifetime reuse (mocked engine), tool registration + default profile + namespacing, unknown/gated-op error, honest-unavailable, batch ItemResult shape, node-graph wiring (trivial op), provider-registration additivity.
- **Engine/model/GPU-gated (skip-with-reason when absent):** per-engine op smoke on Real_Media (Property 2), image NL→edit-session end-to-end (Req 9.2), batch smoke + manifest (Req 9.3), node-graph smoke (Req 9.4), GPU cooperation (Property 7). Never fake — skip with a recorded reason when a binary/model/GPU is missing.

Language: TypeScript (`vitest`) for the OpenClaw-side wiring; the engines themselves stay as their compiled C++ + (Phase 1) Python dispatcher co-process or (Phase 2) TS-FFI. Real media fixtures per engine.

## Open Questions — resolved as design decisions

1. **Co-process vs FFI:** **Phase 1 = long-lived dispatcher co-process** (one kept-warm local HTTP server per engine, managed by `registerService`) — reuses the proven Python dispatcher, avoids per-session spawn, ships fast. **Phase 2 = TS FFI (koffi) → the C++ `.dll/.so`** for the fully-native, no-Python end-state. The tool surface is identical, so Phase 2 is an internal swap. Start Phase 1, migrate per engine.
2. **Co-process transport:** persistent local **HTTP** per engine (easy to keep warm + health-check), not per-session stdio.
3. **Planner:** prefer the **OpenClaw multimodal agent as the planner** (emit op/chain plans to the dispatcher tools) — removes the Python planner, most native. Co-process planner is the fallback if OpenClaw's planning quality lags Gemma-4 for op selection.
4. **Node-graph:** **port `PipelineExecutor`/`Graph` to TS** (matches the visual-memory rewrite, native, in-process) — it's small and typed. Defer if Phase 1 timeline is tight (run it in a co-process meanwhile).
5. **Studio UI:** defer the decision; expose a minimal Control UI + CLI in v1. The React popup-viewer reuse vs OpenClaw `ui` rebuild ties into the maintainer's separate native-desktop track — not blocking.
6. **Engine packaging:** bundle the `.dll/.so` + models per engine under `extensions/creative-engines/<engine>/` with a setup-time provisioning step for the large/platform-specific artifacts (Real-ESRGAN bin, ONNX weights), mirroring how the workspaces already gitignore + provision them.

## Honesty Ledger

**Real once implemented:** the agent drives real C++ media ops across all four engines through long-lived runtimes (no per-session spawn); ops run on the compiled engine (Cpp_First) and report their true execution path; the Anti_Fake_Guard, single-image stacking, batch manifests, and node-graph per-node status all survive integration; model-heavy ops cooperate with the GPU broker.

**Needs validation during implementation:** the co-process-vs-FFI choice per engine (OQ1); whether OpenClaw's agent plans op selection as well as Gemma-4 (OQ3); the TS node-graph port (OQ4); engine packaging/provisioning (OQ6).

**Out of scope:** rewriting the C++ engines (used as-is); the GPU broker and visual-memory rewrites (separate specs); the native-desktop shell decision (separate track); a full polished studio UI (minimal surface only in v1).
