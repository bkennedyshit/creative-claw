import { readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { ulid } from "ulid";
import type { Embedder } from "./embedder/index.js";
import type { IndexStats } from "./types.js";
import { VectorStore } from "./store.js";
import { buildMetadata } from "./pathmeta.js";

export const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".svg"]);
export const VIDEO_EXTS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm"]);
export const TEXT_EXTS = new Set([".txt", ".md", ".html", ".htm", ".json", ".xml", ".yaml", ".yml", ".csv", ".tsv"]);
export const CODE_EXTS = new Set([".ts", ".js", ".tsx", ".jsx", ".py", ".rb", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".css", ".scss"]);

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

export interface IndexOptions {
  directory: string;
  store: VectorStore;
  embedder: Embedder;
  /**
   * Label of the backend that actually produced the vectors. Passed in rather
   * than inferred so the reported backend can never drift from the resolved one.
   */
  backend?: string;
  force?: boolean;
  workspaceRoot?: string;
}

/**
 * Walk a directory and index supported media/text files.
 * - Routes files by extension to the appropriate embedding path
 * - Skips files exceeding 100MB
 * - Video: samples a keyframe via ffmpeg for embedding
 * - One failure does not stop the walk
 */
export async function indexDirectory(opts: IndexOptions): Promise<IndexStats> {
  const { directory, store, embedder, backend = "hash", force = false, workspaceRoot } = opts;
  const start = Date.now();
  let total = 0;
  let indexed = 0;
  let skipped = 0;
  let failed = 0;

  const files = walkDir(directory);

  for (const filePath of files) {
    total++;

    try {
      // Size guard
      const stat = statSync(filePath);
      if (stat.size > MAX_FILE_SIZE) {
        skipped++;
        continue;
      }

      // Skip already-indexed unless force
      if (!force) {
        const existing = store.getByPath(filePath);
        if (existing) {
          skipped++;
          continue;
        }
      }

      const ext = extname(filePath).toLowerCase();
      const type = classifyExt(ext);
      if (!type) {
        skipped++;
        continue;
      }

      let embedding: Float32Array;

      switch (type) {
        case "image":
          embedding = await embedder.embedImage(filePath);
          break;
        case "video":
          embedding = await embedVideoFrame(filePath, embedder);
          break;
        case "text":
        case "code": {
          const { readFileSync } = await import("node:fs");
          const content = readFileSync(filePath, "utf-8");
          embedding = await embedder.embedText(content);
          break;
        }
        default:
          skipped++;
          continue;
      }

      const metadata = buildMetadata(filePath, workspaceRoot);

      store.upsert({
        id: ulid(),
        path: filePath,
        type,
        timestamp: Date.now(),
        dim: embedding.length,
        embedding,
        metadata: {
          ...metadata,
          size: stat.size,
        },
      });

      indexed++;
    } catch (err) {
      failed++;
      console.warn(`[visual-memory] Failed to index ${filePath}:`, (err as Error).message);
    }
  }

  return {
    total,
    indexed,
    skipped,
    failed,
    elapsed: Date.now() - start,
    backend,
  };
}

/** Classify file extension to asset type. */
function classifyExt(ext: string): "image" | "video" | "text" | "code" | null {
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (TEXT_EXTS.has(ext)) return "text";
  if (CODE_EXTS.has(ext)) return "code";
  return null;
}

/** Recursively walk a directory, returning all file paths. */
function walkDir(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip hidden dirs and node_modules
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        results.push(...walkDir(fullPath));
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  } catch {
    // Permission denied or similar — skip silently
  }
  return results;
}

/**
 * Extract a representative frame from a video using ffmpeg,
 * then embed the extracted image. Falls back to text embedding of filename.
 */
async function embedVideoFrame(videoPath: string, embedder: Embedder): Promise<Float32Array> {
  const framePath = join(tmpdir(), `vmem-frame-${ulid()}.jpg`);

  try {
    // Extract frame at 1 second mark
    execFileSync("ffmpeg", [
      "-i", videoPath,
      "-ss", "1",
      "-frames:v", "1",
      "-q:v", "2",
      framePath,
    ], { timeout: 30_000, stdio: "ignore" });

    const embedding = await embedder.embedImage(framePath);

    // Clean up temp frame
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(framePath);
    } catch { /* ignore cleanup failure */ }

    return embedding;
  } catch {
    // ffmpeg not available or failed — fall back to filename embedding
    const { basename } = await import("node:path");
    return embedder.embedText(basename(videoPath));
  }
}
