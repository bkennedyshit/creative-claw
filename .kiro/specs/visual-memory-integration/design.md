# Visual Memory Integration — Design

## Overview

Rewrite Polymathes' **Mneme** visual-memory engine from Python to **native TypeScript** as the Creative Claw plugin `extensions/visual-memory/`. It runs in-process in the OpenClaw runtime — no Python child process, no MCP boundary. The Mneme source is small and cleanly factored, so the rewrite is a **module-for-module port**: each Python module maps to a TS module with the same contract, preserving the SQLite schema (so a native-built DB and a TS-built DB interoperate) and the four media tools' result shape.

Grounded in the verified Mneme source (`mneme/src/mneme/`) and OpenClaw seams (`INTEGRATION_ANALYSIS.md`):

| Mneme (Python) | Creative Claw (TS) | What it does |
|---|---|---|
| `embedder.py` (`OpenClipEmbedder`, `HashEmbedder`, `get_embedder`) | `src/embedder/` (`ClipEmbedder`, `HashEmbedder`, `getEmbedder`) | CLIP text↔image + deterministic fallback + factory |
| `store.py` (`Store`, `SearchResult`, cosine) | `src/store.ts` | SQLite vector store + cosine/`sqlite-vec` search |
| `indexer.py` (`Indexer`, `IndexStats`) | `src/indexer.ts` | dir walk, type routing, video frame sampling, save |
| `pathmeta.py` (`infer_brand`/`classify_intent`/`build_metadata`) | `src/pathmeta.ts` | creator-aware path→metadata |
| `server.py` (FastMCP tools) | `src/tools.ts` (`api.registerTool`) | the four media tools, native |
| `native.py` (binary bridge) | `src/native.ts` | optional CUDA+TRT C++ fast-path |
| `artifacts.py` (result shape) | `src/artifacts.ts` | preserve result JSON shape |

The single hard constraint: OpenClaw's memory slot is **exclusive** (one `kind:"memory"` plugin). Visual memory must **add** to text memory, not replace it — so it does NOT claim the slot. It ships as a **code plugin that registers the four media tools directly** (and, optionally, a `registerMemoryCorpusSupplement` so visual hits can flavor the prompt), leaving the existing text-memory plugin in the slot untouched.

> **`requirements.md` is the source of truth.** Open Questions resolved at the end.

## Architecture

```
   Creative Claw gateway (OpenClaw spine)
        │  inbound image attachments → src/media-understanding/
        │  creative-engine outputs → media store
        ▼
   ┌──────── extensions/visual-memory/ (NEW code plugin) ───────────────────────┐
   │ index.ts  definePluginEntry({ id:"visual-memory", register(api){...} })     │
   │   • api.registerTool ×4  → media_index / media_search /                     │
   │                            media_search_by_image / media_describe (Req 4)   │
   │   • api.registerMemoryCorpusSupplement (optional, Req 5.1 companion path)   │
   │   • api.registerHook(inbound-image / engine-output) → auto-capture (Req 6)  │
   │   • api.registerCli / ControlUi (browse the media index)                   │
   └───────────────┬───────────────────────────────────────────────────────────┘
                   ▼
   ┌─ getEmbedder(config) ─────────┐   ┌─ Store (SQLite) ──────────┐
   │ ClipEmbedder (semantic)       │   │ assets(path,type,ts,dim,  │
   │  ├─ ONNX CLIP (GPU) or         │   │  embedding,metadata)      │
   │  └─ Native_Delegate            │   │ search = cosine / sqlite-vec│
   │ HashEmbedder (boot fallback)  │   └───────────────────────────┘
   └───────────────┬───────────────┘             ▲
                   ▼                              │ rows
   ┌─ Indexer ─────────────────────────────────┐ │
   │ walk → type route → (video: ffmpeg frames) │─┘
   │ → pathmeta.buildMetadata → store.saveAsset │
   └───────────────┬────────────────────────────┘
                   ▼ (optional fast-path)
   ┌─ native.ts ── omni-search / media-memory (CUDA+TensorRT C++ binary) ────────┐
   │ when present: index/search delegate to the binary; same tool surface        │
   └────────────────────────────────────────────────────────────────────────────┘
```

## Components and Interfaces

### Component 1: Embedder (`src/embedder/`)

```ts
export interface Embedder { readonly name: "clip" | "hash" | "native"; readonly dim: number; readonly semantic: boolean;
  embedText(text: string): Promise<Float32Array>;
  embedImage(path: string): Promise<Float32Array>; }
```
- **`HashEmbedder`** (port of `HashEmbedder`): deterministic char-trigram bag for text, byte-hash for images, L2-normalized. `semantic=false`. Zero deps — boots immediately, makes the wiring testable (Req 1.3, 1.5).
- **`ClipEmbedder`** (port of `OpenClipEmbedder`): real text↔image shared space. TS path via **onnxruntime-node + a CLIP ONNX export** (reuses the image engine's ONNX/GPU tooling; OQ1), CUDA→CPU fallback. `semantic=true`.
- **`getEmbedder(config)`** (port of `get_embedder`): selects `clip|hash|native|auto`; under `auto`, uses CLIP if its model/runtime is available else logs one notice and returns `HashEmbedder` (Req 1.4). `native` defers to `src/native.ts`.

### Component 2: Vector store (`src/store.ts`)

Port `Store` verbatim in contract: SQLite `assets(id,path,type,timestamp,dim,embedding BLOB,metadata TEXT)` + path/type indexes (Req 2.1, 2.5 — identical schema to the native `AssetRecord`). Methods `saveAsset/hasPath/deletePath/getById/count/search`. Search = cosine over L2-normalized float32 with `topK`/`minScore`/`typeFilter`, skipping dim-mismatched rows (Req 2.2–2.4). Implementation choice (OQ2): `sqlite-vec` (allowed dep, scales) vs the simple cosine-over-blob from `store.py` (zero new dep). Use OpenClaw's SQLite layer; no JSON sidecars.

### Component 3: Indexer + path metadata (`src/indexer.ts`, `src/pathmeta.ts`)

- **`pathmeta.ts`** — exact port of `infer_brand`/`infer_workspace_root`/`classify_intent`/`build_metadata`: workspace roots `{content,input,output,archive}`, folder-hint intent table, aspect-ratio fallback, and **`warn_on_edit=true` for `content/`** (Req 3.3, 3.4). Cross-platform path normalization (already in the source).
- **`indexer.ts`** — port of `Indexer.scan_directory`/`_process_file`: extension routing (IMAGE/VIDEO/TEXT/CODE; audio discoverable), size + video-duration guards, `IndexStats`. Video frame sampling via **ffmpeg shell-out** (already on the machine, matches the suite — OQ4) at a configurable interval, each frame → timestamped segment; no-ffmpeg → one segment, never dropped (Req 3.2). `force` deletes prior rows then re-adds; else skip already-indexed (Req 3.5). One file error never aborts the walk (Req 3.6).

### Component 4: Media tools (`src/tools.ts`)

Register the four tools via `api.registerTool`, preserving the Mneme/native names, args, and result shape (`src/artifacts.ts` ports `artifacts.py`): `media_index`, `media_search`, `media_search_by_image`, `media_describe` (Req 4). Default tool profile. Each result reports the active backend (`clip|hash|native`) and `media_index` reports the indexed total (Req 8.4). The GPU tools from `server.py` are NOT here — they belong to the gpu-broker spec.

### Component 5: OpenClaw memory integration (companion, not slot) (`index.ts`)

Do NOT set `kind:"memory"` (that would claim the exclusive slot and disable text memory, Req 5.1). Instead: a plain code plugin that registers the media tools, and optionally `api.registerMemoryCorpusSupplement`/`registerMemoryPromptSupplement` (OQ3) so a relevant visual hit can be surfaced into the prompt alongside text memory (Req 5.2). Optionally register `ClipEmbedder` via `api.registerMemoryEmbeddingProvider` so it's reusable by text memory (OQ5, Req 5.3). All ingested metadata/captions sanitized against prompt-injection per OpenClaw's untrusted-input rules (Req 5.4).

### Component 6: Auto-capture (`src/capture.ts`)

Hook inbound image attachments (`src/media-understanding/attachments.normalize.ts`) and creative-engine outputs (the media store) to index them into Visual_Memory with Path_Metadata (Req 6.1, 6.2). Config-gated, privacy-safe default OFF-or-scoped (Req 6.3); same sanitization + metadata rules as manual indexing (Req 6.4).

### Component 7: Native delegate (`src/native.ts`)

Port `native.py`: resolve `omni-search`/`media-memory` from config or PATH; when present, route `media_index`/`media_search`/`media_search_by_image` to its CLI (Req 7.1); else pure-TS path, same surface (Req 7.2). Report active backend (Req 7.3). On native failure, surface the error or fall back per config — never silent-empty (Req 7.4).

## Data Models

- **Asset row** (`store.ts`, == native `AssetRecord`): `{ id, path, type, timestamp, dim, embedding: Float32Array(blob), metadata: json }`.
- **SearchResult**: `{ id, path, type, timestamp, score, metadata }`.
- **Path_Metadata** (`pathmeta.ts`): `{ brand?, workspace?, intent, is_reel, is_photo, warn_on_edit, width?, height?, ...extra }`.
- **IndexStats**: `{ scanned, indexed, skipped, errored, by_type }`.
- **Tool result** (`artifacts.ts`): the Mneme/native JSON shape — `{ ok, query?, backend, results: [SearchResult...] }` / index `{ path, backend, total_indexed, ...stats }`.
- **Config**: `{ backend: "clip"|"hash"|"native"|"auto", clipModel, clipOnnxPath?, dbPath, minScore, frameInterval, maxFileMb, maxVideoSeconds, nativeBin?, autoCapture: {enabled, modalities, maxFileBytes} }`.

## Correctness Properties

### Property 1: Deterministic hash embeddings
`HashEmbedder.embedText`/`embedImage` return identical vectors for identical inputs and are L2-normalized; near-identical text stays near in the space.
**Validates: Requirements 1.3**

### Property 2: Cosine ranking + dim-mismatch skip
`store.search` ranks higher-cosine rows first, honors `topK`/`minScore`/`typeFilter`, and skips rows whose `dim` ≠ query dim without crashing.
**Validates: Requirements 2.2, 2.3, 2.4**

### Property 3: Path metadata heuristics
`buildMetadata("<root>/content/<brand>/reels/x.mp4")` → `brand=<brand>`, `workspace=content`, `intent=reel`, `is_reel=true`, `warn_on_edit=true`; matches the Polymathes heuristics.
**Validates: Requirements 3.3, 3.4**

### Property 4: Indexer resilience + force/skip
A directory with one unreadable file still indexes the rest; `force` re-indexes a path (delete+add), without `force` an already-indexed path is skipped.
**Validates: Requirements 3.5, 3.6**

### Property 5: Semantic recall on real media (CLIP)
With `ClipEmbedder`, a text query retrieves the matching image above an unrelated one, and reverse-image finds the near-duplicate (content-derived, not random).
**Validates: Requirements 8.3, 9.2**

### Property 6: Honest backend signaling
Tool results report the active backend; Hash_Embedder results are flagged non-semantic; an empty search returns an honest empty set, never a fabricated hit.
**Validates: Requirements 1.5, 8.1, 8.2, 8.4**

### Property 7: Companion memory (text memory preserved)
With visual-memory loaded, the active text-memory plugin still occupies the memory slot and functions; both are usable in one session.
**Validates: Requirements 5.1, 5.2**

> Non-property checks: the four tools registered + default profile (Req 4.5); native delegate detection + fallback (Req 7); auto-capture config gating + sanitization (Req 6); schema interchange with native DB (Req 2.5).

## Error Handling

| Scenario | Behavior |
|---|---|
| CLIP weights/runtime absent under `auto` | One logged notice; fall back to Hash_Embedder; results flagged non-semantic (Req 1.4, 1.5). |
| `backend=clip` but CLIP unavailable | Explicit error (don't silently downgrade) — mirrors the source. |
| Query dim ≠ stored dim | Skip the row (Req 2.4). |
| Unreadable file during index | Count `errored`, continue the walk (Req 3.6). |
| Video, no ffmpeg | Record one discoverable segment, don't drop (Req 3.2). |
| Search below `minScore` | Honest empty result set (Req 8.1). |
| Native delegate fails | Surface error or fall back per config; never silent-empty (Req 7.4). |
| Visual-memory would claim the slot | Forbidden — companion path only; text memory stays active (Req 5.1). |
| Prompt-injection in media metadata | Sanitized before storage/recall (Req 5.4). |

## Testing Strategy

Two tiers:
- **Always-runnable (no weights/native):** Hash_Embedder determinism, Store cosine + dim-skip, Indexer routing + force/skip + one-failure-continues, pathmeta heuristics (incl. `warn_on_edit`), tool registration + backend signaling, companion-path (text memory not displaced). Properties 1–4, 6, 7.
- **CLIP/native-gated (skip-with-reason when absent):** semantic recall on Real_Media (Property 5), reverse-image near-duplicate, native-delegate routing. Never a fake pass — skip with a recorded reason.

Language: TypeScript (`vitest`). Real images for the gated tier (a couple of license-clean photos in the plugin's test fixtures). ffmpeg (C:\ffmpeg\bin) for the video-frame test.

## Open Questions — resolved as design decisions

1. **CLIP-in-Node:** Default the `clip` backend to **onnxruntime-node + a CLIP ONNX model** (reuses the image engine's proven ONNX+CUDA tooling, GPU-accelerated), with the Native_Delegate as the power-tier and Hash as the `auto` fallback. transformers.js only if onnxruntime-node proves painful.
2. **Store impl:** Start with **`sqlite-vec`** (already an allowed dep, scales to a real library); keep the cosine-over-blob port as the reference/fallback. Both satisfy the schema-interchange requirement.
3. **Slot vs companion:** **Companion path** — register the media tools as a normal code plugin (no `kind:"memory"`), plus `registerMemoryCorpusSupplement` for prompt flavoring. Confirm the exact supplement API name in early implementation; do NOT claim the slot.
4. **Video frames:** **ffmpeg shell-out** (already on the machine, matches the rest of the suite) for frame sampling; no opencv-node binding.
5. **Embedding reuse:** Register `ClipEmbedder` via `registerMemoryEmbeddingProvider` so text memory can reuse it, IF the contract accepts image inputs cleanly; otherwise keep it internal. Decide when wiring Component 5.
6. **DB location:** Per-agent SQLite under the agent's data dir by default, with a configurable shared path; schema kept byte-compatible with the native `AssetRecord` (Req 2.5).

## Honesty Ledger

**Real once implemented:** CLIP search returns genuinely content-similar media (Property 5); the hash fallback is clearly flagged non-semantic; empty searches return empty (no fabricated hits); the active backend is always reported; text memory keeps working alongside visual memory; the SQLite schema interoperates with the native engine's.

**Needs validation during implementation:** the onnxruntime-node CLIP path (model export, GPU) (OQ1); the exact companion-supplement API (OQ3); whether `registerMemoryEmbeddingProvider` accepts image inputs (OQ5); ffmpeg frame-sampling parity with the Python OpenCV path.

**Out of scope:** rewriting/relinking the C++ TensorRT engine (it's an optional delegate, used as-is); the GPU broker (separate spec); the creative-engine op integration (separate spec); building a full media-browser UI (a basic browse surface only).
