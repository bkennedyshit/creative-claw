# Decision Record — Shell (browser now, native-desktop later)

**Status:** Accepted
**Scope:** Master spec, Task 6.1 (Requirements 3.1–3.5)
**Decision owners:** Creative Claw master spec

## Decision

Creative Claw ships on **OpenClaw's browser Control UI** now. A **native-desktop
(Tauri) shell is a separate, later phase** that preserves the same agent/plugin
architecture and the same tool surface. Native desktop is a performance/UX
upgrade, not a prerequisite for the suite to be correct or complete.

## Context

The three integrations expose their capability through the OpenClaw agent/plugin
boundary and through gateway RPCs, not through a bespoke desktop runtime:

- **GPU broker** — `gpu.status`, `gpu.release`, `gpu.reclaim`, `gpu.handoff`
  tools + a `gpu-broker` service + the `agent-run-gate` hook
  (`extensions/gpu-broker/index.ts`).
- **Visual memory** — `media_index`, `media_search`, `media_search_by_image`,
  `media_describe` tools (`extensions/visual-memory/index.ts`).
- **Creative engines** — per-medium `*.list_ops` / `*.apply` / `*.apply_chain` /
  `*.batch`, `image.edit_session.*`, and media-gen providers
  (`extensions/creative-engines/index.ts`).

Critically, **the engines speak file paths, not pixels.** Dispatchers exchange
small JSON envelopes (op name + input/output paths + params); bulk media never
crosses the agent boundary in memory. That is what makes the browser shell
adequate: there is no large-payload marshalling hop that a native shell would
have to eliminate for correctness.

## What was actually built (browser shell)

A first-class **Creative Studio** switching-view was added to the browser
Control UI, wired additively into the existing `ui/` app:

- **View:** `ui/src/ui/views/creative-studio.ts` — media tab switcher
  (image / audio / video / vector), per-engine op catalog, GPU widget, a run-op
  form, and a recent-outputs strip.
- **Controller:** `ui/src/ui/controllers/creative-studio.ts` —
  `CreativeStudioController` drives gateway RPCs (`<media>.list_ops`,
  `<media>.apply`, `gpu.status`, `media_search`). Missing engines / GPU / memory
  **degrade to honest "unavailable" / empty states**; nothing is fabricated.
- **Navigation:** `ui/src/ui/navigation.ts` adds the `creativeStudio` `Tab`, the
  `creative` tab group, the `/creative` path, and the `spark` icon.
- **Dispatch/wiring:** `ui/src/ui/app.ts`, `ui/src/ui/app-render.ts`
  (`lazyCreativeStudio` + `renderCreativeStudio`), `ui/src/ui/app-settings.ts`
  (refresh on tab entry), `ui/src/ui/app-view-state.ts`, and
  `ui/src/i18n/locales/en.ts` (tab label + subtitle).

These are additive dispatch/nav edits to `ui/`; **no core `src/` behavior was
changed.** See `FORK_DELTA.md` for the full touch-point inventory.

## Rationale

1. **Not a correctness blocker.** Because engines pass file paths, the C++ layer
   runs identically regardless of whether the shell is a browser tab or a native
   window. The browser shell can drive every capability end to end (Property 7).
2. **Ship the suite first.** The product goal is "the agent edited a real image
   on my machine." That is fully reachable on the browser shell today; deferring
   native desktop costs UX/perf, not capability (Req 3.5).
3. **Architecture is preserved across the swap.** A native shell is a
   presentation/transport swap around the same gateway + plugins + tool surface
   (Req 3.3). Choosing it now would add a shell rewrite to the critical path for
   zero capability gain.

## Native-desktop track (separate, later)

- **Trigger:** pursued after the three integrations ship working on the browser
  shell.
- **Shape:** a Tauri shell wrapping the same gateway + plugins. Same agent loop,
  same tool names, same RPCs. Gains: direct in-process media handling and no
  localhost hop (perf/UX), tighter proximity to the C++ layer.
- **Tech choice:** lean Tauri (Rust, smaller, native, closer to the C++ layer)
  over Electron; finalized at that phase (master design OQ2).
- **Non-blocking:** if the native track is never done, the suite remains fully
  functional on the browser shell (Error Handling table, Req 3.5).

## Consequences

- The browser Control UI is the primary v1 surface; OpenClaw channels remain
  available but secondary.
- Any capability added to the suite must remain reachable via gateway RPC / tool
  surface so it works on both the current browser shell and the future native
  shell without re-plumbing.
