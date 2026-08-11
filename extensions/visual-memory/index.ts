import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { AnyAgentTool } from "openclaw/plugin-sdk/core";
import { Type, type TSchema } from "typebox";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { resolveEmbedder } from "./src/embedder/index.js";
import { VectorStore } from "./src/store.js";
import { registerProtectedContentGuard, type EditGuardApi } from "./src/edit-guard.js";
import {
  handleMediaIndex,
  handleMediaSearch,
  handleMediaSearchByImage,
  handleMediaDescribe,
  type ToolContext,
} from "./src/tools.js";
import { registerMediaSurface, type MediaSurfaceApi } from "./src/surface.js";
import type { EmbedderConfig } from "./src/types.js";

/** Structural view of the config-reading seams this plugin uses. */
interface PluginConfigApi {
  getPluginConfig?: () => Record<string, unknown> | undefined;
  pluginConfig?: Record<string, unknown>;
}

/** Adapter shape accepted by the real memory embedding provider seam. */
type MemoryEmbeddingProviderAdapter = Parameters<OpenClawPluginApi["registerMemoryEmbeddingProvider"]>[0];

/**
 * Wrap a friendly `(args) => result` handler into a conforming agent tool: a
 * typebox parameter schema plus an `execute(toolCallId, params, ...)` returning
 * an `AgentToolResult` (`{ content: [{ type: "text", text }], details }`).
 */
function mediaTool(spec: {
  name: string;
  description: string;
  parameters: TSchema;
  run: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}): AnyAgentTool {
  return {
    name: spec.name,
    label: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    async execute(
      _toolCallId: string,
      params: unknown,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }> {
      const result = await spec.run((params ?? {}) as Record<string, unknown>);
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: "text", text }], details: result };
    },
  } satisfies AnyAgentTool;
}

export default definePluginEntry({
  id: "visual-memory",
  name: "Visual Memory",
  description: "Media-as-memory: index, search, and recall visual and media assets via vector similarity.",

  register(api) {
    // Resolve config from the canonical plugin-config seam.
    const configApi: PluginConfigApi = api;
    const config = configApi.getPluginConfig?.() ?? configApi.pluginConfig ?? {};
    const embedderBackend = (config.embedder as string | undefined) ?? "hash";
    const protectContent = (config.protectContent as boolean | undefined) ?? true;
    const storePath = (config.storePath as string | undefined) || "";

    // Determine store path (default: ~/.openclaw/visual-memory/)
    const home = process.env.HOME || process.env.USERPROFILE || process.cwd();
    const baseDir = storePath || join(home, ".openclaw", "visual-memory");
    mkdirSync(baseDir, { recursive: true });

    const dbPath = join(baseDir, "visual-memory.sqlite");

    // Initialize embedder. An unsupported backend degrades to hash and says so.
    const embedderConfig: EmbedderConfig = {
      backend: embedderBackend,
      dim: 512,
    };
    const { embedder, report: embedderReport } = resolveEmbedder(embedderConfig);
    if (embedderReport.degraded) {
      // Logged once at startup; also returned in every media_search/media_index result.
      console.error(
        `[visual-memory] embedder DEGRADED: requested="${embedderReport.requested}" used="${embedderReport.used}". ${embedderReport.reason ?? ""}`,
      );
    }

    // Initialize store
    const store = new VectorStore({ dbPath });

    // Tool context
    const toolCtx: ToolContext = { store, embedder, embedderReport, workspaceRoot: undefined };

    // --- Register 4 media tools ---

    api.registerTool(
      mediaTool({
        name: "media_index",
        description: "Index a directory of media/text/code files for visual memory search. Returns indexing statistics.",
        parameters: Type.Object({
          directory: Type.String({ description: "Absolute path to directory to index" }),
          force: Type.Optional(Type.Boolean({ description: "Re-index already indexed files" })),
        }),
        run(args) {
          return handleMediaIndex(args as { directory: string; force?: boolean }, toolCtx);
        },
      }),
    );

    api.registerTool(
      mediaTool({
        name: "media_search",
        description:
          "Search indexed media assets by text query. Returns ranked results with similarity scores, " +
          "plus an `embedder` block reporting which backend ran and whether it was degraded. " +
          "The shipped hash backend is lexical/byte similarity, NOT semantic.",
        parameters: Type.Object({
          query: Type.String({ description: "Text search query" }),
          topK: Type.Optional(Type.Number({ description: "Max results to return" })),
          minScore: Type.Optional(Type.Number({ description: "Minimum similarity score (0-1)" })),
          type: Type.Optional(Type.String({ description: "Filter by asset type: image|video|text|code" })),
        }),
        run(args) {
          return handleMediaSearch(
            args as { query: string; topK?: number; minScore?: number; type?: string },
            toolCtx,
          );
        },
      }),
    );

    api.registerTool(
      mediaTool({
        name: "media_search_by_image",
        description: "Reverse image search: find similar indexed media by providing an image file path.",
        parameters: Type.Object({
          imagePath: Type.String({ description: "Absolute path to query image" }),
          topK: Type.Optional(Type.Number({ description: "Max results to return" })),
          minScore: Type.Optional(Type.Number({ description: "Minimum similarity score (0-1)" })),
        }),
        run(args) {
          return handleMediaSearchByImage(
            args as { imagePath: string; topK?: number; minScore?: number },
            toolCtx,
          );
        },
      }),
    );

    api.registerTool(
      mediaTool({
        name: "media_describe",
        description: "Get full details of an indexed media asset by its ID.",
        parameters: Type.Object({
          id: Type.String({ description: "Asset ID (ULID)" }),
        }),
        run(args) {
          return handleMediaDescribe(args as { id: string }, toolCtx);
        },
      }),
    );

    // --- Operator surface: `openclaw media ...` CLI + optional Control UI ---
    // Guarded internally so it no-ops honestly when the host lacks the seams.
    registerMediaSurface(api as unknown as MediaSurfaceApi, toolCtx);

    // --- Memory embedding provider (companion reuse of the active embedder) ---
    // Text memory can share this embedding space. The advertised model is the
    // backend that ACTUALLY ran, never the one that was merely requested.
    // Guarded with typeof so it no-ops on hosts without the seam.
    if (typeof api.registerMemoryEmbeddingProvider === "function") {
      const embeddingAdapter: MemoryEmbeddingProviderAdapter = {
        id: "visual-memory",
        defaultModel: embedderReport.used,
        transport: "local",
        create: async () => ({
          provider: {
            id: "visual-memory",
            model: embedderReport.used,
            async embedQuery(text: string): Promise<number[]> {
              return Array.from(await embedder.embedText(text));
            },
            async embedBatch(texts: string[]): Promise<number[][]> {
              const out: number[][] = [];
              for (const t of texts) {
                out.push(Array.from(await embedder.embedText(t)));
              }
              return out;
            },
          },
        }),
      };
      api.registerMemoryEmbeddingProvider(embeddingAdapter);
    }

    // --- Protected-source guardrail: enforce pathmeta's warnOnEdit ---
    // Refuses write/edit/apply_patch on originals under /content/ via the host's
    // trusted tool policy seam, which is the only seam that can actually refuse.
    if (protectContent) {
      const guarded = registerProtectedContentGuard(api as unknown as EditGuardApi);
      if (!guarded) {
        console.error(
          "[visual-memory] protectContent is enabled but this host exposes no registerTrustedToolPolicy seam — /content/ originals are NOT protected.",
        );
      }
    }

    // NOTE: there is deliberately no auto-capture feature here. The host
    // exposes no seam that delivers inbound attachment bytes or generated media
    // paths to a plugin: the dispatched internal hook events are
    // message:received/sent/transcribed/preprocessed, command:*, gateway:*,
    // agent:bootstrap and session:compact:* (src/hooks/internal-hooks.ts),
    // MessageReceivedHookContext has no attachment field, and the only typed
    // hook carrying attachments (before_model_resolve) exposes just
    // { kind, mimeType } with no bytes or path. Index media explicitly with
    // media_index instead.
  },
});
