# Fork Delta — Creative Claw

This document describes what Creative Claw adds to the OpenClaw base, how it integrates, and how to stay in sync with upstream.

## What Creative Claw Adds

Creative Claw extends OpenClaw with **3 plugins** that turn the assistant into a creative production tool with GPU-accelerated media processing:

### 1. GPU Broker (`extensions/gpu-broker/`)

A cooperative single-GPU VRAM arbiter for machines that share one GPU between Ollama (LLM inference) and creative workloads (image generation, video rendering, etc.).

**Registered surfaces:**
- **Tools:** `gpu.status`, `gpu.release`, `gpu.reclaim`, `gpu.handoff`
- **Services:** 1 long-lived `gpu-broker` service (polls VRAM, manages state machine)
- **Hooks:** `agent:bootstrap` (`gpu-broker-agent-run-gate`) — **advisory only.** It appends a
  "local GPU unavailable" line at bootstrap; it does **not** block a run. `InternalHookHandler` is
  void-returning and the bootstrap consumer discards `event.messages`. A real refusal would have to
  use `before_agent_run` (a dispatched, fail-closed gate) or a trusted tool policy — see
  `HONESTY_FIXES.md` Task 5 for the ready-to-apply diff.

### 2. Visual Memory (`extensions/visual-memory/`)

Media-as-memory: indexes images, videos, and documents into a vector store for similarity search.

**Registered surfaces:**
- **Tools:** `media_index`, `media_search`, `media_search_by_image`, `media_describe`
- **Trusted tool policy:** `visual-memory-protected-content` — refuses `write`/`edit`/`apply_patch`
  on originals under a `/content/` path (`protectContent`, default on).
- **Embedding:** the `hash` backend only — deterministic trigram/byte hashing. Similarity is
  **lexical/byte-level, not semantic.** There is no CLIP/ONNX backend; every search and index result
  carries an `embedder` block reporting the backend used and any degradation.
- **No auto-capture.** The host exposes no seam that hands a plugin inbound attachment bytes or
  generated media paths, so the feature was removed rather than left as a dead switch.
- Does **NOT** claim a memory slot — operates as independent tooling, not a core memory provider.

### 3. Creative Engines (`extensions/creative-engines/`)

Native C++ image, audio, video, and vector processing engines running as long-lived co-processes. Provides pixel-level editing, batch processing, and an operation graph for complex workflows.

**Registered surfaces:**
- **Tools:** `image.list_ops`, `image.apply`, `image.apply_chain`, `image.batch`, `audio.*`, `video.*`, `vector.*`, `graph.run`, `image.edit_session.*`
- **Providers:** `registerImageGenerationProvider`, `registerMediaUnderstandingProvider`, `registerMusicGenerationProvider`, `registerVideoGenerationProvider`
- **Runtime lifecycle:** `registerRuntimeLifecycle` (load/unload the in-process FFI engine libraries on gateway start/shutdown)

### 4. Creative Studio UI (`ui/`)

A first-class **Creative Studio** switching-view added to OpenClaw's browser
Control UI. It drives the three plugins over gateway RPCs (`<media>.list_ops`,
`<media>.apply`, `gpu.status`, `media_search`) and degrades to honest
"unavailable"/empty states when an engine, GPU, or the memory store is absent —
nothing is fabricated. See `.kiro/specs/creative-claw/DECISION_SHELL.md`.

**Added `ui/` files (new):**
- `ui/src/ui/views/creative-studio.ts` — the view (media tabs, op catalog, GPU widget, run-op form, recent-outputs strip).
- `ui/src/ui/controllers/creative-studio.ts` — `CreativeStudioController` (gateway RPC state; honest degradation).

**Modified `ui/` files (additive dispatch/nav wiring only):**
- `ui/src/ui/navigation.ts` — adds the `creativeStudio` `Tab`, the `creative` tab group, the `/creative` path, and the `spark` icon.
- `ui/src/ui/app.ts` — instantiates `CreativeStudioController`.
- `ui/src/ui/app-render.ts` — `lazyCreativeStudio` + `renderCreativeStudio` dispatch when `state.tab === "creativeStudio"`.
- `ui/src/ui/app-settings.ts` — refreshes the controller on tab entry.
- `ui/src/ui/app-view-state.ts` — declares the `creativeStudio` controller field.
- `ui/src/i18n/locales/en.ts` — tab label + subtitle strings.
- `ui/src/ui/navigation.test.ts` — nav test coverage for the new tab.

## Core OpenClaw Touch-Points Used

Plugin surfaces integrate through the official OpenClaw Plugin SDK
(`openclaw/plugin-sdk`). The UI integrates through additive edits to the `ui/`
Control UI app (a navigation Tab + lazy-view dispatch), not through core `src/`.

| Touch-point | Used by | Site |
|-----|-----|-----|
| `definePluginEntry` | All 3 plugins | each `extensions/*/index.ts` |
| `api.registerTool` | All 3 plugins | `gpu.*`, `media_*`, `<media>.*`, `image.edit_session.*` |
| `api.registerService` | GPU Broker | `gpu-broker` long-lived service |
| `api.registerHook` (`agent:bootstrap`) | GPU Broker | advisory GPU-availability notice at bootstrap (cannot refuse a run) |
| `api.registerTrustedToolPolicy` | Visual Memory | `visual-memory-protected-content` — refuses edits to `/content/` originals |
| `api.registerRuntimeLifecycle` | Creative Engines | FFI engine load/unload |
| `api.registerImageGenerationProvider` | Creative Engines | `registerProviders` |
| `api.registerMediaUnderstandingProvider` | Creative Engines | `registerProviders` |
| `api.registerMusicGenerationProvider` | Creative Engines | `registerProviders` |
| `api.registerVideoGenerationProvider` | Creative Engines | `registerProviders` |
| Control UI **navigation Tab addition** | Creative Studio UI | `ui/src/ui/navigation.ts` + dispatch/nav wiring |

> **On `registerControlUiDescriptor` / `registerCli`:** these SDK seams are
> available, but the current build does **not** use them. Creative Studio is
> wired directly into the `ui/` app (nav Tab + lazy-view dispatch), and no CLI
> subcommands are registered by the three plugins. If the UI is later moved
> behind a plugin-owned Control UI descriptor (e.g. to install on stock
> OpenClaw without editing `ui/`), migrate the nav/dispatch wiring to
> `registerControlUiDescriptor` and update this table.

## Core Modifications: scope

Creative Claw is **additive**. Specifically:

- ✅ **No changes to core `src/` behavior** (agent loop, memory, channels, media pipeline, config schemas).
- ✅ No changes to `packages/` (shared libraries).
- ✅ No patched dependencies.
- ✅ No changes to existing `extensions/` (other plugins).
- ⚠️ **`ui/` has additive edits only:** two new files + additive dispatch/nav
  wiring in the app shell (listed under *Creative Studio UI* above). No existing
  view behavior is altered; the new tab is purely additive.

All code lives in:
```
extensions/gpu-broker/
extensions/visual-memory/
extensions/creative-engines/
extensions/creative-claw-composition.test.ts
extensions/creative-claw-smoke.test.ts
ui/src/ui/views/creative-studio.ts          (new)
ui/src/ui/controllers/creative-studio.ts    (new)
ui/src/ui/navigation.ts                      (additive: creativeStudio tab)
ui/src/ui/app.ts                             (additive: controller wiring)
ui/src/ui/app-render.ts                      (additive: view dispatch)
ui/src/ui/app-settings.ts                    (additive: refresh on tab entry)
ui/src/ui/app-view-state.ts                  (additive: controller field)
ui/src/i18n/locales/en.ts                    (additive: tab label + subtitle)
FORK_DELTA.md (this file)
.kiro/specs/creative-claw/DECISION_SHELL.md
.kiro/specs/creative-claw/INVARIANTS.md
```

## Dependency Order

The plugins have a soft dependency order for full functionality:

```
1. GPU Broker (standalone — no deps on other Creative Claw plugins)
      ↓
2. Visual Memory (standalone — optionally captures engine outputs)
      ↓
3. Creative Engines (consumes GPU Broker for cooperative VRAM;
                     emits media:generated events for Visual Memory)
```

All three plugins can load independently. Creative Engines gracefully degrades without the GPU Broker (it just won't coordinate VRAM). Visual Memory works standalone for pure indexing/search.

## How to Re-merge with Upstream

Creative Claw code lives in `extensions/` (all-new plugin dirs + a few root-level
files), plus **additive edits to the `ui/` Control UI app** and two spec docs.

### Pulling upstream changes:
```bash
git remote add upstream https://github.com/openclaw/openclaw.git
git fetch upstream
git merge upstream/main
# or: git rebase upstream/main
```

**Expected conflicts:**
- **`extensions/gpu-broker`, `extensions/visual-memory`, `extensions/creative-engines`:**
  none expected — all-new dirs; conflict only if upstream adds identically named plugins (extremely unlikely).
- **`ui/` files:** the additive dispatch/nav wiring lives in shared app files
  (`navigation.ts`, `app.ts`, `app-render.ts`, `app-settings.ts`,
  `app-view-state.ts`, `en.ts`). Upstream edits to those files **can conflict**.
  Because the edits are additive (new `Tab`, new tab group, new dispatch branch,
  new controller field, new i18n keys), resolution is mechanical: re-apply the
  `creativeStudio` additions on top of upstream. The two new files
  (`views/creative-studio.ts`, `controllers/creative-studio.ts`) never conflict.

### Reducing `ui/` merge friction (optional, later):
If `ui/` merge conflicts become painful, move Creative Studio behind a
plugin-owned `registerControlUiDescriptor` so the tab is contributed by
`extensions/creative-engines` instead of edited into the app shell. That would
also let the suite install on **stock** OpenClaw without touching `ui/`. Tracked
as a follow-up in `DECISION_SHELL.md`.

### Keeping in sync:
- Watch for Plugin SDK API changes in upstream `src/plugin-sdk/` — the SDK is a public contract but check release notes.
- If `registerImageGenerationProvider` or similar provider APIs change signatures, update `extensions/creative-engines/src/providers.ts`.
- If the Control UI app shell refactors its tab/dispatch model, re-apply the `creativeStudio` wiring (see the `ui/` file list above).
- Run `openclaw doctor` after upstream merges to detect config drift.

### Contributing back:
If any Creative Claw feature belongs in core (e.g., a generic GPU awareness API), propose it as an upstream PR to `openclaw/openclaw`. The Creative Claw plugin can then consume it instead of implementing its own version.

## File Inventory

```
extensions/
├── gpu-broker/
│   ├── index.ts              Plugin entry
│   ├── package.json          Package metadata
│   ├── openclaw.plugin.json  Plugin manifest
│   └── src/
│       ├── broker.ts         GpuBroker state machine
│       ├── tools.ts          Tool handlers
│       ├── nvidia.ts         nvidia-smi integration
│       ├── ollama.ts         Ollama model eviction
│       └── types.ts          Shared types
├── visual-memory/
│   ├── index.ts              Plugin entry
│   ├── package.json          Package metadata
│   ├── openclaw.plugin.json  Plugin manifest
│   └── src/
│       ├── embedder/         Embedding backend (hash only — non-semantic)
│       ├── store.ts          SQLite vector store
│       ├── edit-guard.ts     Trusted tool policy: protect /content/ originals
│       ├── pathmeta.ts       Brand/intent/warnOnEdit path inference
│       ├── tools.ts          Tool handlers
│       └── types.ts          Shared types
├── creative-engines/
│   ├── index.ts              Plugin entry
│   ├── package.json          Package metadata
│   ├── openclaw.plugin.json  Plugin manifest
│   └── src/
│       ├── runtime/          Engine co-process managers
│       ├── tools/            Tool registration
│       ├── image/            Edit session
│       ├── providers.ts      Provider registration
│       ├── gpu-coop.ts       GPU broker integration
│       └── types.ts          Shared types
├── creative-claw-composition.test.ts  Co-registration test
└── creative-claw-smoke.test.ts        Integration smoke test

FORK_DELTA.md                 This document
```
