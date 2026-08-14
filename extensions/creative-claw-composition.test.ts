/**
 * Creative Claw Composition Test
 *
 * Runs the REAL register() functions of all three plugins (gpu-broker,
 * visual-memory, creative-engines) against a recording mock API, and verifies
 * they co-register in one session without tool-name collisions, that visual
 * memory does NOT claim the exclusive memory slot, and that the creative
 * engines wire GPU-broker cooperation + media providers.
 *
 * This exercises the real plugin code (not stand-in mocks), so the assertions
 * track the actual registered tool surface.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The only mock: the SDK boundary. definePluginEntry just returns the entry so
// we can call `.register(api)` directly. Everything else runs for real.
vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
  definePluginEntry: (entry: unknown) => entry,
}));

import gpuBrokerPlugin from "./gpu-broker/index.js";
import visualMemoryPlugin from "./visual-memory/index.js";
import creativeEnginesPlugin from "./creative-engines/index.js";

interface RegisteredTool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (...args: unknown[]) => unknown;
}
interface RegisteredService {
  id: string;
  start: (ctx?: unknown) => void;
  stop: () => void;
}
interface RegisteredHook {
  event: string;
  name: string;
  handler: (...args: unknown[]) => unknown;
}
interface RegisteredTrustedToolPolicy {
  id: string;
  description: string;
  evaluate: (event: { toolName: string; params: Record<string, unknown> }) => unknown;
}

function createMockApi(storePath: string) {
  const tools: RegisteredTool[] = [];
  const services: RegisteredService[] = [];
  const hooks: RegisteredHook[] = [];
  const providers: { type: string; provider: unknown }[] = [];
  const lifecycles: unknown[] = [];
  const trustedToolPolicies: RegisteredTrustedToolPolicy[] = [];

  const runContext = {
    gpuBroker: { release: async () => {}, reclaim: async () => {} },
  };

  return {
    tools,
    services,
    hooks,
    providers,
    lifecycles,
    trustedToolPolicies,
    api: {
      registerTool(tool: RegisteredTool) {
        tools.push(tool);
      },
      registerService(service: RegisteredService) {
        services.push(service);
      },
      registerHook(
        events: string | string[],
        handler: (...args: unknown[]) => unknown,
        opts?: { name?: string },
      ) {
        // Mirror the host contract: the registry requires a hook name and
        // throws "hook registration missing name" without one.
        if (!opts?.name?.trim()) {
          throw new Error("hook registration missing name");
        }
        hooks.push({
          event: Array.isArray(events) ? events.join(",") : events,
          name: opts.name.trim(),
          handler,
        });
      },
      registerRuntimeLifecycle(lc: unknown) {
        lifecycles.push(lc);
      },
      registerImageGenerationProvider(provider: unknown) {
        providers.push({ type: "image", provider });
      },
      registerMediaUnderstandingProvider(provider: unknown) {
        providers.push({ type: "mediaUnderstanding", provider });
      },
      registerMusicGenerationProvider(provider: unknown) {
        providers.push({ type: "music", provider });
      },
      registerVideoGenerationProvider(provider: unknown) {
        providers.push({ type: "video", provider });
      },
      registerTrustedToolPolicy(policy: RegisteredTrustedToolPolicy) {
        trustedToolPolicies.push(policy);
      },
      getPluginConfig: () => ({ embedder: "hash", protectContent: true, storePath }),
      getRunContext: () => runContext,
      // creative-engines' media-understanding provider captures these host
      // seams at register() and only calls them when a video is described.
      config: {},
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: {
        config: { current: () => ({}) },
        agent: { resolveAgentDir: () => storePath },
        mediaUnderstanding: { describeImageFileWithModel: vi.fn() },
      },
    },
  };
}

describe("Creative Claw Composition", () => {
  let mockApi: ReturnType<typeof createMockApi>;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cc-composition-"));
    mockApi = createMockApi(tmpDir);
  });

  afterEach(() => {
    // Stop any started broker service and clean the temp store.
    for (const svc of mockApi.services) {
      try {
        svc.stop();
      } catch {
        /* ignore */
      }
    }
    // The real VectorStore keeps its SQLite handle open for the worker
    // lifetime; on Windows the file cannot be unlinked while open. Cleanup is
    // best-effort — the OS reclaims the temp dir regardless.
    try {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
    } catch {
      /* temp dir left for OS cleanup (open SQLite handle on Windows) */
    }
  });

  describe("GPU Broker plugin registration", () => {
    it("registers 4 gpu tools, 1 service, and 1 named agent-run-gate hook", () => {
      gpuBrokerPlugin.register(mockApi.api);

      const toolNames = mockApi.tools.map((t) => t.name);
      expect(toolNames).toContain("gpu.status");
      expect(toolNames).toContain("gpu.release");
      expect(toolNames).toContain("gpu.reclaim");
      expect(toolNames).toContain("gpu.handoff");
      expect(mockApi.tools).toHaveLength(4);

      expect(mockApi.services).toHaveLength(1);
      expect(mockApi.services[0]!.id).toBe("gpu-broker");

      // Both hooks ride the real "agent:bootstrap" event and are uniquely named.
      const gateHooks = mockApi.hooks.filter(
        (h) => h.event === "agent:bootstrap" && h.name === "gpu-broker-agent-run-gate",
      );
      expect(gateHooks).toHaveLength(1);
      expect(mockApi.hooks.map((h) => h.name).sort()).toStrictEqual([
        "gpu-broker-agent-run-gate",
        "gpu-broker-warmup-recalibration",
      ]);
    });
  });

  describe("Visual Memory plugin registration", () => {
    it("registers 4 media tools and does NOT claim the memory slot", () => {
      visualMemoryPlugin.register(mockApi.api);

      const toolNames = mockApi.tools.map((t) => t.name);
      expect(toolNames).toContain("media_index");
      expect(toolNames).toContain("media_search");
      expect(toolNames).toContain("media_search_by_image");
      expect(toolNames).toContain("media_describe");
      expect(mockApi.tools).toHaveLength(4);

      // Companion path: no exclusive memory-slot service, no memory:claim hook.
      expect(mockApi.services).toHaveLength(0);
      const memoryHooks = mockApi.hooks.filter((h) => h.event === "memory:claim");
      expect(memoryHooks).toHaveLength(0);
    });

    it("registers no internal hooks (auto-capture was removed, not stubbed)", () => {
      visualMemoryPlugin.register(mockApi.api);
      expect(mockApi.hooks).toHaveLength(0);
    });

    it("enforces the /content/ guardrail through the real trusted tool policy seam", () => {
      visualMemoryPlugin.register(mockApi.api);

      expect(mockApi.trustedToolPolicies.map((p) => p.id)).toStrictEqual([
        "visual-memory-protected-content",
      ]);
      const policy = mockApi.trustedToolPolicies[0]!;
      expect(
        policy.evaluate({ toolName: "write", params: { path: "/workspace/content/a.png" } }),
      ).toMatchObject({ allow: false });
      expect(
        policy.evaluate({ toolName: "write", params: { path: "/workspace/output/a.png" } }),
      ).toBeUndefined();
    });
  });

  describe("Creative Engines plugin registration", () => {
    it("registers per-engine ops, batch, edit-session tools + lifecycle", () => {
      creativeEnginesPlugin.register(mockApi.api);

      const toolNames = mockApi.tools.map((t) => t.name);

      // Per-engine ops (image/audio/video/vector each: list_ops/op_info/apply/apply_chain)
      for (const engine of ["image", "audio", "video", "vector"]) {
        expect(toolNames).toContain(`${engine}.list_ops`);
        expect(toolNames).toContain(`${engine}.op_info`);
        expect(toolNames).toContain(`${engine}.apply`);
        expect(toolNames).toContain(`${engine}.apply_chain`);
        expect(toolNames).toContain(`${engine}.batch`);
      }

      // Image edit-session tools (plan/preview/confirm/revert style — at least one).
      const editTools = toolNames.filter((n) => n.startsWith("image.edit_session"));
      expect(editTools.length).toBeGreaterThanOrEqual(1);

      // Runtime lifecycle registered (in-process FFI load/unload, no co-process).
      expect(mockApi.lifecycles).toHaveLength(1);
    });

    /**
     * These engines are deterministic C++ EDITING engines, not generative
     * models: no `generate` op exists in the image/audio/video catalogs
     * (155 / 45 / 46 ops), and nothing turns a text prompt into media.
     *
     * The plugin used to register image/music/video generation providers plus
     * an id-only media-understanding provider. Every generation body called
     * `engine.apply(req.prompt, "generate", …)`, passing a TEXT PROMPT where an
     * INPUT FILE PATH was expected and asking for an op that does not exist, so
     * all three failed 100% of the time with `unknown op 'generate'` — while the
     * manifest told the host creative-engines could generate images, music, and
     * video, potentially shadowing a provider that actually works.
     *
     * All four registrations were removed. Exactly ONE came back — a
     * media-understanding provider with a real `describeVideo` that extracts
     * keyframes via the video engine and describes them through the host's
     * configured vision model. Generation stays unclaimed.
     */
    it("registers no GENERATION provider, only video understanding", () => {
      creativeEnginesPlugin.register(mockApi.api);
      expect(mockApi.providers.map((entry) => entry.type)).toStrictEqual(["mediaUnderstanding"]);
      const provider = mockApi.providers[0]!.provider as {
        id: string;
        capabilities?: string[];
        describeVideo?: unknown;
        describeImage?: unknown;
        transcribeAudio?: unknown;
      };
      expect(provider.id).toBe("creative-engines");
      expect(provider.capabilities).toStrictEqual(["video"]);
      expect(provider.describeVideo).toBeTypeOf("function");
      expect(provider.describeImage).toBeUndefined();
      expect(provider.transcribeAudio).toBeUndefined();
    });
  });

  describe("Co-registration", () => {
    it("all 3 plugins register without duplicate tool names", () => {
      gpuBrokerPlugin.register(mockApi.api);
      visualMemoryPlugin.register(mockApi.api);
      creativeEnginesPlugin.register(mockApi.api);

      const allNames = mockApi.tools.map((t) => t.name);
      const uniqueNames = new Set(allNames);

      expect(allNames.length).toBe(uniqueNames.size);
      expect(allNames.length).toBeGreaterThan(0);
    });

    it("total tools equals the sum of each plugin's tools", () => {
      gpuBrokerPlugin.register(mockApi.api);
      const afterGpu = mockApi.tools.length;

      visualMemoryPlugin.register(mockApi.api);
      const afterVmem = mockApi.tools.length;

      creativeEnginesPlugin.register(mockApi.api);
      const total = mockApi.tools.length;

      expect(afterGpu).toBe(4); // gpu.status/release/reclaim/handoff
      expect(afterVmem - afterGpu).toBe(4); // 4 media tools
      // Creative engines: 4 engines × (4 ops + 1 batch) = 20, plus edit-session tools.
      expect(total - afterVmem).toBeGreaterThanOrEqual(20);
    });
  });

  describe("Cross-plugin GPU cooperation", () => {
    it("creative engines register successfully when a gpuBroker is present in run context", () => {
      // getRunContext() supplies a gpuBroker with release/reclaim; the engines
      // wire it via setGpuBroker without throwing, and still register their tools.
      expect(() => creativeEnginesPlugin.register(mockApi.api)).not.toThrow();
      const toolNames = mockApi.tools.map((t) => t.name);
      expect(toolNames).toContain("image.apply");
    });
  });

  describe("Plugin metadata", () => {
    it("all plugins have unique ids", () => {
      const ids = [gpuBrokerPlugin.id, visualMemoryPlugin.id, creativeEnginesPlugin.id];
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("plugin ids are correct", () => {
      expect(gpuBrokerPlugin.id).toBe("gpu-broker");
      expect(visualMemoryPlugin.id).toBe("visual-memory");
      expect(creativeEnginesPlugin.id).toBe("creative-engines");
    });
  });
});
