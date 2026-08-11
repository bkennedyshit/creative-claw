# Implementation Plan: Creative Engines Integration

## Overview

Wire the four C++ creative engines + batch + node-graph into Creative Claw as native, long-lived agent capabilities. Order: stand up the long-lived Engine_Runtime (Phase-1 kept-warm co-process, no per-session spawn) and the per-engine op tools first, then the image agentic edit-session + single-image stacking (the reference flow), then the batch tools across all four, then the node-graph surface, then provider registration + GPU-broker cooperation, then end-to-end smokes on real media. Wiring, not re-implementation — the engines, dispatchers, edit session, batch runners, and node-graph already exist and are tested.

Language: TypeScript (`vitest`) for the OpenClaw-side plugin; engines stay compiled C++ + (Phase 1) a kept-warm Python dispatcher co-process, with a Phase-2 path to TS-FFI (koffi). Tests split always-runnable (mocked engine) vs engine/model/GPU-gated (skip-with-reason). Reference: the `*-workspace` dispatchers/edit_session/batch, video-agent-ai `core/`, OpenClaw `api-builder.ts` + `extensions/comfy/`. DEPENDS ON the gpu-broker spec (for Req 8 cooperation) and complements the visual-memory spec.

## Tasks

- [x] 1. Scaffold the umbrella plugin
  - [x] 1.1 Create `extensions/creative-engines/` with `openclaw.plugin.json` (code plugin, configSchema for per-engine binary/server paths + packaging) + `index.ts` (`definePluginEntry`)
    - _Requirements: 1.1_

- [x] 2. Long-lived Engine_Runtime (Phase 1: kept-warm co-process) (implemented as native in-process FFI per design OQ1 Phase-2)
  - [x] 2.1 `src/runtime/engine-runtime.ts` — registerService-managed per-engine runtime: start the engine's persistent dispatcher as a kept-warm local HTTP server, health-check, restart-on-crash, stop at shutdown; expose listOps/opInfo/apply/applyChain over file paths (small JSON, no pixels) (implemented as native in-process FFI per design OQ1 Phase-2)
    - One instance per engine for the gateway lifetime; unavailable engine → `available=false` + reason
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_
  - [x]* 2.2 Test (mocked engine server): runtime reused across ≥2 runs (not per-session); unavailable engine reports honest error
    - **Property 1 — Validates: Requirements 1.1, 1.4**

- [x] 3. Per-engine op tools
  - [x] 3.1 `src/tools/ops.ts` — register `<engine>.list_ops`/`op_info`/`apply`/`apply_chain` via api.registerTool (default profile, namespaced) for all four engines, routing to the Engine_Runtime; unknown/gated op → explanatory error, nothing executed; result reports engine_path
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 7.2, 7.4_
  - [x]* 3.2 Tests: tool registration + default profile + namespacing; unknown/gated-op error (no execution)
    - **Property 3 — Validates: Requirements 2.3, 7.1**

- [x] 4. Image agentic edit-session + single-image stacking (the reference)
  - [x] 4.1 `src/image/edit-session.ts` — register `image.edit_session.plan/preview/confirm/revert` backed by the existing edit_session/ (SessionManager/PlanExecutor/Anti_Fake_Guard/versions); preserve single-image stacking (result becomes working image, only result shown, revert-to-original)
    - Planner: prefer the OpenClaw multimodal agent emitting the op/chain plan to the dispatcher tools (remove the Python planner); co-process planner fallback
    - _Requirements: 3.1, 3.2, 3.3, 3.5_
  - [x] 4.2 GPU cooperation for image: planning/diffusion/upscale claim VRAM via the broker, release after
    - _Requirements: 3.4, 8.1_
  - [x]* 4.3 Tests: stacking (result becomes working image, revert restores original), no-op edit reported not faked
    - **Property 4 — Validates: Requirements 3.2, 3.3**

- [ ] 5. Checkpoint — agent edits real media in Creative Claw
  - Wire one engine (image) end-to-end: agent gets a natural-language instruction → plans C++ ops → real result via the edit session, with the engine runtime kept warm. Confirm honesty (no-op reported) and stacking. Ask the user if questions arise.
  - _Not checked: requires compiled engine binaries (libomni_*_bridge) + models at review time; engine-gated tests exist and skip-with-reason when absent._

- [x] 6. Batch tools across all four engines
  - [x] 6.1 `src/tools/batch.ts` — register `<engine>.batch` backed by the existing batch/ runner for all four; Input_Set + Pipeline → per-item ItemResults + run manifest; preserve honesty (ok⇒real change, failures/skips with reasons, one failure never aborts, idempotent resume)
    - Model-heavy steps skip-with-reason when dep absent; coordinate VRAM via broker
    - _Requirements: 4.1, 4.2, 4.3, 4.4_
  - [x]* 6.2 Test: batch tool yields one ItemResult per input, ok⇒real change, one-failure-continues, idempotent re-run
    - **Property 5 — Validates: Requirements 4.1, 4.2**

- [x] 7. Node-graph creative surface
  - [x] 7.1 `src/graph/` — port the video-agent-ai PipelineExecutor/Graph to TS (typed ports, cycle detection, topo-sort); register `creative.graph.run`; nodes are real Engine_Ops routed through the same Engine_Runtime/catalog the op tools use; per-node status; failing/no-change node reported not faked
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_
  - [x]* 7.2 Test: a small graph of real Engine_Ops runs through the executor → real output + per-node status; shares the op catalog
    - **Property 6 — Validates: Requirements 5.1, 5.2, 5.3**

- [x] 8. Provider registration + GPU cooperation
  - [x] 8.1 `src/providers.ts` — NO media-generation provider is registered. **Correction (verified against the real DLLs):** these are deterministic C++ EDITING engines. The image/audio/video op catalogs contain 155 / 45 / 46 ops and NONE of them is `generate`; nothing maps a text prompt to media. The previously shipped `registerImageGenerationProvider` / `registerMusicGenerationProvider` / `registerVideoGenerationProvider` registrations called `engine.apply(req.prompt, "generate", …)` — a prompt passed as an input FILE PATH, for an op that does not exist — so every call failed with `unknown op 'generate'` while the host was told the capability existed. The id-only `registerMediaUnderstandingProvider({ id })` was equally empty: every analysis hook in the host contract (`src/media-understanding/types.ts`) is optional and `src/media-understanding/runner.ts` skips a provider that lacks the hook for the requested capability. All four registrations and the matching `openclaw.plugin.json` contract declarations were REMOVED rather than faked. Generation is NOT a capability of these engines. Editing/analysis is exposed via `registerTool` only (Req 2/3).
    - _Requirements: 6.1 (not exercised — no seam maps), 6.2, 6.3_
  - [x] 8.2 `src/gpu-coop.ts` — model-heavy ops claim/recalibrate/release VRAM via the broker and honor a user-claimed GPU; pure-C++ ops run with no claim
    - _Requirements: 8.1, 8.2, 8.3_
  - [x]* 8.3 Tests: `src/providers.test.ts` asserts the honest surface — `registerProviders` touches NO provider seam and leaves pre-existing providers (comfy) untouched, and the manifest declares no generation contracts; GPU cooperation (model-heavy claims, pure-C++ doesn't; honors user claim)
    - **Property 7 — Validates: Requirements 8.1, 8.2, 8.3**

- [x] 9. Operator surface
  - [x] 9.1 `src/surface.ts` — minimal Control UI descriptor + `api.registerCli("creative", ...)` to drive op/batch/session/graph from the operator side (studio reuse/rebuild deferred per OQ5)
    - _Requirements: 2.4_

- [ ] 10. End-to-end verification on Real_Media
  - [ ]* 10.1 Per-engine op smoke (engine-gated): apply a real Engine_Op to Real_Media → real content-changed output; skip-with-reason when a binary/dep is absent
    - **Property 2 — Validates: Requirements 2.5, 7.2, 9.1**
    - _Not checked: requires compiled engine binaries (libomni_*_bridge) + models at review time; engine-gated tests exist and skip-with-reason when absent._
  - [ ]* 10.2 Image NL→edit-session end-to-end (gated): instruction → planned C++ ops → real result inside Creative Claw
    - _Requirements: 9.2_
    - _Not checked: requires compiled engine binaries (libomni_*_bridge) + models at review time; engine-gated tests exist and skip-with-reason when absent._
  - [ ]* 10.3 Batch smoke (gated): a Pipeline across a small Input_Set → per-item results + manifest
    - _Requirements: 9.3_
    - _Not checked: requires compiled engine binaries (libomni_*_bridge) + models at review time; engine-gated tests exist and skip-with-reason when absent._
  - [ ]* 10.4 Node-graph smoke (gated): a small graph of real Engine_Ops → real output
    - _Requirements: 9.4_
    - _Not checked: requires compiled engine binaries (libomni_*_bridge) + models at review time; engine-gated tests exist and skip-with-reason when absent._

- [ ] 11. Final checkpoint
  - Run the suite: always-runnable (runtime reuse, tool registration, unknown-op error, batch shape, graph wiring, provider additivity) pass; engine/model/GPU-gated (per-engine op, image end-to-end, batch, node-graph, GPU coop) pass where binaries/models/GPU exist and skip-with-reason otherwise. Confirm long-lived runtimes (no per-session spawn), Cpp_First + Anti_Fake_Guard preserved, stacking + batch + node-graph all real, providers additive, GPU cooperation honored. Ask the user if questions arise.
  - _Not checked: requires compiled engine binaries (libomni_*_bridge) + models at review time; engine-gated tests exist and skip-with-reason when absent._

## Notes

- **Wiring, not re-implementation.** The engines/dispatchers/edit-session/batch/node-graph exist and are tested; tasks expose them through OpenClaw's plugin surface and preserve their guarantees.
- **No per-session spawn.** The Engine_Runtime is gateway-lifetime (Phase 1 kept-warm co-process; Phase 2 TS-FFI). The agent boundary carries op-names + file-paths + params, never bulk media.
- **Honesty/Cpp_First carry through.** Anti_Fake_Guard on edits, real-engine execution, honest engine_path reporting, model-dep skips-with-reason.
- **Depends on the gpu-broker spec** for Req 8; complements the visual-memory spec.
- **Tasks marked `*` are optional test sub-tasks**; core tasks are not.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1"] },
    { "id": 1, "tasks": ["2.2", "3.1"] },
    { "id": 2, "tasks": ["3.2", "4.1", "4.2"] },
    { "id": 3, "tasks": ["4.3", "5"] },
    { "id": 4, "tasks": ["6.1", "7.1", "8.1", "8.2"] },
    { "id": 5, "tasks": ["6.2", "7.2", "8.3", "9.1"] },
    { "id": 6, "tasks": ["10.1", "10.2", "10.3", "10.4"] },
    { "id": 7, "tasks": ["11"] }
  ]
}
```
