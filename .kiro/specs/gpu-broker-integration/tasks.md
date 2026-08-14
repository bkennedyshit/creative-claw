# Implementation Plan: GPU Broker Integration

## Overview

Port Polymathes' GPU broker into Creative Claw as a native TS code plugin at `extensions/gpu-broker/`. Order: copy the proven `GpuBroker` class with minimal logger/config adaptation, stand it up as a gateway-lifetime service, register the four GPU tools, wire the agent-run gate + warmup recalibration, add operator surfaces + config/reload, then lock behavior with state-machine unit tests + one real-VRAM evacuation test. The broker logic is **ported, not rewritten** — keep the verified state machine, lease model, ghost-claim, and snapshot fallback intact.

Language: TypeScript (`vitest`), matching OpenClaw. Tests split into always-runnable (mocked snapshot/fetch) and GPU/Ollama-gated (skip-with-reason when absent). Reference source: Polymathes `core-node/src/gpu/broker.ts` + `core-node/src/tools/builtin/gpu.ts`. Reference seams: OpenClaw `src/plugins/api-builder.ts`, `src/plugin-sdk/plugin-entry.ts`, `extensions/comfy/` (code-plugin precedent).

## Tasks

- [x] 1. Scaffold the plugin
  - [x] 1.1 Create `extensions/gpu-broker/` with `openclaw.plugin.json` (id `gpu-broker`, kind code plugin, `configSchema`) + `index.ts` (`definePluginEntry`)
    - Mirror an existing code plugin's manifest shape (e.g. `extensions/comfy/openclaw.plugin.json`); declare the config keys (ollamaUrl, pollMs, externalClaimThresholdMb, defaultHoldMs, dormant)
    - _Requirements: 1.1, 8.1_
  - [x] 1.2 Confirm dependency availability (`ulid`, Node ≥18 `fetch`/`AbortSignal.timeout`) and add `ulid` to the plugin if not already in the tree
    - _Requirements: 1.5_

- [x] 2. Port the GpuBroker class (`extensions/gpu-broker/src/broker.ts`)
  - [x] 2.1 Copy `core-node/src/gpu/broker.ts` and adapt the logger/config wiring to OpenClaw
    - Preserve the state machine (`idle|agent-active|user-claimed|draining|dormant`), lease token + auto-expiry, `claim`/`release`/`evacuateOllama`/`waitForVramFree`/`recalibrateBaseline`/`snapshotGpu`/`poll`/`canAgentRun` verbatim; swap the pino `Logger` for an OpenClaw `{info,warn,error}` shim; add an `applyConfig()` for reload
    - _Requirements: 1.2, 1.5, 4.1, 6.1, 6.4_
  - [x]* 2.2 Unit tests (mocked `snapshotGpu`/`fetch`): lease token integrity, expiry auto-release, claim-while-claimed rejection
    - **Property 2 — Validates: Requirements 1.2**

- [x] 3. Register as a gateway-lifetime service
  - [x] 3.1 `api.registerService` with `start()` → `broker.init()`, `stop()` → `broker.shutdown()` + release agent lease
    - Single instance for the gateway lifetime (not per-session); init sets baseline + starts poll unless dormant
    - _Requirements: 1.1, 1.3, 1.4_
  - [x] 3.2 Dormant_Mode wiring: detect non-local LLM provider in `resolveConfig` → construct broker with `dormant:true`
    - _Requirements: 7.2_

- [x] 4. Register the four GPU tools (`extensions/gpu-broker/src/tools.ts`)
  - [x] 4.1 Map `gpu.status`/`gpu.release`/`gpu.reclaim`/`gpu.handoff` onto `api.registerTool` with zod schemas, broker captured in closure
    - Preserve Polymathes semantics (release = claim-on-behalf returning a token; reclaim = release(token); handoff = evacuate→peer POST→reclaim); place in the DEFAULT tool profile, not `minimal`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_
  - [x]* 4.2 Tests: each tool returns broker state / claim result; `gpu.status` reflects live state
    - _Requirements: 2.1_

- [ ] 5. Agent-run gate
  - [ ] 5.1 Hook OpenClaw's run-start lifecycle and deny local-LLM runs when `canAgentRun()` is false
    - Confirm the exact hook event in `src/agents/*` (OQ1); block with the broker's reason on `user-claimed`/`draining`; permit on `idle`/`agent-active`; always permit in dormant
    - _REOPENED: no gate exists. There is no `src/run-gate.ts`; the handler lives in `index.ts` on `agent:bootstrap`, where `InternalHookHandler` is void-returning and `src/agents/bootstrap-hooks.ts:31-34` discards `event.messages` — it can only append an advisory notice, never refuse. OQ1 is now ANSWERED: the real seam is the `before_agent_run` typed hook (dispatched from `src/agents/cli-runner.ts:1100` and `src/agents/embedded-agent-runner/run/attempt.ts:4321`, `fail-closed`, accepts `{ outcome: "block", reason }`); a tool-granularity alternative is `api.registerTrustedToolPolicy`. A ready-to-apply implementation is in HONESTY_FIXES.md Task 5 / D2 — note it also needs a one-line host allowlist change in `src/plugins/contracts/boundary-invariants.test.ts`._
    - _Requirements: 3.1, 3.2, 3.3, 3.4_
  - [ ]* 5.2 Tests (mocked broker state): gate denies while claimed/draining, permits otherwise, permits in dormant
    - _Blocked by 5.1. `broker.test.ts:139-159` covers the `canAgentRun()` decision function only, not enforcement._
    - **Property 4 — Validates: Requirements 3.1, 3.2, 3.3**

- [x] 6. External pressure + ghost-claim (already in ported class — verify + tune)
  - [x] 6.1 Tune the poll's Ollama-footprint subtraction to read per-model `size_vram` from `/api/ps` when available (OQ3), keep heuristic as fallback
    - _Requirements: 4.1_
  - [x]* 6.2 Tests (mocked snapshots): pressure>threshold→ghost-claim; pressure<half→auto-release; explicit claim not overridden
    - **Property 3 — Validates: Requirements 4.2, 4.3, 4.4**

- [x] 7. Warmup recalibration (`extensions/gpu-broker/src/warmup.ts`)
  - [x] 7.1 Call `broker.recalibrateBaseline()` after a deliberate model warmup (OQ2)
    - Hook the provider-warm/model-load path; fallback: recalibrate on first run after `idle→agent-active`
    - _Requirements: 5.1, 5.2, 5.3_
  - [x]* 7.2 Test: after recalibrate following a simulated warmup, the warmed footprint does not trigger a ghost-claim
    - **Property 5 — Validates: Requirements 5.2, 5.3**

- [x] 8. Config + reload + operator surfaces
  - [x] 8.1 `resolveConfig(api)` applying verified defaults when absent; `api.registerReload` → `broker.applyConfig`
    - _Requirements: 8.1, 8.2, 8.3_
  - [x] 8.2 Operator surface: `api.registerControlUiDescriptor` and/or `api.registerHttpRoute("/gpu/state")` + `api.registerCli("gpu", ...)` reading live `broker.getState()`
    - _Requirements: 9.1, 9.2_

- [ ] 9. Honest degradation + real-VRAM evacuation proof
  - [x]* 9.1 Degradation tests (mocked): nvidia-smi absent→/api/ps path; both absent→zero/empty no-crash; dormant→`dormant:true`
    - **Property 6 — Validates: Requirements 7.1, 7.3, 7.4**
  - [ ]* 9.2 GPU/Ollama-gated test: warm a real Ollama model, `claim`, assert measured VRAM drops (skip-with-reason when no GPU/Ollama — never a fake pass)
    - **Property 1 — Validates: Requirements 6.1, 6.3**
    - _Note: requires live GPU+Ollama at review time; test exists and skips-with-reason when absent._

- [ ] 10. Final checkpoint
  - Run the suite: always-runnable unit tests pass; the GPU-gated evacuation test passes where a GPU+Ollama exist and skips-with-reason otherwise. Confirm one gateway-lifetime broker instance, the four tools in the default profile, the agent gate honoring claims, and honest degradation. Ask the user if questions arise.
  - _Note: requires live GPU+Ollama at review time; test exists and skips-with-reason when absent._

## Notes

- **Port, not rewrite.** Task 2 copies the proven class; no task reimplements the arbitration logic.
- **Anti-fake gate:** the broker reports VRAM from a real source and `claim` waits for a measured drop (Property 1) — never reports eviction it didn't achieve.
- **Tasks marked `*` are optional test sub-tasks**; core tasks are not.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "2.1"] },
    { "id": 1, "tasks": ["2.2", "3.1", "3.2"] },
    { "id": 2, "tasks": ["4.1", "5.1", "6.1", "7.1", "8.1"] },
    { "id": 3, "tasks": ["4.2", "5.2", "6.2", "7.2", "8.2", "9.1"] },
    { "id": 4, "tasks": ["9.2", "10"] }
  ]
}
```
