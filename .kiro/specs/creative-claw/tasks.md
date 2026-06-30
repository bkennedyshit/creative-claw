# Implementation Plan: Creative Claw (Master)

## Overview

This is the **umbrella plan** that assembles Creative Claw from the OpenClaw spine + the three integration specs, in dependency order, and locks the cross-cutting product decisions. It does NOT re-list the integrations' own tasks — each has its own `tasks.md`. This plan owns: the fork scaffolding, the build-order gates, the unified-agent composition checks, the shell decision record, packaging/provisioning, the product invariants, onboarding, and the suite-level end-to-end acceptance.

Sequence: scaffold the fork → build+verify `gpu-broker-integration` → build+verify `visual-memory-integration` → build+verify `creative-engines-integration` → compose + unified acceptance → packaging/onboarding → decision records. Each integration's own suite must pass before the next (Req 2.5). Language: TypeScript (`vitest`) for composition/acceptance; the integrations run their own stacks.

## Tasks

- [ ] 1. Fork scaffolding + delta tracking
  - [ ] 1.1 Establish Creative Claw as the OpenClaw fork: confirm `extensions/*` loads bundled plugins enabled-by-default (the `comfy` precedent) from a source checkout
    - _Requirements: 1.1, 1.5_
  - [ ] 1.2 Start the Fork_Delta_Doc: record every core OpenClaw touch-point the integrations require (e.g. the broker's agent-run-gate hook) so the delta from upstream is auditable
    - _Requirements: 1.4, 8.5_
  - [ ]* 1.3 Composition test: core OpenClaw function (agent loop, text memory, channels, media pipeline) still works on the fork before any transplant
    - _Requirements: 1.2_

- [ ] 2. Integration 1 — GPU broker (the foundation)
  - [ ] 2.1 Execute the `gpu-broker-integration` spec (its own tasks.md) to completion
    - _Requirements: 2.1, 2.2_
  - [ ] 2.2 Gate: confirm the broker independently evicts VRAM + gates agent runs BEFORE any GPU-heavy work exists; its own suite passes
    - _Requirements: 2.2, 2.5_

- [ ] 3. Integration 2 — Visual memory (alongside text memory)
  - [ ] 3.1 Execute the `visual-memory-integration` spec (its own tasks.md) to completion
    - _Requirements: 2.1, 2.3_
  - [ ] 3.2 Gate: confirm visual memory indexes/recalls media AND the existing text memory still occupies the slot (companion path); its own suite passes; broker is used for CLIP VRAM
    - _Requirements: 2.3, 2.5, 4.5_

- [ ] 4. Integration 3 — Creative engines (cooperating with the broker)
  - [ ] 4.1 Execute the `creative-engines-integration` spec (its own tasks.md) to completion
    - _Requirements: 2.1, 2.4_
  - [ ] 4.2 Gate: confirm the engines drive real C++ edits, cooperate with the already-working broker for GPU-heavy ops; its own suite passes
    - _Requirements: 2.4, 2.5_

- [ ] 5. Unified agent composition
  - [ ] 5.1 Verify all three plugins register into the one OpenClaw `api` and are reachable by the Unified_Agent in a single session (engine ops + batch + node-graph + edit session + media recall + gpu.*)
    - _Requirements: 1.3, 4.1_
  - [ ] 5.2 Verify creator-aware composition: an edit targeting a `content/` asset surfaces visual-memory's `warn_on_edit` before re-editing (memory + engines compose around the workspace convention)
    - _Requirements: 4.3_
  - [ ] 5.3 Verify GPU cooperation in the unified flow: a model-heavy edit coordinates VRAM via the broker and honors a user claim; text + visual memory both usable in-session
    - _Requirements: 4.2, 4.4, 4.5_
  - [ ]* 5.4 Composition tests: all three co-resident without conflict (P1); single-session capability (P3); creator-aware respect (P4)
    - **Properties 1,3,4 — Validates: Requirements 1.1, 1.3, 4.1, 4.3, 8.2**

- [ ] 6. Shell decision record (browser now, native-desktop later)
  - [ ] 6.1 Record the shell Decision_Record: ship on OpenClaw's browser Control UI now; native-desktop (Tauri) is a separate later track that preserves the agent/plugin architecture + tool surface; rationale = engines pass file paths, browser is not a correctness blocker
    - _Requirements: 3.1, 3.2, 3.3, 3.4_
  - [ ]* 6.2 Test: the full unified scenario runs on the browser shell with no native-desktop dependency (P7)
    - **Property 7 — Validates: Requirements 3.1, 3.5**

- [ ] 7. Packaging & provisioning
  - [ ] 7.1 Define + implement the Setup_Manifest + single setup path: provision spine + 3 plugins + artifacts (engine `.dll/.so`, Real-ESRGAN, ONNX/CLIP weights, optional native CUDA+TRT binary); gitignore large/platform artifacts, provision at setup
    - _Requirements: 5.1, 5.2, 5.5_
  - [ ] 7.2 Honest degradation when an artifact is absent: the capability reports unavailable/skip-with-reason; the rest of the suite runs; non-NVIDIA/CPU-only degrades, no hard crash
    - _Requirements: 5.3, 5.4_

- [ ] 8. Configuration & onboarding
  - [ ] 8.1 Unified_Config: merge OpenClaw config + the 3 plugins' configSchema (LLM provider/model, embedding/CLIP backend, broker thresholds, visual-memory DB + auto-capture, per-engine binary/model paths); support the creator-workspace convention
    - _Requirements: 7.1, 7.2_
  - [ ] 8.2 Degraded-but-honest boot that names exactly what's unavailable (no local model / no GPU / no engine binaries); a finite documented onboarding path to "the agent edited a real image on my machine"
    - _Requirements: 7.3, 7.4_

- [ ] 9. Product invariants enforced suite-wide
  - [ ] 9.1 Assert Honesty + Cpp_First + Local_First across the suite: Anti_Fake_Guard on edits, honest skip/fail, truthful engine/model/local-vs-API reporting; prefer honest degradation over fake/silent-cloud
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_
  - [ ]* 9.2 Tests: honest degradation suite-wide (P5); invariants observable — op reports engine/path + local-vs-API (P6)
    - **Properties 5,6 — Validates: Requirements 5.3, 6.1, 6.4, 6.5, 8.3**

- [ ] 10. Suite-level end-to-end acceptance
  - [ ]* 10.1 Unified end-to-end (env-gated): one session — recall a media asset by description (visual memory) → edit it on the real C++ engine (engines) → release the GPU for an external render + reclaim (broker) — all real + honestly reported; skip-with-reason when GPU/engine/model absent
    - **Property 3 — Validates: Requirements 8.1, 8.4**
  - [ ]* 10.2 Honest-degradation variant (env-gated): remove an artifact; the affected step skips-with-reason, the rest runs
    - **Property 5 — Validates: Requirements 8.3**
  - [ ] 10.3 Finalize the Fork_Delta_Doc: the added plugins + core touch-points, so the build is auditable and re-mergeable with upstream where feasible
    - _Requirements: 8.5_

- [ ] 11. Final checkpoint — Creative Claw works as one product
  - Confirm: one install yields the suite (3 plugins enabled-by-default); core OpenClaw preserved; the three integrations co-resident without conflict; the unified single-session scenario passes on real media (skips-with-reason when env-gated); honest degradation holds; invariants observable; the shell decision + fork delta documented. Ask the user if questions arise.

## Notes

- **Umbrella, not re-spec.** Tasks 2/3/4 each delegate to an integration's own tasks.md; this plan owns the gates + composition + product decisions only.
- **Dependency order is the spine of the plan:** broker → visual-memory → engines, because the latter two cooperate with the broker for VRAM. Each gate must pass before the next.
- **Browser shell ships first; native-desktop is a separate later track** that does not block the integrations (Task 6).
- **Honesty/Cpp_First/Local_First are product invariants** asserted suite-wide (Task 9), inherited by every integration.
- **Tasks marked `*` are optional test sub-tasks**; core tasks are not.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "2.1"] },
    { "id": 2, "tasks": ["2.2", "3.1"] },
    { "id": 3, "tasks": ["3.2", "4.1"] },
    { "id": 4, "tasks": ["4.2", "5.1", "5.2", "5.3"] },
    { "id": 5, "tasks": ["5.4", "6.1", "7.1", "8.1", "9.1"] },
    { "id": 6, "tasks": ["6.2", "7.2", "8.2", "9.2"] },
    { "id": 7, "tasks": ["10.1", "10.2", "10.3"] },
    { "id": 8, "tasks": ["11"] }
  ]
}
```
