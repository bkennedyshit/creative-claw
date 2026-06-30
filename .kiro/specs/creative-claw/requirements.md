# Requirements Document

## Introduction

**Creative Claw** is a local-first **agentic creative suite**: one application where a creator talks to an AI that drives real media edits across image, audio, video, and vector — on the creator's own GPU, with the creator's own catalog as memory, sharing that GPU cooperatively with the creator's other tools. It is built by **forking OpenClaw** (the lean, plugin-based personal-assistant runtime — the **spine**) and transplanting in three things: **(1)** Polymathes' **GPU/VRAM broker**, **(2)** Polymathes' **visual memory** (Mneme, rewritten Python→TypeScript), and **(3)** the maintainer's four compiled-**C++ creative engines** with their **batch**, **node-graph**, and **agentic-edit** surfaces.

This is the **master / umbrella spec.** It does not re-specify the three integrations — each already has its own spec in this repo:
- `gpu-broker-integration` — cooperative single-GPU VRAM arbitration + Ollama eviction as a native TS plugin.
- `visual-memory-integration` — Mneme rewritten to native TS (CLIP embeddings, SQLite vector store, creator-aware path metadata, the four media tools), running **alongside** OpenClaw text memory.
- `creative-engines-integration` — the four C++ engines + batch + node-graph wired as **long-lived native capabilities** (no per-session MCP spawn).

This spec defines **the product they add up to**, **the order to build them**, and the **cross-cutting decisions** none of the three owns alone: the shell (native desktop vs the current browser UI), packaging/provisioning of large platform-specific artifacts, the unified agent experience (one assistant, all media types, memory + GPU cooperation woven in), the honesty/Cpp_First posture as a product-level invariant, and the Stage-1 → Stage-2 product arc.

**Product framing (the maintainer's strategy, made explicit):**
- **Stage 1 (in progress / mostly done):** the four engines ship as standalone, content-marketed apps (image is the reference; audio/vector/video boot-proven; each now has the batch multiplier). Polymathes ships standalone. OpenClaw exists upstream. These prove the "agentic creative app" thesis publicly and seed awareness.
- **Stage 2 (this fork):** Creative Claw unifies them into one suite. A user downloads it, runs local models (or brings paid keys), and gets an agent that edits any media type, remembers their catalog visually, and never thrashes their GPU. Open-source-model-first is the differentiator: real creators edit locally, not in someone's cloud.

**Grounded in verified facts** (from `INTEGRATION_ANALYSIS.md` and direct source reads):
- OpenClaw is a pnpm/TS monorepo; optional capability ships as **plugins** (`definePluginEntry({ register(api) })`, `src/plugins/api-builder.ts`). It already has: an MCP client, a media-understanding pipeline (`src/media-understanding/`), an exclusive **memory slot** (`src/plugins/slots.ts`), media-generation provider seams, a Control UI (`ui/`), and SQLite-only state.
- The Polymathes GPU broker (`core-node/src/gpu/broker.ts`) is self-contained TS → near drop-in.
- Mneme (`mneme/src/mneme/`) is small, well-factored Python → clean module-for-module TS rewrite.
- The four engines are proven compiled-C++ stacks with file-path dispatchers, an agentic image edit-session, a batch runner (all four), and a node-graph executor.
- The cross-cutting risk OpenClaw's analysis flags: per-session MCP spawning is wrong for long-running C++ engines → the engines integration uses long-lived runtimes.

The requirements below define the unified product surface; the integration sequencing + dependencies; the shell decision (native desktop track) and its relationship to the C++ layer; packaging/provisioning; the unified agent experience (one assistant across media + memory + GPU); product-level honesty/Cpp_First/local-first invariants; configuration & onboarding; and acceptance for "the suite works as one product."

## Glossary

- **Creative_Claw**: The unified agentic creative suite — the OpenClaw fork being built. The product this spec defines.
- **Spine**: OpenClaw — the runtime/plugin host Creative_Claw forks. Provides the agent loop, channels, plugin system, memory slot, media pipeline, Control UI, SQLite state.
- **Integration_Spec**: One of the three component specs in this repo (`gpu-broker-integration`, `visual-memory-integration`, `creative-engines-integration`). This master spec sequences and unifies them.
- **GPU_Broker**: The transplanted cooperative VRAM arbiter (its own spec). Lets the agent, the user's editing tools, and the engines share one GPU.
- **Visual_Memory**: The transplanted Mneme media memory (its own spec). Indexes the creator's media; recalls by text or image; runs alongside text memory.
- **Creative_Engines**: The four compiled-C++ engines (image/audio/video/vector) + their batch, node-graph, and agentic-edit surfaces (their own spec).
- **Unified_Agent**: The single Creative_Claw assistant that can edit any media type, use both text and visual memory, and cooperate over the GPU — one conversation, all capabilities.
- **Shell**: The user-facing surface. Either the existing **browser** Control UI or a **native desktop** app (Tauri/Electron) — the cross-cutting decision this spec settles.
- **Native_Desktop_Track**: The (optional, sequenced-last) move off the browser to a desktop shell for tighter C++/in-process media handling.
- **Cpp_First**: Product invariant — any op with a real C++ equivalent runs on the compiled engine; learned-model passes only where no C++ equivalent exists.
- **Honesty_Invariant**: Product invariant — no capability reports success it didn't achieve; the Anti_Fake_Guard, skip-with-reason, and truthful backend/engine-path reporting hold across the whole suite.
- **Local_First**: Product invariant — local open-source models are the default execution path; paid API keys are optional and secondary; user data/media stays on the user's machine.
- **Stage_1 / Stage_2**: The product arc — standalone content-marketed apps (Stage 1) → the unified suite (Stage 2, = Creative_Claw).

## Requirements

### Requirement 1: Define Creative Claw as one unified product on the OpenClaw spine

**User Story:** As the maintainer, I want Creative Claw to be one coherent product (OpenClaw + the three transplants), so the parts add up to a suite rather than a pile of plugins.

#### Acceptance Criteria

1. THE Creative_Claw product SHALL be the OpenClaw fork with the three Integration_Specs delivered as bundled, enabled-by-default plugins (mirroring how OpenClaw bundles `comfy`), so a single install yields the full suite.
2. THE Creative_Claw product SHALL preserve OpenClaw's existing capabilities (channels, agent loop, text memory, media pipeline, Control UI) — the transplants are additive and SHALL NOT remove core OpenClaw function.
3. THE Creative_Claw product SHALL present one Unified_Agent that can reach all integrated capabilities (engine ops, batch, node-graph, edit session, visual memory, GPU control) in a single session.
4. THE Creative_Claw product SHALL document (in this repo) which OpenClaw seams each transplant uses, so the fork's delta from upstream OpenClaw is auditable.
5. THE Creative_Claw product SHALL be runnable as a fork checkout (the three plugins load from `extensions/*`), not requiring a published plugin marketplace.

### Requirement 2: Sequence and gate the three integrations

**User Story:** As the builder, I want the integrations built in dependency order, so I'm not debugging two unproven layers at once.

#### Acceptance Criteria

1. THE build SHALL proceed in the order: (1) `gpu-broker-integration`, then (2) `visual-memory-integration`, then (3) `creative-engines-integration`, because the engines and visual memory both cooperate with the broker for VRAM.
2. WHEN the GPU_Broker integration is complete, THE suite SHALL demonstrably evict VRAM and gate agent runs before any GPU-heavy engine/memory work is wired in (the broker is the foundation).
3. WHEN the Visual_Memory integration is complete, THE suite SHALL index and recall media alongside text memory, independent of the engines being wired.
4. WHEN the Creative_Engines integration is complete, THE suite SHALL drive real C++ media edits that cooperate with the already-working broker.
5. EACH integration SHALL be independently verifiable (its own spec's tests pass) before the next begins; a later integration SHALL NOT be required to validate an earlier one.

### Requirement 3: Settle the shell — browser now, native-desktop track sequenced last

**User Story:** As the maintainer, I want a clear decision on the UI shell and when (if) we move off the browser, so the C++ layer can eventually be used more directly.

#### Acceptance Criteria

1. THE Creative_Claw product SHALL ship on OpenClaw's existing **browser/Control-UI Shell** for the initial unified release (no shell rewrite blocks the integrations).
2. THE Native_Desktop_Track (moving to a Tauri/Electron desktop Shell for tighter, in-process C++/media handling) SHALL be defined as a SEPARATE, LATER track that does NOT block Requirements 1–2 (the three integrations work on the browser Shell first).
3. WHEN the Native_Desktop_Track is pursued, IT SHALL preserve the same agent/plugin architecture and the same tool/capability surface (the shell change SHALL be a presentation/transport swap, not an architecture rewrite).
4. THE decision record SHALL state the rationale: the engines speak file paths (not bulk in-memory media over the agent boundary), so the browser Shell is not a correctness blocker; native desktop is a performance/UX upgrade for direct C++ handling, pursued once the suite works.
5. WHERE the Native_Desktop_Track is deferred, THE suite SHALL remain fully functional on the browser Shell (deferring it costs UX/perf, not capability).

### Requirement 4: Unified agent experience across media, memory, and GPU

**User Story:** As a creator, I want one assistant that edits any media, remembers my catalog, and shares my GPU — in one conversation.

#### Acceptance Criteria

1. THE Unified_Agent SHALL, in a single session, be able to: edit an image/audio/video/vector file (Creative_Engines), recall media by description or similarity (Visual_Memory), and release/reclaim the GPU (GPU_Broker).
2. WHEN the user asks for a media edit, THE Unified_Agent SHALL route to the correct engine for the medium and execute on the real C++ engine (Cpp_First).
3. WHEN a media edit or visual recall references the user's catalog, THE Unified_Agent SHALL use Visual_Memory's creator-aware metadata (brand/intent/`warn_on_edit`) so it respects the workspace convention (e.g. warns before re-editing finished work).
4. WHEN a GPU-heavy edit runs, THE Unified_Agent SHALL coordinate VRAM through the GPU_Broker, and SHALL honor a user-claimed GPU.
5. THE Unified_Agent SHALL keep both text memory and Visual_Memory usable in the same session (Visual_Memory is additive, never displaces text memory).

### Requirement 5: Packaging and provisioning of large/platform-specific artifacts

**User Story:** As a user installing Creative Claw, I want the engines, models, and binaries provisioned cleanly, so the suite runs without me hand-assembling C++ builds.

#### Acceptance Criteria

1. THE product SHALL define how each engine's compiled `.dll/.so`, the Real-ESRGAN binary, ONNX/CLIP weights, and the optional native CUDA+TensorRT media-memory binary are provisioned — bundled in `extensions/*` where size permits, or fetched/built by a documented setup step.
2. THE large/platform-specific artifacts SHALL be gitignored and provisioned at setup (mirroring how the `*-workspace` repos already handle `bin/`, `*.onnx`, CUDA DLLs), never committed.
3. WHEN an engine binary or model is absent after setup, THE corresponding capability SHALL degrade honestly (skip-with-reason / report unavailable), and the rest of the suite SHALL remain functional.
4. THE setup SHALL be runnable on the target platform (Windows + NVIDIA GPU is the reference; the suite SHALL not hard-crash on non-NVIDIA/CPU-only, degrading instead).
5. THE product SHALL document a single setup path (one script / one documented sequence) that provisions the spine + the three integrations + their artifacts.

### Requirement 6: Product-level invariants — Honesty, Cpp_First, Local_First

**User Story:** As the maintainer, I want the suite's core principles enforced product-wide, so no integration quietly violates them.

#### Acceptance Criteria

1. THE Honesty_Invariant SHALL hold across the whole suite: no capability (edit, batch, recall, GPU op) reports success it did not achieve; the Anti_Fake_Guard, honest skips/failures with reasons, and truthful backend/engine-path reporting apply everywhere.
2. THE Cpp_First principle SHALL hold: every integrated op with a real C++ equivalent runs on the compiled engine; the host SHALL NOT reimplement a C++ op in TS/Python.
3. THE Local_First principle SHALL hold: local open-source models are the default execution path; paid API keys are optional/secondary; the user's media and catalog stay on the user's machine by default.
4. WHEN any integration would violate an invariant for convenience, THE product SHALL prefer honest degradation (skip/report) over a fake or a silent cloud round-trip.
5. THE product SHALL surface, to the user, which engine/model/path executed a given operation and where it ran (local vs API), so the active posture is observable.

### Requirement 7: Configuration and onboarding for the unified suite

**User Story:** As a new user, I want to configure models, providers, and the workspace once and have the whole suite work.

#### Acceptance Criteria

1. THE product SHALL expose unified configuration covering: the LLM provider/model (local Ollama default; optional cloud), the embedding/CLIP backend, the GPU broker thresholds, the visual-memory DB + auto-capture settings, and per-engine binary/model paths.
2. THE product SHALL support the creator-workspace convention (the `content/input/output/archive` + brands layout) so Visual_Memory's path metadata is meaningful out of the box.
3. WHEN configuration is incomplete (no local model, no GPU, no engine binaries), THE product SHALL boot in a degraded-but-honest mode and tell the user exactly what is unavailable and why.
4. THE onboarding SHALL get a user from install to "the agent edited a real image on my machine" with a documented, finite sequence.

### Requirement 8: Acceptance — the suite works as one product, end to end

**User Story:** As a reviewer, I want proof the unified suite works, not just the parts.

#### Acceptance Criteria

1. THE product SHALL demonstrate a unified end-to-end scenario: in one session, the Unified_Agent recalls a media asset by description (Visual_Memory), edits it on the real C++ engine (Creative_Engines), releases the GPU for an external render and reclaims it (GPU_Broker) — all honestly reported.
2. THE product SHALL demonstrate that all three integrations are loaded and co-resident without conflict (text memory + visual memory both active; the broker arbitrating; the engines reachable).
3. THE product SHALL demonstrate honest degradation: with a GPU/engine/model absent, the unified scenario skips-with-reason on the affected step and the rest still runs.
4. THE acceptance SHALL run against the real spine + real integrations on real media; environment-gated steps skip-with-reason, never fake a pass.
5. THE product SHALL document the fork's delta from upstream OpenClaw (the added plugins + any core touch-points) so the build is auditable and re-mergeable with upstream where feasible.

## Open Questions

These are product-level decisions the master spec records; the per-integration specs hold their own.

1. **Fork vs upstreamable plugins.** Are the three transplants a hard fork of OpenClaw, or plugins that could in principle install on stock OpenClaw (with the engines bundled)? The analysis notes OpenClaw steers optional capability to plugins — decide whether Creative Claw is a distinct product fork or an OpenClaw plugin bundle + thin fork.
2. **Native-desktop timing + tech.** If/when the Native_Desktop_Track happens: Tauri (Rust shell, smaller, native) vs Electron (heavier, simpler). Decide the trigger (e.g. after the three integrations ship on browser) and the tech. Not blocking.
3. **One umbrella plugin vs three.** The engines spec proposes one umbrella `extensions/creative-engines/`; the broker and memory are separate. Confirm whether all three live under one Creative-Claw bundle or stay three plugins (affects config + enablement).
4. **Catalog/DB sharing.** Visual_Memory's SQLite catalog and the engines' workspace convention overlap (both read the `content/input/...` layout). Decide whether they share one catalog/DB or stay separate-but-aligned.
5. **Branding / channel surface.** OpenClaw ships many chat channels (Telegram/Discord/etc.). Does Creative Claw keep them (creator drives edits from their phone) or trim to the desktop/web Shell for v1?
6. **Stage-1 standalone vs Stage-2 suite divergence.** As Creative Claw evolves the engines (e.g. the TS-FFI rewrite, the node-graph TS port), do the standalone Stage-1 apps track those changes or fork away? Decide the maintenance relationship so the standalones and the suite don't drift incompatibly.
