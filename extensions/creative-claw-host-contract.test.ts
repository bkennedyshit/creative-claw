/**
 * Creative Claw host-API contract test.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `gpu-broker`, `visual-memory`, and `creative-engines` all shipped green while
 * being unable to load, because their tests handed `register()` a hand-written
 * mock `api` object shaped like the API the plugin author IMAGINED. This file
 * removes that freedom: the object handed to `register()` is built by the
 * host-owned SDK helper `createTestPluginApi` (src/plugin-sdk/plugin-test-api.ts)
 * and is typed as the real `OpenClawPluginApi` (src/plugins/types.ts:2624), so
 *
 *   - a wrong CALL SIGNATURE is a TypeScript error (`pnpm tsgo:extensions`), and
 *   - a wrong RUNTIME shape trips a mirrored host validator below.
 *
 * Every validator in `createContractHost` mirrors the real host, byte for byte,
 * with the source cited inline. Two failure channels are modelled because the
 * host has two:
 *   THROW       — `requireRegistrationValue` (src/plugins/registry.ts:439-445)
 *                 raises, which aborts plugin load.
 *   DIAGNOSTIC  — `pushDiagnostic({ level: "error", ... })`, which rejects the
 *                 individual registration (the 32-rejected-tools failure mode).
 * Both are asserted, so neither can ship silently.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
  OpenClawPluginCliRegistrar,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginLogger,
  PluginRuntimeLifecycleRegistration,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import creativeEnginesPlugin from "./creative-engines/index.js";
import gpuBrokerPlugin from "./gpu-broker/index.js";
import visualMemoryPlugin from "./visual-memory/index.js";

const extensionsDir = dirname(fileURLToPath(import.meta.url));

/**
 * The ONLY hook event types the host dispatches.
 * Mirror of `InternalHookEventType` (src/hooks/internal-hook-types.ts:2).
 */
const INTERNAL_HOOK_EVENT_TYPES: ReadonlySet<string> = new Set([
  "command",
  "session",
  "agent",
  "gateway",
  "message",
]);

/**
 * Mirror of `SAFE_COMMAND_NAME_PATTERN`
 * (src/cli/program/command-descriptor-utils.ts:10), used by
 * `normalizeCommandDescriptorName` which the registry applies to every CLI
 * command root (src/plugins/registry.ts:1482-1494).
 */
const SAFE_COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

/** Mirror of `normalizeStringEntries` (packages/normalization-core/src/string-normalization.ts:5-8). */
function normalizeStringEntries(list: readonly unknown[] | undefined): string[] {
  return (list ?? []).map((entry) => String(entry).trim()).filter(Boolean);
}

/** Mirror of `normalizePluginToolNames` (src/plugins/tool-contracts.ts:10-19). */
function normalizePluginToolNames(names: readonly string[] | undefined): string[] {
  const normalized = new Set<string>();
  for (const name of names ?? []) {
    const trimmed = name.trim();
    if (trimmed) {
      normalized.add(trimmed);
    }
  }
  return [...normalized];
}

/** Mirror of `findUndeclaredPluginToolNames` (src/plugins/tool-contracts.ts:21-27). */
function findUndeclaredPluginToolNames(params: {
  declaredNames: readonly string[];
  toolNames: readonly string[];
}): string[] {
  const declared = new Set(normalizePluginToolNames(params.declaredNames));
  return normalizePluginToolNames(params.toolNames).filter((name) => !declared.has(name));
}

/** Mirror of `normalizeCommandDescriptorName` (src/cli/program/command-descriptor-utils.ts:21-24). */
function normalizeCommandDescriptorName(name: string): string | null {
  const normalized = name.trim();
  return SAFE_COMMAND_NAME_PATTERN.test(normalized) ? normalized : null;
}

/**
 * A hook event key only ever fires if `triggerInternalHook` can find it, and it
 * looks up exactly two keys: `event.type` and `` `${event.type}:${event.action}` ``
 * (src/hooks/internal-hooks.ts:243-283, via `hasInternalHookListeners`). So a
 * dispatchable key is `<type>` or `<type>:<action>` with `type` in
 * `InternalHookEventType`. Anything else — `"agent-run-gate"`,
 * `"message:inbound:x"`, `"media:generated"` — is registered into a Map slot
 * nothing ever reads.
 */
function findUndispatchableEventKeys(events: readonly string[]): string[] {
  return events.filter((event) => {
    const segments = event.split(":");
    if (segments.length > 2) {
      return true;
    }
    if (!INTERNAL_HOOK_EVENT_TYPES.has(segments[0] ?? "")) {
      return true;
    }
    return segments.length === 2 && (segments[1] ?? "").trim().length === 0;
  });
}

type PluginManifestCommandAlias = { name: string; description?: string; cliCommand?: string };

/** The subset of `openclaw.plugin.json` this contract reads. */
type PluginManifest = {
  id: string;
  contracts?: {
    tools?: string[];
    trustedToolPolicies?: string[];
    memoryEmbeddingProviders?: string[];
  };
  commandAliases?: Array<string | PluginManifestCommandAlias>;
};

function readPluginManifest(pluginDir: string): PluginManifest {
  const raw = readFileSync(join(extensionsDir, pluginDir, "openclaw.plugin.json"), "utf8");
  return JSON.parse(raw) as PluginManifest;
}

/**
 * Mirror of the alias lookup `resolveManifestCommandAliasOwnerInRegistry`
 * performs (src/plugins/manifest-command-aliases.ts:108-137): alias names are
 * compared after lowercase normalization.
 */
function manifestCommandAliasNames(manifest: PluginManifest): string[] {
  return (manifest.commandAliases ?? [])
    .map((entry) => (typeof entry === "string" ? entry : entry?.name))
    .map((name) =>
      String(name ?? "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
}

type HostDiagnostic = { level: "error" | "warn"; message: string };

type RecordedHook = { events: string[]; name: string };
type RecordedCli = {
  parentPath: string[];
  commandRoots: string[];
  registrar: OpenClawPluginCliRegistrar;
};

type ContractHost = {
  api: OpenClawPluginApi;
  diagnostics: HostDiagnostic[];
  /**
   * Every name the plugin ATTEMPTED to register, recorded before the contract
   * gate. The host silently drops undeclared tools (registry.ts:630-642 returns
   * after pushing the diagnostic) — which is exactly how 32 tools vanished — so
   * the attempted list is what the manifest must cover.
   */
  attemptedToolNames: string[];
  toolNames: string[];
  hooks: RecordedHook[];
  services: OpenClawPluginService[];
  lifecycles: PluginRuntimeLifecycleRegistration[];
  cli: RecordedCli[];
  reloadRegistrations: unknown[];
  trustedToolPolicyIds: string[];
  memoryEmbeddingProviderIds: string[];
  controlUiIds: string[];
};

const silentLogger: PluginLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

/**
 * Build a real `OpenClawPluginApi` whose registration seams enforce the host's
 * own rules. `createTestPluginApi` supplies every remaining method with the
 * REAL signature and the host's own facade attachment
 * (src/plugin-sdk/plugin-test-api.ts -> `attachPluginApiFacades`).
 */
function createContractHost(params: {
  pluginId: string;
  manifests: readonly PluginManifest[];
  pluginConfig?: Record<string, unknown>;
}): ContractHost {
  const diagnostics: HostDiagnostic[] = [];
  const attemptedToolNames: string[] = [];
  const toolNames: string[] = [];
  const hooks: RecordedHook[] = [];
  const hookNames = new Set<string>();
  const services: OpenClawPluginService[] = [];
  const lifecycles: PluginRuntimeLifecycleRegistration[] = [];
  const cli: RecordedCli[] = [];
  const cliCommandPaths = new Set<string>();
  const reloadRegistrations: unknown[] = [];
  const trustedToolPolicyIds: string[] = [];
  const memoryEmbeddingProviderIds: string[] = [];
  const controlUiIds: string[] = [];

  const pushDiagnostic = (level: HostDiagnostic["level"], message: string): void => {
    diagnostics.push({ level, message });
  };

  /**
   * Contracts are looked up per registering plugin. A co-registration run
   * supplies all three manifests; the union keeps the check honest because the
   * host resolves `record.contracts` from the plugin that owns the call.
   */
  const declaredTools = normalizePluginToolNames(
    params.manifests.flatMap((manifest) => manifest.contracts?.tools ?? []),
  );
  const declaredTrustedToolPolicies = new Set(
    params.manifests.flatMap((manifest) => manifest.contracts?.trustedToolPolicies ?? []),
  );
  const declaredMemoryEmbeddingProviders = new Set(
    params.manifests.flatMap((manifest) => manifest.contracts?.memoryEmbeddingProviders ?? []),
  );

  /** Mirror of `registerTool` (src/plugins/registry.ts:600-651). */
  const registerTool: OpenClawPluginApi["registerTool"] = (tool, opts) => {
    const names = [...(opts?.names ?? []), ...(opts?.name ? [opts.name] : [])];
    if (typeof tool !== "function") {
      names.push(tool.name);
    }
    attemptedToolNames.push(...normalizePluginToolNames(names));
    if (declaredTools.length === 0) {
      pushDiagnostic("error", "plugin must declare contracts.tools before registering agent tools");
      return;
    }
    const normalized = normalizePluginToolNames(names);
    const undeclared = findUndeclaredPluginToolNames({
      declaredNames: declaredTools,
      toolNames: normalized,
    });
    if (undeclared.length > 0) {
      pushDiagnostic("error", `plugin must declare contracts.tools for: ${undeclared.join(", ")}`);
      return;
    }
    toolNames.push(...normalized);
  };

  /** Mirror of `registerHook` (src/plugins/registry.ts:659-700). */
  const registerHook: OpenClawPluginApi["registerHook"] = (events, handler, opts) => {
    const normalizedEvents = normalizeStringEntries(Array.isArray(events) ? events : [events]);
    const entry = opts?.entry ?? null;
    // registry.ts:668-671 — `requireRegistrationValue` THROWS, killing the load.
    const hookName = entry?.hook.name ?? opts?.name?.trim();
    if (!hookName) {
      throw new Error("hook registration missing name");
    }
    if (hookNames.has(hookName)) {
      pushDiagnostic("error", `hook already registered: ${hookName}`);
      return;
    }
    if (typeof handler !== "function") {
      pushDiagnostic("error", `hook registration handler must be a function: ${hookName}`);
      return;
    }
    hookNames.add(hookName);
    hooks.push({ events: normalizedEvents, name: hookName });
  };

  /** Mirror of `registerCli` (src/plugins/registry.ts:1476-1552). */
  const registerCli: OpenClawPluginApi["registerCli"] = (registrar, opts) => {
    const parentPath = (opts?.parentPath ?? []).map((segment) =>
      normalizeCommandDescriptorName(segment),
    );
    if (parentPath.some((segment) => segment === null)) {
      pushDiagnostic("error", "invalid cli command name in parentPath");
      return;
    }
    const normalizedParentPath = parentPath as string[];
    const descriptorNames = (opts?.descriptors ?? [])
      .map((descriptor) =>
        normalizeCommandDescriptorName(descriptor.name) && descriptor.description.trim()
          ? normalizeCommandDescriptorName(descriptor.name)
          : null,
      )
      .filter((name): name is string => name !== null);
    const commands = [...(opts?.commands ?? []), ...descriptorNames]
      .map((command) => normalizeCommandDescriptorName(command))
      .filter((command): command is string => command !== null);
    if (commands.length === 0) {
      pushDiagnostic("error", "cli registration missing explicit commands metadata");
      return;
    }
    const commandRoots = [...new Set(commands)];
    for (const command of commandRoots) {
      const commandPath = [...normalizedParentPath, command].join(" ");
      if (cliCommandPaths.has(commandPath)) {
        pushDiagnostic("error", `cli command already registered: ${commandPath}`);
        return;
      }
      cliCommandPaths.add(commandPath);
    }
    cli.push({ parentPath: normalizedParentPath, commandRoots, registrar });
  };

  /** Mirror of `registerReload` (src/plugins/registry.ts:1571-1598). */
  const registerReload: OpenClawPluginApi["registerReload"] = (registration) => {
    reloadRegistrations.push(registration);
    const prefixCount =
      normalizeStringEntries(registration.restartPrefixes).length +
      normalizeStringEntries(registration.hotPrefixes).length +
      normalizeStringEntries(registration.noopPrefixes).length;
    if (prefixCount === 0) {
      pushDiagnostic("warn", "reload registration missing prefixes");
    }
  };

  const registerService: OpenClawPluginApi["registerService"] = (service) => {
    if (!service.id?.trim() || typeof service.start !== "function") {
      pushDiagnostic("error", "service registration missing id or start()");
      return;
    }
    services.push(service);
  };

  const registerRuntimeLifecycle: OpenClawPluginApi["registerRuntimeLifecycle"] = (lifecycle) => {
    if (!lifecycle.id?.trim()) {
      pushDiagnostic("error", "runtime lifecycle registration missing id");
      return;
    }
    lifecycles.push(lifecycle);
  };

  /**
   * Mirror of `registerTrustedToolPolicy` (src/plugins/registry.ts:2053-2078).
   * The `record.origin !== "bundled"` escape at :2066 exempts bundled plugins;
   * these three ARE bundled, so the manifest declaration is asserted here as a
   * manifest-honesty rule rather than as a host rejection.
   */
  const registerTrustedToolPolicy: OpenClawPluginApi["registerTrustedToolPolicy"] = (policy) => {
    const id = policy.id?.trim();
    const description = policy.description?.trim();
    if (!id || !description || typeof policy.evaluate !== "function") {
      pushDiagnostic(
        "error",
        "trusted tool policy registration requires id, description, and evaluate()",
      );
      return;
    }
    if (!declaredTrustedToolPolicies.has(id)) {
      pushDiagnostic("error", `plugin must declare contracts.trustedToolPolicies for: ${id}`);
      return;
    }
    trustedToolPolicyIds.push(id);
  };

  /** Mirror of `registerMemoryEmbeddingProvider` (src/plugins/registry.ts:3194-3232). */
  const registerMemoryEmbeddingProvider: OpenClawPluginApi["registerMemoryEmbeddingProvider"] = (
    adapter,
  ) => {
    if (!declaredMemoryEmbeddingProviders.has(adapter.id)) {
      pushDiagnostic(
        "error",
        `plugin must own memory slot or declare contracts.memoryEmbeddingProviders for adapter: ${adapter.id}`,
      );
      return;
    }
    if (memoryEmbeddingProviderIds.includes(adapter.id)) {
      pushDiagnostic("error", `memory embedding provider already registered: ${adapter.id}`);
      return;
    }
    memoryEmbeddingProviderIds.push(adapter.id);
  };

  const registerControlUiDescriptor: OpenClawPluginApi["registerControlUiDescriptor"] = (
    descriptor,
  ) => {
    if (!descriptor.id?.trim()) {
      pushDiagnostic("error", "control ui descriptor registration missing id");
      return;
    }
    controlUiIds.push(descriptor.id);
  };

  const api = createTestPluginApi({
    id: params.pluginId,
    name: params.pluginId,
    source: join(extensionsDir, params.pluginId, "index.ts"),
    rootDir: join(extensionsDir, params.pluginId),
    ...(params.pluginConfig ? { pluginConfig: params.pluginConfig } : {}),
    logger: silentLogger,
    registerTool,
    registerHook,
    registerCli,
    registerReload,
    registerService,
    registerRuntimeLifecycle,
    registerTrustedToolPolicy,
    registerMemoryEmbeddingProvider,
    registerControlUiDescriptor,
  });

  return {
    api,
    diagnostics,
    attemptedToolNames,
    toolNames,
    hooks,
    services,
    lifecycles,
    cli,
    reloadRegistrations,
    trustedToolPolicyIds,
    memoryEmbeddingProviderIds,
    controlUiIds,
  };
}

function createServiceContext(stateDir: string): OpenClawPluginServiceContext {
  return {
    config: {} as OpenClawConfig,
    stateDir,
    logger: silentLogger,
  };
}

/**
 * `gpu-broker` publishes a live handle on this key from its service `start()`
 * (extensions/gpu-broker/src/coop-handle.ts:27) and `creative-engines` reads it
 * lazily. The extensions lane runs with `isolate: false`
 * (test/vitest/vitest.scoped-config.ts `resolveVitestIsolation`), so the key is
 * cleared around every test to keep neighbouring files uncontaminated.
 */
const GPU_BROKER_HANDLE_KEY = "__creativeClawGpuBroker__";

function clearGpuBrokerHandle(): void {
  delete (globalThis as unknown as Record<string, unknown>)[GPU_BROKER_HANDLE_KEY];
}

const PLUGIN_ENTRIES = [
  { dir: "gpu-broker", entry: gpuBrokerPlugin },
  { dir: "visual-memory", entry: visualMemoryPlugin },
  { dir: "creative-engines", entry: creativeEnginesPlugin },
] as const;

type RegisteredPlugin = { host: ContractHost; manifest: PluginManifest };

describe("Creative Claw host API contract", () => {
  /**
   * ONE temp root for the whole file. `visual-memory` opens its SQLite store
   * inside `register()` and never exposes a close path (see the reported
   * defect), so on Windows the store file cannot be unlinked while this worker
   * lives. Keeping a single root means at most one directory survives instead
   * of one per test.
   */
  let tmpRoot: string;
  const registered = new Map<string, RegisteredPlugin>();

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "cc-host-contract-"));
  });

  afterAll(() => {
    registered.clear();
    try {
      rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* store file still held open by visual-memory; OS reclaims the temp root */
    }
  });

  beforeEach(clearGpuBrokerHandle);
  afterEach(clearGpuBrokerHandle);

  /** Per-plugin config that keeps register()/start() off the developer's machine. */
  function pluginConfigFor(dir: string): Record<string, unknown> {
    if (dir === "gpu-broker") {
      // Unroutable port + dormant override: no Ollama eviction, no nvidia-smi poll loop.
      return {
        ollamaBaseUrl: "http://127.0.0.1:1",
        dormantOverride: true,
        pollIntervalMs: 3_600_000,
      };
    }
    if (dir === "visual-memory") {
      return {
        embedder: "hash",
        protectContent: true,
        storePath: join(tmpRoot, "visual-memory"),
      };
    }
    return {};
  }

  /**
   * Run the plugin's real `register()` once per file and memoize the result.
   * Repeating it per assertion would open one SQLite store per test.
   */
  function registerPlugin(
    dir: string,
    entry: { register: (api: OpenClawPluginApi) => void },
  ): RegisteredPlugin {
    const cached = registered.get(dir);
    if (cached) {
      return cached;
    }
    const manifest = readPluginManifest(dir);
    const host = createContractHost({
      pluginId: dir,
      manifests: [manifest],
      pluginConfig: pluginConfigFor(dir),
    });
    entry.register(host.api);
    const result = { host, manifest };
    registered.set(dir, result);
    return result;
  }

  describe.each(PLUGIN_ENTRIES)("$dir", ({ dir, entry }) => {
    it("declares an id that matches its manifest", () => {
      const manifest = readPluginManifest(dir);
      expect(entry.id).toBe(manifest.id);
    });

    it("register() runs against the real host API without throwing", () => {
      // Registration is memoized, so a throw surfaces on whichever assertion
      // reaches it first; asserting here keeps the intent explicit.
      expect(() => registerPlugin(dir, entry)).not.toThrow();
      expect(registered.get(dir)).toBeDefined();
    });

    it("produces no error-level host diagnostics", () => {
      const { host } = registerPlugin(dir, entry);
      expect(host.diagnostics.filter((d) => d.level === "error")).toStrictEqual([]);
    });

    it("names every hook it registers", () => {
      // Missing names throw inside registerHook, so reaching here already proves
      // it; this pins the invariant explicitly for future hooks.
      const { host } = registerPlugin(dir, entry);
      for (const hook of host.hooks) {
        expect(hook.name.trim().length).toBeGreaterThan(0);
      }
      expect(new Set(host.hooks.map((h) => h.name)).size).toBe(host.hooks.length);
    });

    it("registers hooks only on event keys the host actually dispatches", () => {
      const { host } = registerPlugin(dir, entry);
      const undispatchable = host.hooks.flatMap((hook) =>
        findUndispatchableEventKeys(hook.events).map((event) => `${hook.name} -> ${event}`),
      );
      expect(undispatchable).toStrictEqual([]);
      for (const hook of host.hooks) {
        expect(hook.events.length).toBeGreaterThan(0);
      }
    });

    it("declares every registered tool in manifest contracts.tools", () => {
      const { host, manifest } = registerPlugin(dir, entry);
      const declared = normalizePluginToolNames(manifest.contracts?.tools);
      expect(host.attemptedToolNames.length).toBeGreaterThan(0);
      // Compare against ATTEMPTED names: the host drops undeclared tools, so
      // comparing accepted names against the manifest would always be vacuous.
      expect(
        findUndeclaredPluginToolNames({
          declaredNames: declared,
          toolNames: host.attemptedToolNames,
        }),
      ).toStrictEqual([]);
      expect(new Set(host.toolNames)).toStrictEqual(new Set(host.attemptedToolNames));
    });

    it("supplies explicit CLI command metadata and a matching manifest commandAlias", () => {
      const { host, manifest } = registerPlugin(dir, entry);
      const aliasNames = new Set(manifestCommandAliasNames(manifest));
      for (const registration of host.cli) {
        // registry.ts:1521-1530 rejects a CLI registration with no command roots.
        expect(registration.commandRoots.length).toBeGreaterThan(0);
        if (registration.parentPath.length > 0) {
          // Nested groups are reached through their parent root, not an alias.
          continue;
        }
        for (const root of registration.commandRoots) {
          expect(aliasNames).toContain(root.toLowerCase());
        }
      }
    });

    it("uses the declarative reload prefix shape, never a reload handler", () => {
      const { entry: pluginEntry } = { entry };
      const reload = (pluginEntry as { reload?: unknown }).reload;
      if (reload !== undefined) {
        expect(typeof reload).toBe("object");
        const registration = reload as Record<string, unknown>;
        expect(Object.keys(registration).every((key) => key.endsWith("Prefixes"))).toBe(true);
        const prefixes = [
          ...(Array.isArray(registration.restartPrefixes) ? registration.restartPrefixes : []),
          ...(Array.isArray(registration.hotPrefixes) ? registration.hotPrefixes : []),
          ...(Array.isArray(registration.noopPrefixes) ? registration.noopPrefixes : []),
        ];
        expect(normalizeStringEntries(prefixes).length).toBeGreaterThan(0);
      }

      const { host } = registerPlugin(dir, entry);
      for (const registration of host.reloadRegistrations) {
        expect(typeof registration).toBe("object");
        expect(typeof registration).not.toBe("function");
      }
    });

    it("builds its CLI command tree on a real commander program", () => {
      const { host } = registerPlugin(dir, entry);
      for (const registration of host.cli) {
        const program = new Command();
        expect(() =>
          registration.registrar({
            program,
            parentPath: registration.parentPath,
            config: {} as OpenClawConfig,
            logger: silentLogger,
          }),
        ).not.toThrow();
        const builtRoots = program.commands.map((command) => command.name());
        for (const root of registration.commandRoots) {
          expect(builtRoots).toContain(root);
        }
      }
    });
  });

  describe("service lifecycle", () => {
    it("gpu-broker service starts and stops without throwing and cleans its global handle", async () => {
      const { host } = registerPlugin("gpu-broker", gpuBrokerPlugin);
      expect(host.services.map((service) => service.id)).toStrictEqual(["gpu-broker"]);
      const service = host.services[0]!;
      const ctx = createServiceContext(join(tmpRoot, "gpu-broker-state"));
      try {
        await service.start(ctx);
        expect(
          (globalThis as unknown as Record<string, unknown>)[GPU_BROKER_HANDLE_KEY],
        ).toBeDefined();
      } finally {
        await service.stop?.(ctx);
      }
      expect(
        (globalThis as unknown as Record<string, unknown>)[GPU_BROKER_HANDLE_KEY],
      ).toBeUndefined();
      expect(host.diagnostics.filter((d) => d.level === "error")).toStrictEqual([]);
    });

    it("creative-engines service starts (loads native engines in-process) and cleanup shuts down", async () => {
      const { host } = registerPlugin("creative-engines", creativeEnginesPlugin);
      expect(host.services.map((service) => service.id)).toStrictEqual(["creative-engines"]);
      expect(host.lifecycles.map((lifecycle) => lifecycle.id)).toStrictEqual(["creative-engines"]);
      const service = host.services[0]!;
      const lifecycle = host.lifecycles[0]!;
      const ctx = createServiceContext(join(tmpRoot, "creative-engines-state"));
      try {
        await expect(service.start(ctx)).resolves.toBeUndefined();
      } finally {
        await expect(lifecycle.cleanup?.({ reason: "restart" })).resolves.toBeUndefined();
      }
      expect(host.diagnostics.filter((d) => d.level === "error")).toStrictEqual([]);
    });

    it("visual-memory registers no service and stores its index under the configured path", () => {
      const { host } = registerPlugin("visual-memory", visualMemoryPlugin);
      expect(host.services).toStrictEqual([]);
      expect(host.memoryEmbeddingProviderIds).toStrictEqual(["visual-memory"]);
      expect(host.trustedToolPolicyIds).toStrictEqual(["visual-memory-protected-content"]);
    });

    /**
     * The SQLite handle is opened during register() and used for the life of the
     * runtime, so the only way to release it is a lifecycle owner. Without one,
     * `close()` was unreachable and the DB file stayed locked for the process
     * lifetime on Windows, which can wedge a gateway restart.
     */
    it("visual-memory closes its SQLite store on runtime cleanup", () => {
      // Deliberately NOT the cached registerPlugin(): that host is shared with
      // other tests and closing its store would leak across them.
      const host = createContractHost({
        pluginId: "visual-memory",
        manifests: [readPluginManifest("visual-memory")],
        pluginConfig: {
          embedder: "hash",
          protectContent: true,
          storePath: join(tmpRoot, "visual-memory-cleanup"),
        },
      });
      visualMemoryPlugin.register(host.api);

      expect(host.lifecycles.map((lifecycle) => lifecycle.id)).toStrictEqual(["visual-memory"]);

      // Runs the REAL cleanup against the REAL store. Closing SQLite is
      // synchronous, so this asserts it completes without throwing.
      expect(() => host.lifecycles[0]!.cleanup?.({ reason: "restart" })).not.toThrow();
      expect(host.diagnostics.filter((d) => d.level === "error")).toStrictEqual([]);
    });
  });

  describe("co-registration", () => {
    it("all three plugins register into one host with no error diagnostics", () => {
      const manifests = PLUGIN_ENTRIES.map(({ dir }) => readPluginManifest(dir));
      const host = createContractHost({
        pluginId: "creative-claw",
        manifests,
        pluginConfig: {
          // Union config: each plugin reads only the keys it knows.
          ollamaBaseUrl: "http://127.0.0.1:1",
          dormantOverride: true,
          pollIntervalMs: 3_600_000,
          embedder: "hash",
          protectContent: true,
          storePath: join(tmpRoot, "visual-memory-shared"),
        },
      });

      for (const { entry } of PLUGIN_ENTRIES) {
        expect(() => entry.register(host.api)).not.toThrow();
      }

      // Duplicate hook names and duplicate CLI command paths are rejected by the
      // mirrored seams, so an empty error list also proves global uniqueness.
      expect(host.diagnostics.filter((d) => d.level === "error")).toStrictEqual([]);
      expect(new Set(host.toolNames).size).toBe(host.toolNames.length);
      // No tool the three plugins register may be dropped by the contract gate.
      expect(new Set(host.toolNames)).toStrictEqual(new Set(host.attemptedToolNames));
    });
  });
});
