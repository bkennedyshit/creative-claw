# Implementation Plan: Visual Memory Integration

## Overview

Rewrite Mneme from Python to native TS as `extensions/visual-memory/`. Order: port the dependency-free pieces first (HashEmbedder, Store, pathmeta) so the whole thing boots and is testable with zero models, then the Indexer, then the four media tools + OpenClaw companion wiring, then the real CLIP backend, then auto-capture and the optional native delegate, and lock it with always-runnable + CLIP-gated tests on real media. Module-for-module port — preserve the SQLite schema and tool result shape so a native-built DB/UI stays compatible.

Language: TypeScript (`vitest`), in-process in OpenClaw (no Python, no MCP boundary). Reference source: Polymathes `mneme/src/mneme/{embedder,store,indexer,pathmeta,server,native,artifacts}.py`. Reference seams: OpenClaw `src/plugins/api-builder.ts`, `extensions/memory-lancedb/` (vector-store plugin template), `src/media-understanding/` (inbound images), `sqlite-vec` (allowed dep). Tests split always-runnable (hash/store/indexer/pathmeta) vs CLIP/native-gated (skip-with-reason when absent).

## Tasks

- [ ] 1. Scaffold the plugin + config
  - [ ] 1.1 Create `extensions/visual-memory/` with `openclaw.plugin.json` (code plugin, NOT `kind:"memory"`) + `index.ts` (`definePluginEntry`) + `configSchema`
    - Config keys: backend (clip|hash|native|auto), clipModel/clipOnnxPath, dbPath, minScore, frameInterval, maxFileMb, maxVideoSeconds, nativeBin, autoCapture{enabled,modalities,maxFileBytes}
    - _Requirements: 5.1_

- [ ] 2. Port the dependency-free core (boots with zero models)
  - [ ] 2.1 `src/embedder/hash.ts` — port `HashEmbedder` (deterministic char-trigram text + byte-hash image, L2-normalized, `semantic=false`)
    - _Requirements: 1.1, 1.3, 1.5_
  - [ ] 2.2 `src/store.ts` — port `Store` (SQLite schema == native AssetRecord; saveAsset/hasPath/deletePath/getById/count/search; cosine over float32 or sqlite-vec; dim-mismatch skip)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_
  - [ ] 2.3 `src/pathmeta.ts` — port infer_brand/infer_workspace_root/classify_intent/build_metadata (workspace roots, folder-hint intent, aspect fallback, warn_on_edit for content/)
    - _Requirements: 3.3, 3.4_
  - [ ]* 2.4 Always-runnable tests: hash determinism (P1), store cosine ranking + dim-skip (P2), pathmeta heuristics incl. warn_on_edit (P3)
    - **Properties 1,2,3 — Validates: Requirements 1.3, 2.2, 2.3, 2.4, 3.3, 3.4**

- [ ] 3. Port the indexer
  - [ ] 3.1 `src/indexer.ts` — port Indexer: extension routing, size/duration guards, IndexStats, force/skip, one-failure-continues; video frame sampling via ffmpeg shell-out (one segment when ffmpeg absent, never dropped)
    - _Requirements: 3.1, 3.2, 3.5, 3.6_
  - [ ]* 3.2 Tests: indexer routing + force/skip + one-failure-continues (P4); video → segment(s)
    - **Property 4 — Validates: Requirements 3.5, 3.6**

- [ ] 4. The four media tools + companion memory wiring
  - [ ] 4.1 `src/artifacts.ts` + `src/tools.ts` — register media_index/media_search/media_search_by_image/media_describe via api.registerTool, preserving Mneme/native result shape; report active backend + indexed total; default tool profile
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 8.4_
  - [ ] 4.2 Companion memory wiring in index.ts — register tools as a plain code plugin (NOT the memory slot); optionally registerMemoryCorpusSupplement so visual hits flavor the prompt; sanitize ingested metadata/captions (untrusted-input)
    - _Requirements: 5.1, 5.2, 5.4_
  - [ ]* 4.3 Tests: tools registered + backend signaling + honest empty result (P6); companion path leaves text memory in the slot (P7)
    - **Properties 6,7 — Validates: Requirements 5.1, 5.2, 8.1, 8.2, 8.4**

- [ ] 5. Checkpoint — visual memory boots and indexes/searches on the hash backend
  - Build the plugin; index a small real folder with the hash backend; confirm media_index reports stats+backend, media_search returns honest (non-semantic-flagged) results, media_describe fetches a record, and the existing text-memory plugin still occupies the slot. Ask the user if questions arise.

- [ ] 6. Real CLIP backend
  - [ ] 6.1 `src/embedder/clip.ts` — ClipEmbedder via onnxruntime-node + a CLIP ONNX model (GPU→CPU fallback), shared text↔image space, L2-normalized, `semantic=true`
    - _Requirements: 1.2_
  - [ ] 6.2 `src/embedder/index.ts` — getEmbedder factory (clip|hash|native|auto); auto falls back to hash with one logged notice; backend=clip errors if unavailable
    - _Requirements: 1.4, 1.5_
  - [ ] 6.3 Optionally register ClipEmbedder via registerMemoryEmbeddingProvider so text memory can reuse it (OQ5)
    - _Requirements: 5.3_
  - [ ]* 6.4 CLIP-gated tests (skip-with-reason): text query retrieves matching image over unrelated; reverse-image finds near-duplicate
    - **Property 5 — Validates: Requirements 8.3, 9.2**

- [ ] 7. Auto-capture
  - [ ] 7.1 `src/capture.ts` — hook inbound image attachments (src/media-understanding) and creative-engine outputs → index into Visual_Memory with pathmeta; config-gated, privacy-safe default; same sanitization + metadata rules
    - _Requirements: 6.1, 6.2, 6.3, 6.4_
  - [ ]* 7.2 Test: an inbound image gets indexed (config on) with correct metadata; default-off respected
    - _Requirements: 6.1, 6.3_

- [ ] 8. Optional native CUDA+TensorRT fast-path
  - [ ] 8.1 `src/native.ts` — port native.py: resolve omni-search/media-memory (config/PATH); route index/search to it when present; report backend=native; surface error or fall back per config (never silent-empty); pure-TS path unchanged when absent
    - _Requirements: 7.1, 7.2, 7.3, 7.4_
  - [ ]* 8.2 Test: with no native binary, backend is clip/hash and tools work unchanged; (native-present path skip-with-reason when the binary is absent)
    - _Requirements: 7.2_

- [ ] 9. Operator surface + verification fixtures
  - [ ] 9.1 api.registerCli("media", ...) and/or a Control UI to browse the index (index/search/describe from the operator side, live store state)
    - _Requirements: 4.5_
  - [ ]* 9.2 Test fixtures: a couple of license-clean real photos + a short clip under the plugin's test dir for the CLIP-gated + video tests
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [ ] 10. Final checkpoint
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
