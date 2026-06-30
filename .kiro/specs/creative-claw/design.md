# Creative Claw (Master) — Design

## Overview

Creative Claw is a local-first agentic creative suite built by forking **OpenClaw** (the spine) and delivering three transplants as bundled, enabled-by-default plugins: the **GPU broker**, **visual memory** (Mneme→TS), and the **four C++ creative engines** (+ batch + node-graph + agentic edit). This is the **master design** — it does not re-design the three integrations (each has its own `requirements/design/tasks`), it designs **how they compose into one product**, the **build sequence**, and the **cross-cutting decisions** (shell, packaging, unified agent, invariants, product arc).

Grounded in verified facts:
- **Spine = OpenClaw**: pnpm/TS monorepo, plugin host (`definePluginEntry`/`api-builder.ts`), exclusive memory slot (`slots.ts`), media-understanding pipeline (`src/media-understanding/`), media-gen provider seams, Control UI (`ui/`), SQLite-only state, bundles `comfy` enabled-by-default as a code-plugin precedent.
- **Three integration specs** already authored in this repo: `gpu-broker-integration`, `visual-memory-integration`, `creative-engines-integration`.
- **Dependency reality**: both visual memory (CLIP) and the engines (diffusion/upscale/segmentation) want VRAM → both cooperate with the broker → the broker is the foundation, built first.
- **Engine boundary**: engines speak file paths via dispatchers (small JSON: op + paths + params, not pixels) → the browser shell is NOT a correctness blocker; native desktop is a later perf/UX upgrade.

> **`requirements.md` is the source of truth.** Open Questions resolved at the end.

## Architecture

```
                         ┌──────────────────── Creative Claw (OpenClaw fork) ───────────────────┐
   creator ── chat / Control UI (browser Shell; native-desktop later) ──▶ Unified_Agent (OpenClaw agent loop)
                                                              │  one session reaches ALL capabilities
                                                              ▼
   ┌──────────────────────── bundled, enabled-by-default plugins (extensions/*) ────────────────────────┐
   │                                                                                                    │
   │  [1] gpu-broker        [2] visual-memory            [3] creative-engines                            │
   │   registerService       media tools (companion       per-engine long-lived Engine_Runtime          │
   │   gpu.* tools           to text memory, NOT slot)     <engine>.{list_ops,apply,apply_chain,batch}   │
   │   agent-run gate        CLIP+hash+native embed        image.edit_session.* (stacking + Anti_Fake)   │
   │   ghost-claim/release    SQLite vector store           creative.graph.run (node-graph)             │
   │        │                  creator-aware pathmeta        media-gen provider registration            │
   │        │                       │                              │                                     │
   └────────┼───────────────────────┼──────────────────────────────┼─────────────────────────────────────┘
            │  VRAM coordination     │  catalog (content/input/...)  │  file paths + op names
            ▼                        ▼                              ▼
   ┌──────── shared substrate ──────────────────────────────────────────────────────────────────────────┐
   │  one GPU (broker-arbitrated)   SQLite (OpenClaw state + vector store)   the creator's media on disk   │
   │  compiled C++ engines (libomni_*) + Real-ESRGAN + ONNX/CLIP + optional native CUDA+TRT media-memory   │
   └────────────────────────────────────────────────────────────────────────────────────────────────────┘

   Build order (Req 2):  [1] broker  ──▶  [2] visual-memory  ──▶  [3] creative-engines
   Shell (Req 3):        browser Control UI now  ──▶  native-desktop track LATER (separate, non-blocking)
```

The master design's job is the **composition**: the broker is the foundation every GPU-heavy capability cooperates with; visual memory is additive (companion to text memory, never claims the slot); the engines are long-lived runtimes (no per-session spawn) that pass file paths and cooperate with the broker. All three are bundled enabled-by-default like `comfy`, so one install = the suite.

## Components and Interfaces

### Component 1: The fork structure (`extensions/` bundle)

Creative Claw = OpenClaw checkout + three plugins under `extensions/`:
- `extensions/gpu-broker/` (Integration_Spec 1)
- `extensions/visual-memory/` (Integration_Spec 2)
- `extensions/creative-engines/` (Integration_Spec 3, umbrella for the four engines)

All declared enabled-by-default (the `comfy` precedent). OpenClaw's bundled-plugin discovery (`bundled-sources.ts`/`bundled-plugin-scan.ts`) loads them from a source checkout (Req 1.5). Core OpenClaw is untouched except documented touch-points (Req 1.4, 8.5). The fork delta = these three plugins + any minimal core hook (e.g. the agent-run-gate seam the broker needs).

### Component 2: Build sequencing + gates (Req 2)

A documented, dependency-ordered build:
1. **GPU broker first** — the foundation. Verifiable alone (evicts VRAM, gates agent runs) before anything GPU-heavy exists.
2. **Visual memory second** — indexes/recalls alongside text memory; uses the broker for CLIP VRAM but is otherwise independent of the engines.
3. **Creative engines third** — drive real C++ edits, cooperating with the already-working broker.

Each integration's own test suite must pass before the next starts (Req 2.5). The master spec owns only the gate checkpoints; the per-integration specs own the work.

### Component 3: Unified agent composition (Req 4)

No new agent — OpenClaw's agent loop is the Unified_Agent. Composition is achieved by the three plugins all registering into the same `api` (tools, providers, memory supplement, service), so in one session the agent can:
- edit any medium (`<engine>.apply`/`apply_chain`, `image.edit_session.*`, `<engine>.batch`, `creative.graph.run`),
- recall media (`media_search`/`media_search_by_image`) with creator-aware metadata (respecting `warn_on_edit`),
- control the GPU (`gpu.*`), with model-heavy edits coordinating VRAM automatically.
Routing-by-medium and Cpp_First execution are owned by the engines spec; this design only asserts they coexist in one session and the broker/memory weave in.

### Component 4: Shell decision (Req 3) — browser now, native-desktop track later

- **Now:** OpenClaw's browser Control UI is the Shell. The three integrations expose Control-UI descriptors / HTTP routes / CLI; no shell rewrite gates them.
- **Decision rationale (recorded):** engines pass file paths, not bulk media, over the agent boundary → the browser shell is not a correctness/perf blocker for the C++ layer. Native desktop is a UX/perf upgrade (direct in-process media handling, no localhost hop), not a prerequisite.
- **Native-desktop track (separate, later):** a Tauri/Electron shell wrapping the same gateway + plugins. Same agent/plugin architecture, same tool surface — a presentation/transport swap (Req 3.3). Deferring it costs UX/perf, not capability (Req 3.5). Tech (Tauri vs Electron) is OQ2.

### Component 5: Packaging & provisioning (Req 5)

- Compiled `.dll/.so`, Real-ESRGAN bin, ONNX/CLIP weights, optional native CUDA+TRT media-memory binary: bundled in the relevant `extensions/*` where size permits, else fetched/built by a documented setup step. Gitignored, provisioned at setup (mirrors the `*-workspace` `bin/` + `*.onnx` + CUDA-DLL handling) — never committed (Req 5.2).
- A single documented setup path provisions spine + three integrations + artifacts (Req 5.5).
- Missing artifact → that capability degrades honestly; the rest runs (Req 5.3). Non-NVIDIA/CPU-only degrades, never hard-crashes (Req 5.4).

### Component 6: Product invariants enforced suite-wide (Req 6)

The three invariants are asserted at the product level and each integration inherits them:
- **Honesty_Invariant**: Anti_Fake_Guard on edits, honest skip/fail with reasons, truthful backend/engine-path reporting — across edits, batch, recall, GPU ops.
- **Cpp_First**: real C++ for any op with a C++ equivalent; no host reimplementation.
- **Local_First**: local models default; API keys optional/secondary; media/catalog stay local.
A suite-level acceptance scenario (Req 8) exercises all three invariants end to end.

### Component 7: Configuration & onboarding (Req 7)

One unified config surface (OpenClaw's config + the three plugins' `configSchema`): LLM provider/model, embedding/CLIP backend, broker thresholds, visual-memory DB + auto-capture, per-engine binary/model paths. Supports the creator-workspace convention so path metadata is meaningful out of the box. Incomplete config → degraded-but-honest boot that names what's unavailable (Req 7.3). Onboarding is a finite documented path to "the agent edited a real image on my machine" (Req 7.4).

## Data Models

This master spec defines no new runtime data models — it composes the integrations'. Cross-cutting records it owns:
- **Fork_Delta_Doc**: the documented set of added plugins + core touch-points (Req 1.4, 8.5).
- **Setup_Manifest**: what each provisioning step installs (binaries/models per engine + the native media-memory binary), and how a capability degrades when an item is absent (Req 5).
- **Unified_Config**: the merged config schema spanning OpenClaw + the three plugins (Req 7.1).
- **Decision_Record**: the shell decision (browser now / native-desktop later), the fork-vs-plugin posture, and the open product questions (Req 3.4, OQ section).

## Correctness Properties

Product-level properties (the integrations hold their own; these assert composition).

### Property 1: All three integrations co-resident without conflict
With Creative Claw booted, the GPU broker service, the visual-memory plugin, and the creative-engines plugin are all loaded; text memory still occupies the memory slot AND visual memory is usable (companion path).
**Validates: Requirements 1.1, 1.3, 4.5, 8.2**

### Property 2: Build-order gates hold
The broker is independently verifiable before visual memory; visual memory before the engines; no later integration is required to validate an earlier one.
**Validates: Requirements 2.2, 2.3, 2.4, 2.5**

### Property 3: Unified single-session capability
In one session the Unified_Agent can recall a media asset (visual memory), edit it on the real C++ engine (engines), and release/reclaim the GPU (broker) — each step real and honestly reported.
**Validates: Requirements 4.1, 4.2, 8.1**

### Property 4: Creator-aware respect across capabilities
An edit targeting a `content/` (finished) asset surfaces the `warn_on_edit` metadata from visual memory before re-editing — memory and engines compose around the workspace convention.
**Validates: Requirements 4.3**

### Property 5: Honest degradation suite-wide
With a GPU/engine/model absent, the unified scenario skips-with-reason on the affected step and the remaining steps still run; nothing is faked.
**Validates: Requirements 5.3, 6.4, 8.3**

### Property 6: Invariants observable
For a given operation, the suite reports which engine/model/path executed it and whether it ran locally or via API (Cpp_First + Local_First observable; Honesty truthful).
**Validates: Requirements 6.1, 6.5**

### Property 7: Browser shell sufficiency
The full unified scenario (Property 3) runs on the browser Control UI Shell with no native-desktop dependency.
**Validates: Requirements 3.1, 3.5**

> Non-property checks: core OpenClaw function preserved (Req 1.2); single setup path provisions everything (Req 5.5); degraded-but-honest boot names what's missing (Req 7.3); fork delta documented (Req 8.5).

## Error Handling

| Scenario | Behavior |
|---|---|
| A transplant plugin fails to load | Suite boots with the others; the failed capability reports unavailable + reason (Req 1.2, 5.3). |
| GPU absent | Broker dormant/degraded; GPU-heavy edits skip-with-reason; pure-C++ + text/visual recall still work (Req 5.4, 6.4). |
| Engine binary/model absent after setup | That engine's tools report unavailable; other engines + memory + broker run (Req 5.3). |
| Visual memory would claim the memory slot | Forbidden — companion path only; text memory stays active (Req 4.5). |
| Build out of order (engines before broker) | Disallowed by the sequencing gate; engines' GPU cooperation has no broker to talk to (Req 2.1). |
| Incomplete config | Degraded-but-honest boot; names exactly what's unavailable (Req 7.3). |
| Native-desktop track not done | Suite fully functional on browser shell (Req 3.5). |

## Testing Strategy

This master spec verifies **composition**, not the integrations' internals (those have their own tests):
- **Always-runnable:** all three plugins load co-resident (Property 1); text memory + visual memory both active; build-order gate documentation/check (Property 2); degraded-boot naming (Req 7.3); fork-delta doc exists (Req 8.5).
- **Environment-gated (skip-with-reason):** the unified end-to-end scenario (Property 3 — recall → edit → GPU release/reclaim) on real media with a real GPU/engines; honest-degradation variant (Property 5) with an artifact removed. Never fake — skip with reason when GPU/engine/model is absent.

Language: TypeScript (`vitest`) for the composition tests, run against the assembled fork. The integrations' own suites (TS for broker/memory wiring; TS + the engines' Python/C++ for engine ops) run per their specs.

## Open Questions — resolved as design decisions

1. **Fork vs upstreamable plugins:** Treat Creative Claw as a **product fork** that bundles the three plugins enabled-by-default (the `comfy` model), while keeping the plugins clean enough to *also* install on stock OpenClaw. Best of both: ships as a coherent product, plugins stay portable.
2. **Native-desktop timing/tech:** Defer; trigger = after the three integrations ship working on the browser shell. Lean **Tauri** (Rust shell, smaller, native, closer to the C++ layer) over Electron, decided at that point. Non-blocking.
3. **One umbrella vs three plugins:** Keep **three plugins** (broker, visual-memory, creative-engines) — they have distinct lifecycles and config; the engines spec already umbrellas the four engines under its one plugin. Three top-level plugins, bundled together.
4. **Catalog/DB sharing:** Visual memory and the engines both read the `content/input/output/archive` workspace convention; keep **one shared workspace convention** but **separate-but-aligned** stores (visual-memory's vector DB vs the engines' file outputs), joined by path. Avoids coupling their lifecycles.
5. **Channels:** Keep OpenClaw's channels available (a creator driving edits from their phone is on-brand) but the **desktop/web Shell is the primary surface** for v1; channels are secondary and untouched.
6. **Stage-1 ↔ Stage-2 maintenance:** The Stage-1 standalone apps and Creative Claw **share the C++ engines + dispatchers** as the common substrate; Creative-Claw-specific work (TS-FFI rewrite, TS node-graph) lives in the fork and flows back to the standalones only where it's a net engine improvement (e.g. new bridge ops). Documented so they don't drift incompatibly.

## Honesty Ledger

**Real once implemented:** Creative Claw is one product on the OpenClaw spine with the three transplants bundled enabled-by-default; the broker actually arbitrates VRAM; visual memory recalls real media alongside (not instead of) text memory; the engines drive real C++ edits cooperating with the broker; the unified single-session scenario is genuinely exercised; degradation is honest; the fork delta is documented.

**Needs validation during implementation:** the exact core touch-point the broker's agent-run-gate needs (cross-refs the broker spec OQ1); whether the three plugins install cleanly on stock OpenClaw (OQ1); the native-desktop track feasibility (OQ2); shared-vs-separate catalog ergonomics (OQ4).

**Out of scope (owned elsewhere or later):** the internals of the three integrations (their own specs); the native-desktop shell build (later track); rewriting the C++ engines (used as-is); the Stage-1 standalone apps' own roadmaps (shared substrate, separate products).
