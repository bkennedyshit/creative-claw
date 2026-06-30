# Requirements Document

## Introduction

**Creative Claw** is a fork of **OpenClaw** into a local-first creative suite. This spec transplants the **visual memory** organ from **Polymathes** — its **Mneme** engine — into Creative Claw, **rewritten from Python to native TypeScript** so it runs in-process in the OpenClaw runtime with no Python sidecar and no MCP serialization boundary.

The capability Mneme provides, and that OpenClaw lacks: **media as first-class memory.** A content creator's "memory" isn't chat history — it's their video/photo catalog. Mneme indexes images/video/text into CLIP embeddings in a vector store, infers creator-aware metadata from each file's path (brand, category, intent, "don't re-edit my finished work"), and answers natural-language and reverse-image queries like *"find a clean product shot from the brand-a catalog, photo only, 2024+"* — entirely locally, joining vector hits back to structured metadata.

Why a **rewrite** rather than the sidecar the analysis floated: the maintainer's decision is a fully-native TS port. OpenClaw is TS; running Mneme as a Python child process re-introduces exactly the process/serialization boundary the suite is trying to avoid, and complicates packaging (a Python runtime + CUDA wheels alongside a Node app). The Mneme Python source is small and well-factored — `embedder.py` (CLIP + a deterministic hash fallback), `store.py` (SQLite + cosine), `indexer.py` (file-type routing + video frame sampling), `pathmeta.py` (path→metadata heuristics), `server.py` (the MCP tool surface), `native.py` (optional C++ binary bridge). Each maps cleanly to a TS module.

Grounded in the verified Mneme source (`mneme/src/mneme/`):
- **`embedder.py`** — `OpenClipEmbedder` (real CLIP text↔image shared space via open_clip_torch; `embed_text`/`embed_image`, L2-normalized) and `HashEmbedder` (deterministic, non-semantic, dependency-free fallback so the thing *boots* before models are installed). A factory `get_embedder(config)` selects by `backend` (`openclip|hash|native|auto`) and degrades gracefully with a stderr notice.
- **`store.py`** — SQLite `assets(id,path,type,timestamp,dim,embedding BLOB,metadata JSON)` with path/type indexes; `save_asset`, `has_path`, `delete_path`, `get_by_id`, `count`, and `search(query_vec, top_k, min_score, type_filter)` = plain cosine over float32 (skips mismatched-dim rows rather than crashing).
- **`indexer.py`** — walks a directory, routes by extension (IMAGE/VIDEO/AUDIO/TEXT/CODE sets), guards on file size + video duration, samples video frames at an interval (when OpenCV present, else one segment), builds metadata, saves. Returns `IndexStats(scanned/indexed/skipped/errored/by_type)`.
- **`pathmeta.py`** — `infer_brand` / `infer_workspace_root` / `classify_intent` / `build_metadata`: the *creator-aware* layer. `<root>/content/<brand>/reels/clip.mp4` → `brand`, `workspace=content`, `intent=reel`, `is_reel`, and crucially `warn_on_edit=true` for finished `content/` so the agent won't re-cut shipped work. Aspect-ratio fallback for intent.
- **`server.py`** — the tool surface to preserve: `media_index`, `media_search`, `media_search_by_image`, `media_describe` (+ the GPU tools, which belong to the separate gpu-broker spec). Result shape via `artifacts.py`.
- **`native.py`** — optional bridge: when a built `omni-search`/`media-memory` C++ binary (CUDA+TensorRT) is on PATH or configured, delegate `index`/`search` to it (CLI today) for TensorRT-FP16 speed; otherwise use the pure path. Same tool surface either way.

OpenClaw integration seams (from `INTEGRATION_ANALYSIS.md`, verified):
- Memory is an exclusive plugin slot (`kind:"memory"`, `src/plugins/slots.ts`); `extensions/memory-lancedb/` is the vector-store template (LanceDB + `MemoryEmbeddingProvider` + auto-capture/recall hooks). `registerMemoryCapability` / `registerMemoryEmbeddingProvider` in `src/plugins/api-builder.ts` / `memory-state.ts`.
- `sqlite-vec` is already an allowed dependency; `packages/memory-host-sdk/src/host/multimodal.ts` already classifies an `image` modality; inbound images flow through `src/media-understanding/`.
- **Key constraint:** only ONE `kind:"memory"` plugin is active. Visual memory must therefore EITHER claim the slot (replacing text memory) OR ride the additive `registerMemoryCorpusSupplement`/`registerMemoryPromptSupplement` companion path so it runs ALONGSIDE the existing text memory. The maintainer wants visual memory as an *addition*, so the additive/companion path (or a dedicated non-slot tool plugin) is the default — text memory stays intact.

This feature delivers `extensions/visual-memory/` (a code plugin): a TS CLIP embedder (with the hash fallback for boot-before-models), a TS SQLite vector store (using `sqlite-vec` or cosine-over-blob per the OpenClaw storage policy), the TS indexer + pathmeta, the four media tools registered natively, and an optional native-C++-binary fast-path. It must NOT claim the memory slot in a way that disables text memory; it adds visual recall.

The requirements below cover: the embedder (CLIP + hash fallback + native delegate); the vector store; the creator-aware indexer + path metadata; the four media tools; OpenClaw memory integration without disabling text memory; auto-capture of images the assistant sees/creates; honesty (no fake/empty results, semantic vs non-semantic clearly signaled); the native binary fast-path; and verification on real media.

## Glossary

- **Creative_Claw**: The OpenClaw fork (the creative suite). OpenClaw is the runtime spine.
- **Visual_Memory**: The ported Mneme capability — media indexed as embeddings + creator-aware metadata, queryable by text or image.
- **Embedder**: A component producing an L2-normalized float32 vector from text or an image. `embed_text(text)` and `embed_image(path)` share one space (CLIP).
- **CLIP_Embedder**: Real semantic embedder (text↔image shared space). The "good" tier; needs model weights.
- **Hash_Embedder**: Deterministic, non-semantic fallback so the system boots and is testable before CLIP weights are present. Cross-modal search does NOT work with it (by design).
- **Native_Delegate**: The optional compiled CUDA+TensorRT C++ binary (`omni-search`/`media-memory`); when present, index/search delegate to it for speed. Same tool surface.
- **Vector_Store**: The SQLite-backed store of `{path,type,timestamp,dim,embedding,metadata}` rows with cosine (or `sqlite-vec`) similarity search.
- **Indexer**: The directory walker that routes files by type, samples video frames, builds metadata, and writes Vector_Store rows.
- **Path_Metadata**: Creator-aware metadata inferred from a file's location (`brand`, `workspace`, `intent`, `is_reel`, `is_photo`, `warn_on_edit`, dimensions).
- **Warn_On_Edit**: A metadata flag set true for finished `content/` assets so the agent is warned off re-editing shipped work.
- **Media_Tool**: One of `media_index` / `media_search` / `media_search_by_image` / `media_describe`.
- **Memory_Slot**: OpenClaw's exclusive `kind:"memory"` plugin slot. Only one active.
- **Companion_Path**: The additive `registerMemoryCorpusSupplement`/`registerMemoryPromptSupplement` (or a non-slot tool plugin) by which Visual_Memory runs ALONGSIDE text memory without claiming the slot.
- **Real_Media**: Genuine images/videos used for verification, not synthetic-only buffers.

## Requirements

### Requirement 1: TypeScript Embedder with CLIP + hash fallback + native delegate

**User Story:** As the runtime, I want a TS embedder that runs the moment it's installed and gets good when CLIP weights are present, so visual memory boots without a Python dependency.

#### Acceptance Criteria

1. THE feature SHALL implement an Embedder interface in TypeScript with `embedText(text)` and `embedImage(path)` returning an L2-normalized float32 vector of a known `dim`, both in one shared space when CLIP is active.
2. THE feature SHALL implement a CLIP_Embedder (real text↔image semantic embeddings) running locally on the GPU when available and CPU otherwise, via a Node-accessible path (ONNX Runtime CLIP, transformers.js, or the Native_Delegate).
3. THE feature SHALL implement a Hash_Embedder (deterministic, dependency-free, non-semantic) so the system boots and the tool wiring is testable before CLIP weights exist; identical inputs SHALL map to identical vectors.
4. THE feature SHALL provide a factory that selects the backend (`clip|hash|native|auto`) from config and degrades gracefully (a single logged notice, not a crash) to Hash_Embedder when CLIP is unavailable under `auto`.
5. WHEN the Hash_Embedder is active, THE feature SHALL clearly signal that results are non-semantic (so a caller never mistakes a plumbing fallback for real visual search).

### Requirement 2: TypeScript SQLite vector store

**User Story:** As the runtime, I want media embeddings + metadata stored locally and searchable by similarity, with no Python.

#### Acceptance Criteria

1. THE Vector_Store SHALL persist rows of `{path, type, timestamp, dim, embedding(float32), metadata(json)}` in SQLite, with path/type indexes, following OpenClaw's SQLite storage policy (no JSON sidecars).
2. THE Vector_Store SHALL support `saveAsset`, `hasPath`, `deletePath`, `getById`, `count`, and `search(queryVec, topK, minScore, typeFilter?)`.
3. THE search SHALL compute cosine similarity over L2-normalized float32 vectors (or use `sqlite-vec`, already an allowed dependency), return results ordered by score desc limited to `topK`, and apply `minScore` and optional `typeFilter`.
4. WHEN a stored row's embedding `dim` differs from the query vector's `dim`, THE search SHALL skip that row rather than crash (mixed embedding spaces tolerated).
5. THE Vector_Store schema SHALL be conceptually interchangeable with the Polymathes/native `AssetRecord` so a DB produced by either path is usable by the other.

### Requirement 3: Creator-aware indexer and path metadata

**User Story:** As a creator, I want the agent to read my folder convention as metadata, so it knows a file's brand, what it's for, and not to touch my finished work.

#### Acceptance Criteria

1. THE Indexer SHALL walk a directory, route files by extension (image / video / text / code; audio recorded as discoverable), guard on max file size and max video duration, and return stats (`scanned/indexed/skipped/errored/by_type`).
2. WHEN indexing a video AND a frame-extraction capability is available, THE Indexer SHALL sample frames at a configurable interval and index each as a timestamped segment; WHEN unavailable, THE Indexer SHALL record the video as a single discoverable segment (never silently drop it).
3. THE Path_Metadata SHALL infer `brand` (segment after a known workspace root), `workspace` (content/input/output/archive), and `intent` (folder-hint first, aspect-ratio fallback) for each asset, matching the verified Polymathes heuristics.
4. THE Path_Metadata SHALL set `warn_on_edit=true` for assets under `content/` (finished, brand-owned work) so the agent is warned off re-editing shipped output.
5. WHEN re-indexing with `force`, THE Indexer SHALL delete prior rows for a path before re-adding; WITHOUT `force`, it SHALL skip already-indexed paths.
6. THE Indexer SHALL keep indexing the remaining files when one file errors (one failure never aborts the scan).

### Requirement 4: The four media tools, registered natively

**User Story:** As the agent, I want to index and search the user's media as native tools, so visual memory is a first-class capability, not an external server.

#### Acceptance Criteria

1. THE feature SHALL register `media_index` (index a directory; returns backend + stats + total count) via `api.registerTool`.
2. THE feature SHALL register `media_search` (natural-language semantic search; returns ranked results with path/type/score/metadata) via `api.registerTool`.
3. THE feature SHALL register `media_search_by_image` (reverse-image: embed an image, find visually similar indexed media) via `api.registerTool`.
4. THE feature SHALL register `media_describe` (fetch the full record for an asset id) via `api.registerTool`.
5. THE Media_Tools SHALL return the same result shape as the Polymathes/native surface (so a DB/UI built against either is compatible), and SHALL be available in Creative_Claw's default tool profile.

### Requirement 5: Integrate with OpenClaw memory WITHOUT disabling text memory

**User Story:** As the maintainer, I want visual memory ADDED to the assistant, while keeping the existing text memory working.

#### Acceptance Criteria

1. THE feature SHALL NOT claim the exclusive Memory_Slot in a way that disables the active text-memory plugin; it SHALL run via the Companion_Path (additive corpus/prompt supplement, or a dedicated non-slot tool plugin).
2. WHEN both text memory and Visual_Memory are active, THE agent SHALL be able to use both in one session (text recall AND media recall).
3. WHERE OpenClaw's image-embedding seam (`registerMemoryEmbeddingProvider`) can host the CLIP_Embedder, THE feature MAY register it there so the embedder is reusable; otherwise the embedder is internal to the plugin.
4. THE feature SHALL follow OpenClaw's untrusted-input handling: media metadata/captions ingested into Visual_Memory SHALL be sanitized so a prompt-injection payload embedded in a file cannot be later surfaced as an instruction.

### Requirement 6: Auto-capture media the assistant sees or creates

**User Story:** As a user, I want images I send and results the agent produces to be remembered visually, so I can recall them later by description or similarity.

#### Acceptance Criteria

1. WHEN an inbound image attachment is processed by the runtime (`src/media-understanding/`), THE feature SHALL be able to index it into Visual_Memory with its Path_Metadata (subject to config).
2. WHEN the creative engines produce an output image/video, THE feature SHALL be able to index that output so it becomes recallable.
3. THE auto-capture SHALL be configurable (on/off, which modalities, max file size) and SHALL default to a privacy-safe setting (no surprise indexing of everything).
4. WHEN auto-capture indexes an asset, IT SHALL apply the same sanitization (Req 5.4) and the same `warn_on_edit`/metadata rules as manual indexing.

### Requirement 7: Optional native CUDA+TensorRT fast-path

**User Story:** As a power user, when I've built the C++ media-memory binary, I want index/search to use its TensorRT speed, with the same tools.

#### Acceptance Criteria

1. WHEN a built Native_Delegate binary is configured or found on PATH (`omni-search`/`media-memory`), THE feature SHALL route `media_index`/`media_search`/`media_search_by_image` through it.
2. WHEN no Native_Delegate is present, THE feature SHALL use the pure-TS embedder + Vector_Store path with no change to the tool surface or result shape.
3. THE feature SHALL detect Native_Delegate availability at runtime and report which backend is active (`clip|hash|native`) in tool results, so the active path is honest.
4. WHERE the Native_Delegate fails at runtime, THE feature SHALL surface the error (or fall back to the pure path per config) rather than silently returning empty results.

### Requirement 8: Honesty — real results or honest absence, semantic clearly signaled

**User Story:** As a reviewer, I want visual memory to never fake a hit and to be explicit when it's running non-semantically.

#### Acceptance Criteria

1. WHEN a search has no matches above `minScore`, THE Media_Tool SHALL return an empty result set honestly (not a fabricated hit).
2. WHEN the active embedder is the Hash_Embedder, THE results SHALL be flagged non-semantic (Req 1.5) so a caller does not present a plumbing fallback as real visual search.
3. WHEN `media_search`/`media_search_by_image` runs with the CLIP_Embedder on Real_Media, results SHALL be genuinely content-derived (a visually similar image scores higher than an unrelated one).
4. THE active backend (`clip|hash|native`) and the indexed total SHALL be reported by `media_index`, so the system's true capability state is observable.

### Requirement 9: Verification on real media

**User Story:** As a reviewer, I want the rewrite proven against real images, not assumed.

#### Acceptance Criteria

1. THE feature SHALL include always-runnable tests (Hash_Embedder + Vector_Store + Indexer + Path_Metadata) that need no model weights: deterministic embeddings, cosine ranking, dim-mismatch skip, path→metadata heuristics, force/skip re-index, one-failure-continues.
2. THE feature SHALL include CLIP-gated tests (skip-with-reason when weights absent) asserting real semantic behavior on Real_Media: a text query retrieves the matching image above an unrelated one; reverse-image finds the near-duplicate.
3. THE feature SHALL include a Path_Metadata test asserting `warn_on_edit` is true for a `content/<brand>/reels/` file and the inferred `brand`/`intent` match the Polymathes heuristics.
4. WHEN a check needs the Native_Delegate or CLIP weights unavailable in the environment, IT SHALL skip-with-reason rather than fake a pass.

## Open Questions

1. **CLIP-in-Node path.** Which TS-accessible CLIP: ONNX Runtime (onnxruntime-node) with a CLIP ONNX export (reuses the image engine's ONNX tooling + GPU), transformers.js (pure JS, slower), or always delegate to the Native_Delegate when CLIP is wanted? Decide the default for the `clip` backend; `auto` falls back to hash.
2. **`sqlite-vec` vs cosine-over-blob.** Use `sqlite-vec` (allowed dep, faster at scale) or port the simple cosine-over-float32-blob from `store.py` (zero new dep, fine for the adoption tier)? Decide per expected library size.
3. **Slot vs companion.** Confirm the exact OpenClaw API for the Companion_Path (`registerMemoryCorpusSupplement`/`registerMemoryPromptSupplement` vs a standalone non-slot tool plugin) so text memory stays active alongside visual memory.
4. **Video frame extraction in Node.** ffmpeg (already on the machine, C:\ffmpeg\bin) vs an opencv-node binding for the frame sampling in the Indexer. ffmpeg-shell-out is the likely choice (matches the rest of the suite).
5. **Embedding reuse.** Should the CLIP_Embedder be registered via `registerMemoryEmbeddingProvider` so OpenClaw's text-memory can also use it, or kept internal to the visual-memory plugin? (Affects whether image embeddings are shareable.)
6. **DB location + interchange.** Where the SQLite DB lives (per-agent vs shared) and confirming the schema matches the native engine's `AssetRecord` closely enough that a native-built DB and a TS-built DB are mutually readable (Req 2.5).
