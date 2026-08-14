# Implementation Plan: Visual Memory Integration

## Overview

Rewrite Mneme from Python to native TS as `extensions/visual-memory/`. Order: port the dependency-free pieces first (HashEmbedder, Store, pathmeta) so the whole thing boots and is testable with zero models, then the Indexer, then the four media tools + OpenClaw companion wiring, then the real CLIP backend, then auto-capture and the optional native delegate, and lock it with always-runnable + CLIP-gated tests on real media. Module-for-module port — preserve the SQLite schema and tool result shape so a native-built DB/UI stays compatible.

Language: TypeScript (`vitest`), in-process in OpenClaw (no Python, no MCP boundary). Reference source: Polymathes `mneme/src/mneme/{embedder,store,indexer,pathmeta,server,native,artifacts}.py`. Reference seams: OpenClaw `src/plugins/api-builder.ts`, `extensions/memory-lancedb/` (vector-store plugin template), `src/media-understanding/` (inbound images), `sqlite-vec` (allowed dep). Tests split always-runnable (hash/store/indexer/pathmeta) vs CLIP/native-gated (skip-with-reason when absent).

## Tasks

- [x] 1. Scaffold the plugin + config
  - [x] 1.1 Create `extensions/visual-memory/` with `openclaw.plugin.json` (code plugin, NOT `kind:"memory"`) + `index.ts` (`definePluginEntry`) + `configSchema`
    - Config keys as shipped: `embedder` (`hash` only), `protectContent`, `storePath`. The planned `clipModel`/`clipOnnxPath`/`autoCapture{…}` keys were removed — see 6.1/7.1 and HONESTY_FIXES.md. `minScore`/`frameInterval`/`maxFileMb`/`maxVideoSeconds`/`nativeBin` are not exposed in the schema (hard-coded or auto-detected).
    - _Requirements: 5.1_

- [ ] 2. Port the dependency-free core (boots with zero models)
  - [x] 2.1 `src/embedder/hash.ts` — port `HashEmbedder` (deterministic char-trigram text + byte-hash image, L2-normalized, `semantic=false`)
    - _Requirements: 1.1, 1.3, 1.5_
  - [x] 2.2 `src/store.ts` — port `Store` (SQLite schema == native AssetRecord; saveAsset/hasPath/deletePath/getById/count/search; cosine over float32 or sqlite-vec; dim-mismatch skip)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_
  - [x] 2.3 `src/pathmeta.ts` — port infer_brand/infer_workspace_root/classify_intent/build_metadata (workspace roots, folder-hint intent, aspect fallback, warn_on_edit for content/)
    - _`warn_on_edit` is now ENFORCED, not just recorded: `src/edit-guard.ts` registers the `visual-memory-protected-content` trusted tool policy, which refuses `write`/`edit`/`apply_patch` on flagged paths (config `protectContent`, default on). See HONESTY_FIXES.md Task 2._
    - _Requirements: 3.3, 3.4_
  - [ ]* 2.4 Always-runnable tests: hash determinism (P1), store cosine ranking + dim-skip (P2), pathmeta heuristics incl. warn_on_edit (P3)
    - _Status: store cosine/dim-skip (`store.test.ts`) and pathmeta heuristics (`pathmeta.test.ts`) done; hash-determinism (P1) test still pending._
    - **Properties 1,2,3 — Validates: Requirements 1.3, 2.2, 2.3, 2.4, 3.3, 3.4**

- [ ] 3. Port the indexer
  - [x] 3.1 `src/indexer.ts` — port Indexer: extension routing, size/duration guards, IndexStats, force/skip, one-failure-continues; video frame sampling via ffmpeg shell-out (one segment when ffmpeg absent, never dropped)
    - _Requirements: 3.1, 3.2, 3.5, 3.6_
  - [ ]* 3.2 Tests: indexer routing + force/skip + one-failure-continues (P4); video → segment(s)
    - _Status: indexer implementation complete; dedicated `indexer.test.ts` still pending._
    - **Property 4 — Validates: Requirements 3.5, 3.6**

- [ ] 4. The four media tools + companion memory wiring
  - [x] 4.1 `src/artifacts.ts` + `src/tools.ts` — register media_index/media_search/media_search_by_image/media_describe via api.registerTool, preserving Mneme/native result shape; report active backend + indexed total; default tool profile
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 8.4_
  - [x] 4.2 Companion memory wiring in index.ts — register tools as a plain code plugin (NOT the memory slot); optionally registerMemoryCorpusSupplement so visual hits flavor the prompt; sanitize ingested metadata/captions (untrusted-input)
    - _Requirements: 5.1, 5.2, 5.4_
  - [ ]* 4.3 Tests: tools registered + backend signaling + honest empty result (P6); companion path leaves text memory in the slot (P7)
    - _Status: tools + companion wiring complete; dedicated `tools.test.ts` still pending._
    - **Properties 6,7 — Validates: Requirements 5.1, 5.2, 8.1, 8.2, 8.4**

- [x] 5. Checkpoint — visual memory boots and indexes/searches on the hash backend
  - Build the plugin; index a small real folder with the hash backend; confirm media_index reports stats+backend, media_search returns honest (non-semantic-flagged) results, media_describe fetches a record, and the existing text-memory plugin still occupies the slot. Ask the user if questions arise.

- [ ] 6. Real CLIP backend
  - [ ] 6.1 `src/embedder/clip.ts` — ClipEmbedder via onnxruntime-node + a CLIP ONNX model (GPU→CPU fallback), shared text↔image space, L2-normalized, `semantic=true`
    - _REOPENED: this was never implemented. `clip.ts` declared `semantic = true` unconditionally while `runTextEncoder`/`runImageEncoder` both threw "not yet implemented" and all four callers swallowed the throw into the hash fallback; `onnxruntime-node` was never installed. The file has been DELETED rather than left as a lying stub — see HONESTY_FIXES.md Task 1. Re-scope before restarting: real work is tokenizer + image preprocessing + two ONNX sessions + weights provisioning._
    - _Requirements: 1.2_
  - [ ] 6.2 `src/embedder/index.ts` — embedder factory; unsupported backend must be reported, never silently swapped
    - _PARTIALLY DONE / RESCOPED: `getEmbedder` is now `resolveEmbedder`, returning `{ embedder, report }` with `SUPPORTED_EMBEDDER_BACKENDS = ["hash"]`. An unsupported/stale backend (e.g. `clip`) resolves to hash and returns `degraded: true` with a reason, logged once at startup and echoed in every `media_search`/`media_search_by_image`/`media_index` result. The `clip|native|auto` selector values are NOT implemented (`native` is chosen per-call by `native.ts`, not by this factory)._
    - _Requirements: 1.4, 1.5_
  - [ ] 6.3 Optionally register a semantic embedder via registerMemoryEmbeddingProvider so text memory can reuse it (OQ5)
    - _REOPENED: the provider is registered, but it exposes the hash embedder and now advertises the backend that ACTUALLY ran. There is no semantic embedder to share until 6.1 lands._
    - _Requirements: 5.3_
  - [ ]* 6.4 CLIP-gated tests (skip-with-reason): text query retrieves matching image over unrelated; reverse-image finds near-duplicate
    - _Note: requires CLIP ONNX weights at review time; tests exist and skip-with-reason when absent._
    - **Property 5 — Validates: Requirements 8.3, 9.2**

- [ ] 7. Auto-capture — BLOCKED ON A HOST SEAM THAT DOES NOT EXIST
  - [ ] 7.1 `src/capture.ts` — hook inbound image attachments and creative-engine outputs → index into Visual_Memory with pathmeta; config-gated, privacy-safe default
    - _REOPENED AND DELETED: the hooks were registered on `message:inbound` and `media:generated`, neither of which the host dispatches, with an invented `attachments` payload. `MessageReceivedHookContext` has no attachment field, and the only typed hook carrying attachments (`before_model_resolve`) exposes `{ kind, mimeType }` with no bytes or path. `src/capture.ts`, the hooks, and the `autoCapture` config/manifest entries were all removed — see HONESTY_FIXES.md Task 3. This task cannot proceed until the host adds an inbound-attachment or generated-media seam; use `media_index` explicitly in the meantime._
    - _Requirements: 6.1, 6.2, 6.3, 6.4_
  - [ ]* 7.2 Test: an inbound image gets indexed (config on) with correct metadata; default-off respected
    - _Blocked by 7.1: there is nothing to test until a real seam exists._
    - _Requirements: 6.1, 6.3_

- [ ] 8. Optional native CUDA+TensorRT fast-path
  - [x] 8.1 `src/native.ts` — port native.py: resolve omni-search/media-memory (config/PATH); route index/search to it when present; report backend=native; surface error or fall back per config (never silent-empty); pure-TS path unchanged when absent
    - _Requirements: 7.1, 7.2, 7.3, 7.4_
  - [ ]* 8.2 Test: with no native binary, backend is clip/hash and tools work unchanged; (native-present path skip-with-reason when the binary is absent)
    - _Status: native delegate implementation complete; dedicated `native.test.ts` still pending._
    - _Requirements: 7.2_

- [ ] 9. Operator surface + verification fixtures
  - [x] 9.1 api.registerCli("media", ...) and/or a Control UI to browse the index (index/search/describe from the operator side, live store state)
    - _Done: `src/surface.ts` registers `openclaw media {index,search,describe}` + optional `visual-memory-browser` Control UI; guarded typeof no-ops; covered by `src/surface.test.ts`._
    - _Requirements: 4.5_
  - [ ]* 9.2 Test fixtures: a couple of license-clean real photos + a short clip under the plugin's test dir for the CLIP-gated + video tests
    - _Note: requires CLIP ONNX weights at review time; tests exist and skip-with-reason when absent._
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [ ] 10. Final checkpoint
  - _Note: requires CLIP ONNX weights at review time; tests exist and skip-with-reason when absent._
  - Run the suite: always-runnable (hash/store/indexer/pathmeta/tools/companion) pass; CLIP-gated (semantic recall, reverse-image) pass where weights exist and skip-with-reason otherwise; native path skips-with-reason when the binary is absent. Confirm text memory still works alongside, the schema interoperates with the native AssetRecord, and the active backend is honestly reported. Ask the user if questions arise.

## Notes

- **Module-for-module port.** Each task ports one Mneme module to TS, preserving schema + result shape so a native-built DB/UI stays compatible.
- **Boots before models.** The hash backend (task 2) makes the whole plugin runnable + testable with zero weights; CLIP (task 6) is the quality tier.
- **Companion, not slot.** Visual memory ADDS to text memory (task 4.2) — it must never claim the exclusive memory slot.
- **Anti-fake gate:** empty searches return empty; hash results flagged non-semantic; active backend always reported (Property 6).
- **Tasks marked `*` are optional test sub-tasks**; core tasks are not.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "2.2", "2.3"] },
    { "id": 1, "tasks": ["2.4", "3.1"] },
    { "id": 2, "tasks": ["3.2", "4.1", "4.2"] },
    { "id": 3, "tasks": ["4.3", "5"] },
    { "id": 4, "tasks": ["6.1", "6.2", "6.3"] },
    { "id": 5, "tasks": ["6.4", "7.1", "8.1", "9.1"] },
    { "id": 6, "tasks": ["7.2", "8.2", "9.2"] },
    { "id": 7, "tasks": ["10"] }
  ]
}
```
