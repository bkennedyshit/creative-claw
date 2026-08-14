import type { IndexResult, MediaSearchResult, DescribeResult } from "./artifacts.js";
import type { Embedder } from "./embedder/index.js";
import { indexDirectory } from "./indexer.js";
import { createNativeDelegate } from "./native.js";
import { VectorStore } from "./store.js";
import type { EmbedderReport } from "./types.js";

export interface ToolContext {
  store: VectorStore;
  embedder: Embedder;
  /**
   * Honest account of the embedding backend in use. Echoed in every search and
   * index result so a degraded (hash-instead-of-semantic) run is always visible
   * to the model and the operator.
   */
  embedderReport: EmbedderReport;
  workspaceRoot?: string;
}

/** Backend label reported when a native delegate binary served the request. */
const NATIVE_BACKEND = "native";

function nativeReport(ctx: ToolContext, binaryPath: string | null): EmbedderReport {
  return {
    used: NATIVE_BACKEND,
    requested: ctx.embedderReport.requested,
    degraded: false,
    // The native binary owns its own embedding space; we do not know whether it
    // is semantic, so we do not claim it is.
    semantic: false,
    reason: `served by native binary ${binaryPath ?? "(unknown path)"}; embedding semantics are owned by that binary`,
  };
}

/** Append the degradation notice to a human-readable message when present. */
function withDegradationNotice(message: string, report: EmbedderReport): string {
  return report.degraded && report.reason ? `${message}\nDEGRADED: ${report.reason}` : message;
}

/**
 * media_index: Index a directory of media files.
 * Returns stats about indexed/skipped/failed files plus the backend used.
 */
export async function handleMediaIndex(
  args: { directory: string; force?: boolean },
  ctx: ToolContext,
): Promise<IndexResult> {
  const { directory, force } = args;

  // Try native delegate first
  const native = createNativeDelegate();
  if (native.available) {
    const stats = native.index(directory, { force });
    if (stats) {
      return {
        success: true,
        stats,
        message: `Indexed via native binary (${native.binaryPath})`,
        embedder: nativeReport(ctx, native.binaryPath),
      };
    }
  }

  // Fall back to built-in indexer
  const stats = await indexDirectory({
    directory,
    store: ctx.store,
    embedder: ctx.embedder,
    backend: ctx.embedderReport.used,
    force,
    workspaceRoot: ctx.workspaceRoot,
  });

  return {
    success: stats.failed < stats.total,
    stats,
    message: withDegradationNotice(
      `Indexed ${stats.indexed} files (${stats.skipped} skipped, ${stats.failed} failed) in ${stats.elapsed}ms using ${stats.backend} backend`,
      ctx.embedderReport,
    ),
    embedder: ctx.embedderReport,
  };
}

/**
 * media_search: Search indexed media by text query.
 * Returns ranked results with cosine similarity scores.
 */
export async function handleMediaSearch(
  args: { query: string; topK?: number; minScore?: number; type?: string },
  ctx: ToolContext,
): Promise<MediaSearchResult> {
  const { query, topK = 10, minScore = 0.1, type } = args;
  const start = Date.now();

  // Try native delegate first
  const native = createNativeDelegate();
  if (native.available) {
    const results = native.search(query, { topK, type });
    if (results) {
      return {
        results,
        query,
        backend: NATIVE_BACKEND,
        elapsed: Date.now() - start,
        embedder: nativeReport(ctx, native.binaryPath),
      };
    }
  }

  // Embed the query text
  const queryEmbedding = await ctx.embedder.embedText(query);

  // Search the store
  const results = ctx.store.search(queryEmbedding, {
    topK,
    minScore,
    typeFilter: type as "image" | "video" | "text" | "code" | undefined,
  });

  return {
    results,
    query,
    backend: ctx.embedderReport.used,
    elapsed: Date.now() - start,
    embedder: ctx.embedderReport,
  };
}

/**
 * media_search_by_image: Reverse image search — find similar indexed media.
 */
export async function handleMediaSearchByImage(
  args: { imagePath: string; topK?: number; minScore?: number },
  ctx: ToolContext,
): Promise<MediaSearchResult> {
  const { imagePath, topK = 10, minScore = 0.1 } = args;
  const start = Date.now();

  // Try native delegate first
  const native = createNativeDelegate();
  if (native.available) {
    const results = native.searchByImage(imagePath, { topK });
    if (results) {
      return {
        results,
        query: `image:${imagePath}`,
        backend: NATIVE_BACKEND,
        elapsed: Date.now() - start,
        embedder: nativeReport(ctx, native.binaryPath),
      };
    }
  }

  // Embed the query image
  const queryEmbedding = await ctx.embedder.embedImage(imagePath);

  // Search the store
  const results = ctx.store.search(queryEmbedding, { topK, minScore });

  return {
    results,
    query: `image:${imagePath}`,
    backend: ctx.embedderReport.used,
    elapsed: Date.now() - start,
    embedder: ctx.embedderReport,
  };
}

/**
 * media_describe: Get full details of an indexed asset by id.
 */
export function handleMediaDescribe(args: { id: string }, ctx: ToolContext): DescribeResult {
  const asset = ctx.store.getById(args.id);
  if (!asset) {
    return {
      found: false,
      id: args.id,
      message: `Asset '${args.id}' not found in the visual memory store.`,
    };
  }

  return {
    found: true,
    id: asset.id,
    path: asset.path,
    type: asset.type,
    timestamp: asset.timestamp,
    metadata: asset.metadata,
  };
}
