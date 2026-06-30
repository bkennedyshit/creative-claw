# Requirements Document

## Introduction

**Creative Claw** is a fork of **OpenClaw** (the lean, plugin-based personal-assistant runtime) into a local-first **creative suite**. The fork composes three things at one architecture level — OpenClaw is the spine, and two organs from **Polymathes** (the maintainer's content-creator agent) are transplanted in: its **visual memory (Mneme)** and its **GPU/VRAM broker**. This spec covers the **GPU broker**.

The problem it solves is specific to running a creative suite on one machine with one GPU: the agent's LLM, the user's editing/render tools (DaVinci Resolve, etc.), the local diffusion/upscale models, and the compiled C++ creative engines all want VRAM, and they collide. Polymathes already solved this with a **cooperative GPU broker** (`core-node/src/gpu/broker.ts`): it tracks a VRAM baseline, evicts resident Ollama models on demand (`keep_alive: 0`), hands out lease tokens, auto-detects external VRAM pressure (the user opening Resolve) and takes a "ghost claim" so the agent backs off, then auto-releases when pressure drops. OpenClaw has **no equivalent** — it loads models and never coordinates VRAM with anything else.

Because both OpenClaw and the Polymathes broker are **TypeScript**, this is a near drop-in port, not a rewrite. The broker (`broker.ts`) is a single self-contained class whose only dependencies are `node:child_process` (for `nvidia-smi`), `ulid`, and a `pino`-style logger — all available in OpenClaw. The accompanying tool surface (`core-node/src/tools/builtin/gpu.ts`) registers `gpu.status` / `gpu.release` / `gpu.reclaim` / `gpu.handoff` against Polymathes' tool registry; in Creative Claw these become OpenClaw agent tools registered through the plugin `api.registerTool(...)` seam.

This feature delivers the broker as a **native OpenClaw code plugin** under `extensions/gpu-broker/` (manifest `openclaw.plugin.json` + `index.ts` via `definePluginEntry`). It:
- ports the `GpuBroker` class verbatim-with-adaptation (keep the proven logic; swap the logger/config wiring to OpenClaw's),
- registers it as a long-lived **service** (`api.registerService`) so a single broker instance runs for the gateway's lifetime (not per-session),
- exposes the four GPU tools through `api.registerTool`,
- hooks the agent run lifecycle so the agent honors an active user/external claim (does not fire LLM calls into a GPU the user has claimed),
- and recalibrates its VRAM baseline after deliberate model warmups so a warmed model is not mistaken for external pressure.

Grounded in the verified source:
- `broker.ts` is **self-contained** (`spawnSync("nvidia-smi", ...)`, `fetch(ollama/api/ps)`, `fetch(ollama/api/generate, keep_alive:0)`). States: `idle | agent-active | user-claimed | draining | dormant`. It already supports a **dormant** mode (cloud LLM → nothing to arbitrate) and falls back to Ollama's `/api/ps` VRAM accounting when `nvidia-smi` is absent (AMD/Apple/no-GPU hosts).
- `gpu.ts` already defines the exact tool contract (`gpu.status`, `gpu.release`→claim-on-behalf, `gpu.reclaim`→release token, `gpu.handoff`→evacuate-then-delegate-to-peer). The Mneme Python server (`mneme/src/mneme/server.py`) exposes the same surface as `gpu_status`/`gpu_release`/`gpu_reclaim`/`gpu_evacuate`, confirming the contract is stable across implementations.
- OpenClaw's plugin API (`src/plugins/api-builder.ts`) provides `registerService`, `registerTool`, `registerHook`/`registerRuntimeLifecycle`, `registerCli`, `registerControlUiDescriptor` — every seam this port needs.

The requirements below cover: porting the broker as a gateway-lifetime service; the four GPU tools; agent-lifecycle gating (honor active claims); external-pressure detection + ghost-claim/auto-release; baseline recalibration after warmup; the dormant/no-GPU degradations; configuration; and verification that VRAM is genuinely evicted (not just reported).

## Glossary

- **Creative_Claw**: The OpenClaw fork being built — the creative suite. OpenClaw is the runtime spine.
- **Gpu_Broker**: The ported `GpuBroker` class that arbitrates single-GPU access (from Polymathes `core-node/src/gpu/broker.ts`).
- **Lease**: A time-bounded hold on the GPU identified by a `token` (ULID). Granted by `claim`, ended by `release(token)` or expiry.
- **Claim**: Taking the GPU for a named owner; evacuates resident Ollama models and waits for VRAM to drop to `baseline + buffer` before granting the lease.
- **Ghost_Claim**: A claim the broker takes automatically with `owner="external"` when it detects VRAM pressure above threshold that it did not cause (e.g. the user opened a video editor). Auto-released when pressure drops.
- **Baseline**: The VRAM-used measurement the broker treats as "normal," set at init and re-set by Recalibration. External pressure is measured relative to it.
- **Recalibration**: Re-measuring the Baseline after a deliberate model warmup so the warmed model is not counted as external pressure.
- **Evacuation**: Firing `keep_alive: 0` at every resident Ollama model so they unload from VRAM immediately.
- **Dormant_Mode**: The broker disabled because the active LLM provider is non-local (cloud) — there is nothing local to arbitrate; all claims are no-op successes.
- **GPU_Tool**: One of the agent-callable tools `gpu.status` / `gpu.release` / `gpu.reclaim` / `gpu.handoff`.
- **Plugin_Service**: A gateway-lifetime singleton registered via `api.registerService`, as opposed to a per-session object.
- **Agent_Run_Gate**: The pre-run check (`canAgentRun()`) that prevents the agent from issuing local-LLM work while the GPU is user-claimed/draining.

## Requirements

### Requirement 1: Port the GPU broker as a gateway-lifetime service

**User Story:** As the runtime, I want one broker instance alive for the whole gateway, so GPU state is coherent across all sessions and channels.

#### Acceptance Criteria

1. THE feature SHALL register the Gpu_Broker as a Plugin_Service via `api.registerService` so exactly one instance exists for the gateway lifetime (not one per session/agent run).
2. THE ported Gpu_Broker SHALL preserve the verified state machine (`idle | agent-active | user-claimed | draining | dormant`), the lease-token model, and the auto-expiry hold timer from the Polymathes source, changing only the logger/config wiring to OpenClaw's.
3. WHEN the gateway starts, THE Gpu_Broker SHALL initialize its Baseline from a current VRAM snapshot and begin its poll loop (unless Dormant_Mode applies).
4. WHEN the gateway shuts down, THE Gpu_Broker SHALL clear its timers and release any active agent-held lease.
5. THE Gpu_Broker SHALL depend only on `node:child_process` (`nvidia-smi`), `fetch` (Ollama HTTP), `ulid`, and an OpenClaw logger — no new heavy dependency.

### Requirement 2: Expose the four GPU tools to the agent

**User Story:** As the agent, I want to check, release, reclaim, and hand off the GPU, so I can cooperate with the user's GPU-heavy work and with the C++ engines.

#### Acceptance Criteria

1. THE feature SHALL register `gpu.status` via `api.registerTool`, returning the broker state (status, owner, VRAM used/total/baseline, loaded models, recent lease history).
2. THE feature SHALL register `gpu.release` that evacuates resident Ollama models and takes a lease on behalf of a named handoff (returning a lease token), so VRAM is freed for the user/engine.
3. THE feature SHALL register `gpu.reclaim` that ends a prior lease by its token, returning control to the agent (LLM lazy-reloads on the next turn).
4. THE feature SHALL register `gpu.handoff` that evacuates the GPU, fires a task at a peer agent gateway over HTTP, and reclaims on return (preserving the Polymathes behavior).
5. THE GPU_Tools SHALL be available in Creative_Claw's default tool profile (not hidden behind the `minimal` profile), since GPU cooperation is core to the creative suite.

### Requirement 3: Gate agent runs on GPU availability

**User Story:** As the user, when I've claimed the GPU for editing, I don't want the agent loading an LLM into VRAM and fighting me for it.

#### Acceptance Criteria

1. WHEN an agent run is about to start AND the Gpu_Broker reports `user-claimed` or `draining`, THE feature SHALL prevent the local-LLM run and surface a clear reason (who holds the GPU and why), via the Agent_Run_Gate (`canAgentRun()`).
2. WHEN the GPU is `idle` or `agent-active`, THE Agent_Run_Gate SHALL permit the run.
3. WHERE the active LLM provider is non-local (Dormant_Mode), THE Agent_Run_Gate SHALL always permit the run (nothing to arbitrate).
4. THE Agent_Run_Gate SHALL hook OpenClaw's agent run lifecycle (`registerHook`/`registerRuntimeLifecycle`/run-start seam) rather than being bolted onto each tool.

### Requirement 4: External VRAM pressure detection and ghost-claim

**User Story:** As the user, when I open my video editor without telling the agent, I want the agent to notice and step off the GPU automatically.

#### Acceptance Criteria

1. THE Gpu_Broker SHALL poll the GPU on an interval and compute external pressure as `used - baseline - (estimated Ollama footprint)`.
2. WHEN external pressure exceeds the configured threshold AND no explicit claim is held, THE Gpu_Broker SHALL take a Ghost_Claim (`owner="external"`) so the Agent_Run_Gate blocks agent LLM work.
3. WHEN external pressure drops back below half the threshold WHILE a Ghost_Claim is held, THE Gpu_Broker SHALL auto-release the Ghost_Claim and return to `idle`.
4. THE Gpu_Broker SHALL NOT override an explicit user/agent claim with a Ghost_Claim (an explicit claim wins).

### Requirement 5: Baseline recalibration after deliberate warmup

**User Story:** As the runtime, after I deliberately warm a model, I don't want that model counted as external pressure.

#### Acceptance Criteria

1. THE Gpu_Broker SHALL expose a recalibrate operation that re-measures the Baseline from a current snapshot.
2. WHEN Creative_Claw deliberately warms an LLM or loads a creative-engine model, THE feature SHALL call recalibrate so the new resident footprint becomes the normal Baseline.
3. WHEN recalibration runs, THE Gpu_Broker SHALL update its loaded-models snapshot and SHALL NOT treat the just-warmed model as a Ghost_Claim trigger.

### Requirement 6: Evacuation genuinely frees VRAM (anti-fake)

**User Story:** As a reviewer, I want proof the broker actually unloads models, not just reports that it did.

#### Acceptance Criteria

1. WHEN `gpu.release` / evacuation runs against a reachable Ollama with resident models, THE Gpu_Broker SHALL issue `keep_alive: 0` to every resident model and SHALL wait until measured VRAM drops to `baseline + buffer` (or a timeout) before reporting the lease granted.
2. WHEN evacuation cannot reach Ollama, THE Gpu_Broker SHALL treat it as "nothing to evacuate" (not an error) and proceed.
3. THE feature SHALL include a test that, against a reachable Ollama with a resident model, asserts VRAM measurably drops after evacuation (skip-with-reason when no GPU/Ollama is present — never a fake pass).
4. THE Gpu_Broker SHALL report VRAM figures from a real source (`nvidia-smi`, or Ollama `/api/ps` accounting as the documented fallback), never a hardcoded value.

### Requirement 7: Degradations — no GPU, no Ollama, cloud LLM

**User Story:** As a user on a non-NVIDIA / cloud-LLM / no-Ollama setup, I want Creative Claw to run without the broker breaking anything.

#### Acceptance Criteria

1. WHERE `nvidia-smi` is absent, THE Gpu_Broker SHALL fall back to Ollama `/api/ps` VRAM accounting and still function (degraded), per the verified source behavior.
2. WHERE the active LLM provider is non-local, THE Gpu_Broker SHALL enter Dormant_Mode and all claims SHALL be no-op successes.
3. WHERE Ollama is unreachable AND `nvidia-smi` is absent, THE Gpu_Broker SHALL report an honest empty/zero snapshot and SHALL NOT crash the gateway.
4. THE GPU_Tools SHALL return honest state in every degradation (e.g. `dormant: true`), never fabricated VRAM numbers.

### Requirement 8: Configuration

**User Story:** As an operator, I want to tune the broker without editing code.

#### Acceptance Criteria

1. THE plugin SHALL expose a `configSchema` (in `openclaw.plugin.json` / via the plugin config) for: Ollama base URL, poll interval, external-claim threshold (MB), default lease hold duration, and a dormant override.
2. WHEN a config value is absent, THE Gpu_Broker SHALL use the verified Polymathes defaults (poll 15s, threshold 10000MB, hold 1h).
3. WHEN configuration changes via OpenClaw's reload seam, THE Gpu_Broker SHALL apply the new values without requiring a full gateway restart where feasible (`registerReload`).

### Requirement 9: Surface broker state to the operator

**User Story:** As an operator, I want to see GPU/lease state and recent events.

#### Acceptance Criteria

1. THE feature SHALL expose broker state (status, owner, VRAM, loaded models, last lease events) through a Control UI descriptor and/or an HTTP route (`api.registerControlUiDescriptor` / `api.registerHttpRoute`), and/or a CLI command (`api.registerCli`).
2. THE surfaced state SHALL reflect live broker state (the same data `gpu.status` returns), not a cached snapshot.

## Open Questions

1. **Agent-run hook seam.** Confirm the exact OpenClaw lifecycle hook for "before an agent run starts" to wire the Agent_Run_Gate (`registerHook` event name vs `registerRuntimeLifecycle` vs a run-start middleware). The analysis cites `src/agents/*` + `registerHook`; verify the precise event during design/early implementation.
2. **Warmup recalibration trigger.** Identify where OpenClaw deliberately warms a model (provider load / first turn) so Requirement 5's recalibrate is called at the right moment, not on every snapshot.
3. **Ollama footprint estimate.** The Polymathes poll uses a rough fixed Ollama footprint (~5000MB) to subtract resident-model VRAM from external pressure. Decide whether to keep the heuristic or read per-model `size_vram` from `/api/ps` for accuracy.
4. **Multi-GPU.** The source takes only the first GPU. Confirm single-GPU is the target for v1 (the creative-suite use case) and defer multi-GPU.
5. **`gpu.handoff` scope.** The peer-agent handoff is a Polymathes feature; confirm it stays in v1 of Creative Claw or is deferred (it needs a peer gateway to target).
