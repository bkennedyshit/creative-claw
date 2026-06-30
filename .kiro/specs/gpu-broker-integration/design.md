# GPU Broker Integration — Design

## Overview

Port Polymathes' cooperative GPU broker into Creative Claw (the OpenClaw fork) as a **native TypeScript code plugin** at `extensions/gpu-broker/`. Both codebases are TS, and the Polymathes broker (`core-node/src/gpu/broker.ts`) is a single self-contained class, so this is a **port-with-adaptation, not a rewrite**: keep the proven state machine, lease model, Ollama eviction, external-pressure ghost-claim, and `nvidia-smi`/`/api/ps` snapshot logic verbatim; replace only the logger/config wiring and the tool-registration surface with OpenClaw's plugin `api`.

Grounded in the verified source:
- **`broker.ts`** — `GpuBroker` class. Constructor opts (`ollamaUrl`, `pollMs`, `externalClaimThresholdMb`, `defaultHoldMs`, `dormant`, `logger`). Methods: `init()`, `recalibrateBaseline()`, `shutdown()`, `getState()`, `claim({owner,reason,holdMs,vramNeededMb})`, `release(token)`, `evacuateOllama()`, `waitForVramFree(targetMb,timeoutMs)`, private `snapshotGpu()` (nvidia-smi → Ollama `/api/ps` fallback), private `poll()` (ghost-claim/auto-release), `canAgentRun()`. Self-contained deps: `node:child_process.spawnSync`, global `fetch`, `ulid`, pino-style logger.
- **`gpu.ts`** — registers `gpu.status` / `gpu.release` (claim-on-behalf with owner `agent-released`) / `gpu.reclaim` (release token) / `gpu.handoff` (evacuate → POST peer `/api/chat` → release) against a `ToolRegistry` with `zod` parameter schemas and a `setGpuBroker(b)` injection. Creative Claw maps these onto `api.registerTool`.
- **OpenClaw plugin api** (`src/plugins/api-builder.ts`): `registerService`, `registerTool`, `registerHook`/`registerRuntimeLifecycle`, `registerReload`, `registerCli`, `registerControlUiDescriptor`, `registerHttpRoute`. Plugin entry: `definePluginEntry({ id, name, kind?, configSchema?, register(api) })` (`src/plugin-sdk/plugin-entry.ts`). Manifest `openclaw.plugin.json`.

> **`requirements.md` is the source of truth.** Open Questions are resolved at the end.

## Architecture

```
   Creative Claw gateway (OpenClaw spine)
        │  loads extensions/* at boot (src/plugins/loader.ts)
        ▼
   ┌──────── extensions/gpu-broker/ (NEW code plugin) ───────────────────────────┐
   │ index.ts  definePluginEntry({ id:"gpu-broker", register(api){ ... } })       │
   │                                                                             │
   │  register(api):                                                             │
   │   1. const broker = new GpuBroker(cfgFromOpenClaw)                          │
   │   2. api.registerService(...)  ── gateway-lifetime singleton ──▶ broker.init()│
   │   3. api.registerTool(...) x4  ── gpu.status/release/reclaim/handoff ──┐     │
   │   4. api.registerHook(run-start) ── Agent_Run_Gate: broker.canAgentRun()│    │
   │   5. api.registerReload(...)   ── re-apply config                       │    │
   │   6. api.registerControlUiDescriptor / registerHttpRoute / registerCli  │    │
   └──────────────────────────────┬──────────────────────────────────────────┘  │
                                   ▼                                              
   ┌──────── gpu/broker.ts (PORTED class, near-verbatim) ───────────────────────┐
   │  snapshotGpu(): spawnSync(nvidia-smi) → fallback fetch(ollama/api/ps)       │
   │  poll(): external pressure → ghost-claim / auto-release                     │
   │  claim(): evacuateOllama(keep_alive:0) → waitForVramFree(baseline+buffer)   │
   │  release(token) / recalibrateBaseline() / canAgentRun()                     │
   └────────────────────────────────────────────────────────────────────────────┘
                                   │
            ┌──────────────────────┴───────────────────────┐
            ▼                                               ▼
        nvidia-smi (VRAM truth)                  Ollama HTTP (/api/ps, /api/generate keep_alive:0)
```

The Agent_Run_Gate is the one genuinely new wiring: Polymathes called `canAgentRun()` from its own loop; Creative Claw calls it from an OpenClaw run-start hook so a `user-claimed`/`draining`/ghost-claimed GPU blocks local-LLM runs with a clear reason.

## Components and Interfaces

### Component 1: Ported `GpuBroker` (`extensions/gpu-broker/src/broker.ts`)

Copy `core-node/src/gpu/broker.ts` with minimal edits:
- Replace the `pino` `Logger` type/usage with OpenClaw's logger interface (a `{info,warn,error}` shim; the source already guards `typeof l[level] === "function"`).
- Keep `GpuBrokerOptions`, `GpuState`, `ClaimResult`, the full state machine, the ghost-claim poll, the `nvidia-smi`→`/api/ps` snapshot fallback, and `keep_alive:0` evacuation unchanged.
- No new dependency: `ulid` is already in OpenClaw's tree (used widely); if not, add it (tiny). `fetch`/`AbortSignal.timeout` are Node ≥18 globals OpenClaw targets.

### Component 2: Plugin entry + service registration (`extensions/gpu-broker/index.ts`)

```ts
export default definePluginEntry({
  id: "gpu-broker",
  name: "GPU Broker",
  description: "Cooperative single-GPU VRAM arbitration + Ollama eviction.",
  configSchema, // Req 8
  register(api) {
    const broker = new GpuBroker(resolveConfig(api));      // Req 1.2, 8
    api.registerService({                                   // Req 1.1 — gateway-lifetime
      id: "gpu-broker",
      async start() { await broker.init(); },               // Req 1.3
      async stop() { broker.shutdown(); /* release agent lease */ }, // Req 1.4
    });
    registerGpuTools(api, broker);                          // Req 2
    registerAgentRunGate(api, broker);                      // Req 3
    registerSurfaces(api, broker);                          // Req 9
    api.registerReload(() => broker.applyConfig(resolveConfig(api))); // Req 8.3
  },
});
```

Dormant_Mode (Req 7.2): `resolveConfig` reads OpenClaw's active LLM provider; if non-local, construct the broker with `dormant: true` (the source already no-ops every claim/poll in dormant mode).

### Component 3: GPU tools (`extensions/gpu-broker/src/tools.ts`)

Mirror `gpu.ts` onto `api.registerTool`. The four tools (`gpu.status`, `gpu.release`, `gpu.reclaim`, `gpu.handoff`) keep their exact Polymathes semantics and `zod` schemas. Registered into Creative Claw's **default** tool profile (Req 2.5) — not gated to `minimal`. The broker is captured in the closure (replaces Polymathes' `setGpuBroker` module global).

### Component 4: Agent run gate (`extensions/gpu-broker/src/run-gate.ts`)

Hook OpenClaw's "before agent run" lifecycle (`api.registerHook` / `registerRuntimeLifecycle` — exact event confirmed in OQ1). On run-start: call `broker.canAgentRun()`; if `{ok:false}`, abort/deny the local-LLM run with the broker's reason string (Req 3.1). Dormant and `idle|agent-active` → permit (Req 3.2/3.3).

### Component 5: Warmup recalibration (`extensions/gpu-broker/src/warmup.ts`)

Hook the point where Creative Claw deliberately warms an LLM / loads a creative-engine model (OQ2) and call `broker.recalibrateBaseline()` so the warmed footprint becomes the Baseline (Req 5). If no clean hook exists, expose recalibrate as an internal call the model-load path invokes.

### Component 6: Operator surfaces (`extensions/gpu-broker/src/surfaces.ts`)

`api.registerControlUiDescriptor` (a GPU panel) and/or `api.registerHttpRoute("/gpu/state")` returning `broker.getState()`, plus `api.registerCli("gpu", ...)` for `status/release/reclaim` — all reading live broker state (Req 9).

## Data Models

- **GpuState** (from source): `{ status, owner?, reason?, token?, expires_at?, vram_used_mb?, vram_total_mb?, vram_baseline_mb?, loaded_models?, dormant, history? }`.
- **ClaimResult**: `{ ok, token?, error?, vram_free_mb?, waited_ms? }`.
- **Config (configSchema, Req 8):** `{ ollamaUrl?: string, pollMs?: number, externalClaimThresholdMb?: number, defaultHoldMs?: number, dormant?: boolean }` with the verified defaults (15000ms / 10000MB / 3_600_000ms).

## Correctness Properties

### Property 1: Claim evacuates and waits for real VRAM drop
After `claim` against a reachable Ollama with a resident model, measured VRAM (real source) is ≤ baseline+buffer before the lease is reported granted; a still-resident model means the claim is not reported successful.
**Validates: Requirements 6.1, 6.3**

### Property 2: Lease token integrity
`release(token)` only succeeds for the active token (or `"force"`); a stale/invalid token is rejected; an expired lease auto-releases to `idle`.
**Validates: Requirements 1.2**

### Property 3: Ghost-claim hysteresis
External pressure above threshold → ghost-claim (`owner="external"`); pressure below half-threshold → auto-release; an explicit claim is never overridden by a ghost-claim.
**Validates: Requirements 4.2, 4.3, 4.4**

### Property 4: Agent gate honors claims
`canAgentRun()` is `{ok:false}` while `user-claimed`/`draining`, `{ok:true}` while `idle`/`agent-active`, and always `{ok:true}` in dormant mode.
**Validates: Requirements 3.1, 3.2, 3.3**

### Property 5: Recalibration neutralizes warmup
After `recalibrateBaseline()` following a warmup, the warmed model's footprint does not trigger a ghost-claim.
**Validates: Requirements 5.2, 5.3**

### Property 6: Honest degradation
With `nvidia-smi` absent the snapshot uses `/api/ps`; with both absent it reports zero/empty (not fabricated) and does not crash; dormant reports `dormant:true`.
**Validates: Requirements 7.1, 7.3, 7.4**

> Non-property checks: service is a single gateway-lifetime instance (Req 1.1); the four tools are registered and in the default profile (Req 2); config defaults applied when absent (Req 8.2); operator surface returns live state (Req 9.2).

## Error Handling

| Scenario | Behavior |
|---|---|
| `nvidia-smi` absent | Fall back to Ollama `/api/ps` accounting (Req 7.1). |
| Ollama unreachable on evacuate | "nothing to evacuate," proceed — not an error (Req 6.2). |
| Both nvidia-smi + Ollama absent | Honest zero/empty snapshot, no crash (Req 7.3). |
| Non-local LLM provider | Dormant_Mode; claims no-op success (Req 7.2). |
| `release` with stale token | Rejected with "invalid or stale lease token" (Property 2). |
| Claim while another explicit owner holds | Rejected with "already claimed by <owner>" (source behavior). |
| Gateway shutdown mid-lease | `shutdown()` clears timers; agent-held lease released (Req 1.4). |

## Testing Strategy

Two tiers:
- **Always-runnable (no GPU/Ollama):** state-machine unit tests with a mocked `snapshotGpu`/`fetch` — lease token integrity, ghost-claim hysteresis, agent-gate logic, dormant no-op, recalibration neutralization, config defaults. (Properties 2–6 logic.)
- **GPU/Ollama-gated (skip-with-reason when absent):** real evacuation test — warm an Ollama model, `claim`, assert measured VRAM drops (Property 1, Req 6.3). Never a fake pass: skip with a recorded reason when no GPU/Ollama.

Language: TypeScript (`vitest`, matching OpenClaw). Tests under `extensions/gpu-broker/test/` or the repo's plugin test convention.

## Open Questions — resolved as design decisions

1. **Agent-run hook seam:** Use `api.registerHook` on OpenClaw's run-start event; if no such event exists, fall back to a tool-result/availability middleware that denies local-LLM tools while claimed. Confirm the exact event name against `src/agents/*` in early implementation; the gate logic (`canAgentRun()`) is unchanged regardless of seam.
2. **Warmup recalibration trigger:** Call `recalibrateBaseline()` from the model-load/provider-warm path; if none is cleanly hookable, recalibrate on the first successful agent run after an `idle→agent-active` transition.
3. **Ollama footprint estimate:** Replace the fixed ~5000MB heuristic with summed per-model `size_vram` from `/api/ps` when available (more accurate); keep the heuristic only as a last resort.
4. **Multi-GPU:** v1 targets the single-GPU creative-suite case (first GPU only), matching the source. Multi-GPU deferred.
5. **`gpu.handoff`:** Keep in v1 (it's small and self-contained), but it is inert until a peer gateway exists; documented as such.

## Honesty Ledger

**Real once implemented:** the broker reports VRAM from `nvidia-smi`/`/api/ps` (never hardcoded); `claim` actually evicts Ollama and waits for a measured drop; the agent is genuinely blocked from local-LLM work while the GPU is claimed; dormant/no-GPU degrade honestly.

**Needs validation during implementation:** the exact OpenClaw run-start hook (OQ1); the warmup hook point (OQ2); whether `ulid` is already a dependency.

**Out of scope:** multi-GPU arbitration; rewriting the broker logic (it's ported); the Mneme visual-memory and creative-engine integrations (separate specs).
