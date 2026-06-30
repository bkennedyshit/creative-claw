# OpenClaw → Creative Suite: Integration Analysis

Scope: read-only architectural map answering two integration questions for a fork of OpenClaw
(package `openclaw`, v2026.6.10) into a creative suite. All paths below are repo-root-relative.

---

## 1. Architecture overview

### 1.1 Monorepo layout (pnpm workspace)

`pnpm-workspace.yaml` declares four package roots:

```
packages:
  - .            # the core `openclaw` package (src/, compiled to dist/)
  - ui           # Control UI
  - packages/*   # shared libraries (memory-host-sdk, model-catalog-core, normalization-core, gateway-protocol, plugin-sdk, ...)
  - extensions/* # bundled plugins (providers, channels, memory backends, media engines)
```

- Entry launcher: `openclaw.mjs` (Node version gate + compile-cache respawn) → imports `dist/entry.js` (built from `src/entry.ts`).
- Core TS: `src/`. Plugins: `extensions/*`. Plugin SDK facade: `src/plugin-sdk/*` (re-exported publicly as the `openclaw/plugin-sdk/*` subpath exports listed in `package.json`).
- The product is a "Gateway" control plane + an assistant loop; channels (Telegram/Slack/etc.) are transport plugins under `extensions/`.
- Storage rule (from `AGENTS.md`): SQLite-only for runtime state (shared `state/openclaw.sqlite`; per-agent `agents/<id>/agent/openclaw-agent.sqlite`). No JSON/JSONL sidecars for OpenClaw-owned state.

### 1.2 Plugin system (the primary extension surface)

`VISION.md` is explicit: "Core stays lean; optional capabilities should usually ship as plugins." Two plugin styles:
- **Code plugins** — run plugin code, deeper runtime hooks (providers, tools, channels).
- **Bundle-style plugins** — package stable external surfaces (skills, **MCP servers**, config). Preferred when sufficient.

Plugin entry contract: `src/plugin-sdk/plugin-entry.ts` → `definePluginEntry({ id, name, description, kind?, configSchema?, register(api) })`.
Channel plugins instead use `defineChannelPluginEntry` from `openclaw/plugin-sdk/core`.

Each plugin ships a manifest `openclaw.plugin.json` (id, `activation`, `kind`, `contracts`, `configSchema`, `uiHints`, provider metadata) plus an `index.ts` default export from `definePluginEntry`.

The `api` object passed to `register(api)` is built in `src/plugins/api-builder.ts` and is the **canonical capability registry**. Notable registration methods (full list in `api-builder.ts` `BuildPluginApiParams.handlers`):

- Tools: `api.registerTool(factory, { names })`, `registerToolMetadata`, `registerTrustedToolPolicy`, `registerAgentToolResultMiddleware`
- Commands / CLI / HTTP: `registerCommand`, `registerCli`, `registerNodeCliFeature`, `registerHttpRoute`, `registerGatewayMethod`
- Services / lifecycle: `registerService`, `registerRuntimeLifecycle`, `registerReload`, `registerHook`, `registerSessionExtension`, `registerSessionAction`, `registerControlUiDescriptor`
- Media generation: `registerImageGenerationProvider`, `registerVideoGenerationProvider`, `registerMusicGenerationProvider`, `registerMediaUnderstandingProvider`
- Memory: `registerMemoryCapability`, `registerMemoryEmbeddingProvider`, `registerMemoryPromptSection`, `registerMemoryFlushPlan`, `registerMemoryRuntime`
- Providers / catalog: `registerProvider`, `registerModelCatalogProvider`, `registerEmbeddingProvider`

Loader/registry internals live in `src/plugins/` (`loader.ts`, `registry.ts`, `manifest-registry.ts`, `runtime/`, `slots.ts`, `tools.ts`).

### 1.3 Tool execution + the agent loop

- Tool descriptors / execution: `src/tools/{descriptors.ts,execution.ts,protocol.ts,types.ts,index.ts,availability.ts}`.
- Plugin-registered tools become agent tools via `src/plugins/tools.ts` (`resolvePluginTools`, `ensureStandalonePluginToolRegistryLoaded`, `PluginToolMeta`/`PluginToolMcpMeta`). Tool policy (allow/deny, profiles `minimal|coding|messaging`) is applied here and in `src/agents/tool-policy.ts`.
- Agents: `src/agents/*` (run terminal outcome, sandbox tool policy, MCP materialization).

### 1.4 MCP surfaces (three distinct ones — do not conflate)

From `docs/cli/mcp.md` and code:

1. **OpenClaw as MCP server** (`openclaw mcp serve`): exposes channel conversations. Bridge code: `src/mcp/channel-*.ts`, `src/mcp/openclaw-tools-serve.ts`.
2. **OpenClaw exposes its own plugin tools over MCP**: `src/mcp/plugin-tools-serve.ts` (`createPluginToolsMcpServer`), `src/mcp/tools-stdio-server.ts`.
3. **OpenClaw as MCP client/registry** (consumes external MCP servers) — this is the seam for the creative engines. Config lives under `mcp.servers.<name>` in `openclaw.json`. Managed via `openclaw mcp add|set|configure|tools|probe|doctor`. At runtime the saved servers are merged with plugin-declared bundle MCP servers and **materialized into agent tools**:
   - `src/agents/embedded-agent-mcp.ts` → `loadEmbeddedAgentMcpConfig` → `src/agents/bundle-mcp-config.ts` `loadMergedBundleMcpConfig`.
   - `src/agents/agent-bundle-mcp-materialize.ts` → `createBundleMcpToolRuntime`, `materializeBundleMcpToolsForRun` (per-session `SessionMcpRuntime`, idle-reaped per `mcp.sessionIdleTtlMs`).
   - Plugin-declared MCP servers: `src/plugins/bundle-mcp.ts` (`loadEnabledBundleMcpConfig`, `inspectBundleMcpRuntimeSupport`, `BundleMcpServerConfig`). A plugin/bundle declares servers via a `.mcp.json` at its root or inline `mcpServers` in its bundle manifest; stdio (`command`/`args`/`env`/`cwd`) and HTTP/SSE transports are supported.
   - External MCP tools surface to the agent namespaced as `<server>__<tool>` and are gated by `tools.deny: ["bundle-mcp"]`, per-server `toolFilter.include/exclude`, and tool profiles (hidden in `minimal`).

---

## 2. Vision-memory integration

### 2.1 How memory works today

Memory is a **mutually-exclusive plugin slot** — only one memory plugin is active at a time (`VISION.md`: "Memory is a special plugin slot where only one memory plugin can be active"). Mechanics:

- Slot selection: `src/plugins/slots.ts` — `SLOT_BY_KIND = { memory: "memory", "context-engine": "contextEngine" }`, default `memory-core`. A plugin claims the slot via manifest `"kind": "memory"`.
- Slot resolution at runtime: `src/plugins/memory-runtime.ts` — `resolveMemoryRuntimePluginIds` reads `config.plugins.slots.memory`; `getActiveMemorySearchManager`, `resolveActiveMemoryBackendConfig`, `closeActiveMemorySearchManager(s)`.
- Capability registration: `api.registerMemoryCapability({ promptBuilder, flushPlanResolver, runtime, publicArtifacts })` (state in `src/plugins/memory-state.ts` `registerMemoryCapability`).
- Memory tools registered through normal `api.registerTool(...)`.

Two reference implementations:
- `extensions/memory-core/` — default, file-backed (`MEMORY.md` + `memory/*.md`), tools `memory_search` / `memory_get`, manifest `kind: "memory"`, `index.ts` calls `api.registerMemoryCapability({...})`, `api.registerTool(...)`, `api.registerCli(...)`.
- `extensions/memory-lancedb/` — **the vector-store reference**: LanceDB connection (`MemoryDB` with `vectorSearch().limit().toArray()`), embeddings via `MemoryEmbeddingProvider` (`ProviderAdapterEmbeddings` / `OpenAiCompatibleEmbeddings`), auto-capture/auto-recall lifecycle hooks, tools `memory_recall` / `memory_store` / `memory_forget` (manifest `contracts.tools`), `configSchema` with `embedding.{provider,model,dimensions,apiKey,baseUrl}` + `dbPath` + `storageOptions`.

Embedding-provider seam (reusable for image embeddings): `api.registerMemoryEmbeddingProvider(...)`, types in `openclaw/plugin-sdk/memory-core-host-engine-embeddings` (`MemoryEmbeddingProvider` with `embedQuery`), host helpers `src/memory-host-sdk/` (`engine-storage.ts`, `engine-qmd.ts`, `query.ts`, `dreaming.ts`, `events.ts`, `multimodal.ts`).

### 2.2 Multimodal memory already exists (partial)

`src/memory-host-sdk/multimodal.ts` re-exports `packages/memory-host-sdk/src/host/multimodal.ts`, which already defines:
- `MEMORY_MULTIMODAL_SPECS` with an **`image`** modality (`.jpg/.jpeg/.png/.webp/.gif/.heic/.heif`) and `audio`.
- `MemoryMultimodalSettings { enabled, modalities, maxFileBytes }`, `isMemoryMultimodalEnabled`, `classifyMemoryMultimodalPath`, `buildMemoryMultimodalLabel`, `normalizeMemoryMultimodalSettings`.

So the host SDK can already classify/ingest image files into the active memory plugin as labeled content — but recall is text/embedding driven; there is no image-embedding similarity recall today.

### 2.3 How image input is handled today

`src/media-understanding/` is the inbound image/vision pipeline:
- `attachments.ts`, `attachments.normalize.ts`, `attachments.select.ts`, `image.ts`, `image-input-normalize.ts`, `image-runtime.ts`, `extracted-file-images.ts`.
- `runner.ts` / `runner.attachments.ts` route attachments to a `registerMediaUnderstandingProvider` implementation (e.g. `openai`, `google`).
- Inbound media is offloaded by the Gateway claim-check and annotated in transcript text as `[media attached: ...]` (see `memory-lancedb/index.ts` `MEDIA_ATTACHED_PATTERN` handling — memory deliberately strips these so old memories are not re-read as live media).
- Outbound/generated media + media store: `src/media/`, `openclaw/plugin-sdk/media-store`, `media-generation-runtime`.

### 2.4 Recommended insertion point for vision memory

Cleanest approach: ship a **new memory-slot plugin** `extensions/memory-vision/` (code plugin, manifest `"kind": "memory"`), modeled on `extensions/memory-lancedb/`. It would:

1. Own the memory slot (`config.plugins.slots.memory = "memory-vision"`; selection enforced by `src/plugins/slots.ts` `applyExclusiveSlotSelection`).
2. Call `api.registerMemoryCapability({ runtime, promptBuilder, flushPlanResolver, publicArtifacts })` and register tools `vision_recall` / `vision_store` via `api.registerTool` (declare them in manifest `contracts.tools`).
3. Store **image embeddings** in a vector table (reuse the LanceDB `MemoryDB` pattern, or a dedicated SQLite + `sqlite-vec` schema — `sqlite-vec` is already an allowed dependency in `pnpm-workspace.yaml`). Per `AGENTS.md` storage rules, prefer a dedicated SQLite schema or the LanceDB precedent over JSON sidecars.
4. Produce image embeddings via the embedding-provider seam: register a CLIP/image embedding adapter through `api.registerMemoryEmbeddingProvider(...)` (contract `MemoryEmbeddingProvider` in `openclaw/plugin-sdk/memory-core-host-engine-embeddings`), or call the creative image engine directly.
5. Capture images by hooking the existing media pipeline: consume normalized attachments from `src/media-understanding/attachments.normalize.ts` (the same `[media attached: ...]` claim-check artifacts), and/or extend the multimodal `image` modality already in `packages/memory-host-sdk/src/host/multimodal.ts` to drive similarity recall rather than text labels.

Key integration files/interfaces a developer will implement against:
- `src/plugins/memory-state.ts` — `registerMemoryCapability`, `MemoryPluginCapability`, `MemoryPluginRuntime`.
- `src/plugins/memory-runtime.ts` — `getActiveMemorySearchManager`, slot resolution.
- `src/plugins/slots.ts` — exclusive slot wiring (`kind: "memory"`).
- `packages/memory-host-sdk/src/host/multimodal.ts` — image modality classification (extend for recall).
- `openclaw/plugin-sdk/memory-core-host-engine-embeddings` — `MemoryEmbeddingProvider` for image embeddings.
- `extensions/memory-lancedb/{index.ts,config.ts,openclaw.plugin.json}` — copy-from template (vector store + auto-capture/recall hooks + manifest shape).
- `src/media-understanding/attachments.normalize.ts`, `image-runtime.ts` — inbound image source.

Tradeoff to flag: the single-memory-slot constraint means vision memory cannot run *alongside* `memory-core`/`memory-lancedb` unless you build it as a combined backend or move the visual index behind the `registerMemoryCorpusSupplement` / `registerMemoryPromptSupplement` companion seam (see `memory-state.ts`), which lets a non-slot plugin add a supplementary corpus without claiming the slot. That supplement path is the better fit if text memory must stay on `memory-core` while vision memory is additive.

---

## 3. Creative-frameworks integration (4 engines + node-graph)

The 4 engines each expose: an **MCP server** + a by-name dispatcher (`list_ops` / `op_info` / `apply_op`) over a compiled C++ engine, plus a node-graph executor.

### 3.1 How an external MCP server is registered/consumed today

- **As saved config (operator path):** `openclaw mcp add <name> --command ... --arg ...` writes `mcp.servers.<name>` (stdio: `command/args/env/cwd`; or HTTP/SSE: `url/transport/headers/auth`). See `docs/cli/mcp.md`. Tool filtering via `openclaw mcp tools <name> --include/--exclude`.
- **As plugin-declared servers (product path):** a bundle/plugin ships `.mcp.json` at its root or inline `mcpServers` in its bundle manifest; `src/plugins/bundle-mcp.ts` (`loadEnabledBundleMcpConfig`, `extractMcpServerMap`, `absolutizeBundleMcpServer`) loads them, `inspectBundleMcpRuntimeSupport` validates stdio support.
- **Materialization into agent tools (runtime):** `src/agents/embedded-agent-mcp.ts` `loadEmbeddedAgentMcpConfig` → `src/agents/bundle-mcp-config.ts` `loadMergedBundleMcpConfig` (merges saved `mcp.servers` + plugin bundle servers) → `src/agents/agent-bundle-mcp-materialize.ts` `createBundleMcpToolRuntime` / `materializeBundleMcpToolsForRun` spins up per-session `SessionMcpRuntime` clients (stdio/HTTP via `@modelcontextprotocol/sdk`), lists tools, and exposes them as `<server>__<tool>` agent tools. Idle runtimes reaped after `mcp.sessionIdleTtlMs`.
- Tool gating: `tools.deny: ["bundle-mcp"]`, per-server `toolFilter`, tool profiles (`minimal` hides MCP tools).

### 3.2 How skills/extensions are structured and loaded

- **Skills**: `~/.openclaw/workspace/skills/<skill>/SKILL.md` (README). Core skill subsystem: `src/skills/` (`discovery/`, `loading/`, `lifecycle/`, `runtime/`, `config/`, `types.ts`). Bundled skills also live in repo `skills/`. New skills are meant to go through ClawHub, not core (`VISION.md`).
- **Extensions (plugins)**: `extensions/<id>/` with `openclaw.plugin.json` + `index.ts` (`definePluginEntry`/`defineChannelPluginEntry`). Loaded by `src/plugins/loader.ts` + `manifest-registry.ts`; bundled-plugin discovery via `bundled-sources.ts`/`bundled-plugin-scan.ts`. In a source checkout, `extensions/*` load directly (README "From source").

### 3.3 Recommended insertion point for the 4 engines

There are two viable seams; pick per engine surface:

**Option A — Bundle-style MCP plugins (recommended for the engines' MCP servers).**
Create one bundle plugin per engine (or one umbrella plugin) under `extensions/creative-<image|audio|video|vector>/` whose `openclaw.plugin.json` declares the engine's MCP server (stdio `command` pointing at the compiled C++ engine binary, or HTTP if the engine serves HTTP) via inline `mcpServers` / `.mcp.json`. OpenClaw then auto-materializes `list_ops` / `op_info` / `apply_op` as `creativeImage__apply_op` etc. through `src/agents/agent-bundle-mcp-materialize.ts`. This is the lowest-friction path and matches `VISION.md`'s "prefer bundle-style plugins" guidance. Files to implement against: `src/plugins/bundle-mcp.ts`, manifest `mcpServers`, `docs/cli/mcp.md` config shape. The dispatcher trio maps naturally onto MCP tools, so no custom tool code is required.

**Option B — Code plugin with media-generation providers + tools (recommended for deeper UX + the node-graph surface).**
Use `extensions/comfy/` as the closest precedent: ComfyUI is a compiled/external workflow engine wired in via `definePluginEntry` calling `api.registerImageGenerationProvider`, `api.registerMusicGenerationProvider`, `api.registerVideoGenerationProvider`, plus `api.registerProvider` for auth, with a `workflow-runtime.ts` executing node graphs and manifest `configSignals` describing workflow/node-id config (`promptNodeId`, `workflowPath`, etc.). Map the 4 engines onto:
- image engine → `registerImageGenerationProvider` (+ `registerMediaUnderstandingProvider` if it analyzes)
- audio engine → `registerMusicGenerationProvider` / `registerSpeechProvider`
- video engine → `registerVideoGenerationProvider`
- vector engine → `registerTool` (custom ops) and/or `registerMemoryEmbeddingProvider` (ties into Question 1)
The **node-graph "creative" surface** maps onto a `workflow-runtime.ts`-style executor (see `extensions/comfy/workflow-runtime.ts`) exposed either as custom `api.registerTool` ops (`list_ops`/`op_info`/`apply_op`) or as a Control UI surface via `api.registerControlUiDescriptor` + `api.registerHttpRoute`.

**Recommended combination:** declare each engine's MCP server through a bundle plugin (Option A) so `apply_op`/`list_ops`/`op_info` are agent-callable with zero glue, and add a thin code plugin (Option B, comfy-style) only where you need media-generation provider integration, auth wizards, or a node-graph Control UI surface. Engine binaries should be spawned as MCP stdio child processes (torn down as a process tree on shutdown per `docs/cli/mcp.md`), not linked into core.

Key files/interfaces:
- `src/plugins/bundle-mcp.ts`, `src/agents/agent-bundle-mcp-materialize.ts`, `src/agents/embedded-agent-mcp.ts`, `src/agents/bundle-mcp-config.ts` — external MCP consumption.
- `extensions/comfy/{index.ts,workflow-runtime.ts,openclaw.plugin.json}` — compiled-engine + node-graph + provider template.
- `src/plugins/api-builder.ts` — the full `register*` surface (image/video/music/tool/command/http/controlUi/service).
- `src/plugins/tools.ts`, `src/tools/*` — how registered tools reach the agent loop.
- `src/skills/*` — if creative workflows ship as SKILL.md guidance.

---

## 4. Open questions / risks

1. **Single memory slot.** Only one `kind: "memory"` plugin is active (`src/plugins/slots.ts`). Vision memory either replaces `memory-core`/`memory-lancedb`, is built as a combined backend, or rides the `registerMemoryCorpusSupplement`/`registerMemoryPromptSupplement` companion path (additive, non-exclusive). Decide early.
2. **Image-embedding provider.** `MemoryEmbeddingProvider` is text-oriented (`embedQuery(text)`). Image-similarity recall needs a CLIP-style adapter; confirm the contract accepts image inputs or extend it. `sqlite-vec` is already an allowed dep — usable for a dedicated vector schema.
3. **Storage policy.** `AGENTS.md` mandates SQLite for runtime state; `memory-lancedb` is the sanctioned exception (its own vector store). A new vision index should follow LanceDB precedent or a dedicated SQLite+`sqlite-vec` schema, never JSON sidecars.
4. **MCP server lifecycle / sandboxing.** Materialized MCP runtimes are per-session and idle-reaped (`mcp.sessionIdleTtlMs`); long-running C++ engines may not suit per-session spawn. Consider a long-lived HTTP MCP transport instead of stdio, or a persistent service via `api.registerService`. Note the stdio env safety filter (`NODE_OPTIONS`, `PYTHONPATH`, etc. are blocked) in `docs/cli/mcp.md`.
5. **Tool namespace + profiles.** Engine ops surface as `<server>__<op>` and are hidden under the `minimal` profile and gated by `tools.deny: ["bundle-mcp"]`. The fork likely wants creative ops in default profiles — review `src/agents/tool-policy.ts` and tool-profile defaults.
6. **Untrusted-input boundary.** OpenClaw treats inbound DMs/media as untrusted and the memory layer aggressively strips transport/envelope sludge (`memory-lancedb/index.ts`). A vision-memory ingest path must apply the same sanitization to avoid storing prompt-injection payloads embedded in image metadata/captions.
7. **Node-graph surface ownership.** There is no first-class "node graph" core concept; `extensions/comfy/workflow-runtime.ts` is the only precedent and is provider-internal. A shared creative node-graph surface would be net-new (custom tools + optional Control UI), so it cannot rely on an existing core seam beyond `registerTool` / `registerControlUiDescriptor` / `registerHttpRoute`.
8. **Fork vs. plugin distribution.** `VISION.md` sets a high bar for core additions and steers optional capability to plugins/ClawHub. Since this is a fork into a creative suite, the creative engines can be bundled in `extensions/` and enabled-by-default (like `comfy`'s `enabledByDefault: true`), avoiding the upstream contribution bar entirely.
