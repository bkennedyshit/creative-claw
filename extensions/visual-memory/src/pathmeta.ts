import { relative } from "node:path";
import type { AssetMetadata, PathMetadata } from "./types.js";

/** Known workspace root segments that anchor brand inference. */
const WORKSPACE_ROOTS = new Set(["content", "input", "output", "archive"]);

/** Folder name → intent mapping. */
const INTENT_HINTS: Record<string, string> = {
  posts: "post",
  reels: "reel",
  stories: "story",
  audio: "audio",
  footage: "video",
};

/**
 * Infer brand from file path: the first segment after a recognized workspace root.
 * e.g. /workspace/content/acme/posts/img.png → "acme"
 */
export function inferBrand(filePath: string, workspaceRoot?: string): string | undefined {
  const normalized = filePath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);

  // If workspace root provided, work relative to it
  if (workspaceRoot) {
    const rel = relative(workspaceRoot, filePath).replace(/\\/g, "/");
    const relSegments = rel.split("/").filter(Boolean);

    // First segment should be a workspace root folder, second is brand
    if (relSegments.length >= 2 && WORKSPACE_ROOTS.has(relSegments[0]!)) {
      return relSegments[1];
    }
  }

  // Fallback: scan for workspace root markers in the full path
  for (let i = 0; i < segments.length; i++) {
    if (WORKSPACE_ROOTS.has(segments[i]!)) {
      // Brand is next segment after workspace root
      if (i + 1 < segments.length - 1) {
        return segments[i + 1];
      }
    }
  }

  return undefined;
}

/**
 * Classify content intent from folder structure.
 * Checks segment names against INTENT_HINTS; falls back to undefined.
 */
export function classifyIntent(filePath: string): string | undefined {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const segments = normalized.split("/");

  for (const segment of segments) {
    if (INTENT_HINTS[segment]) {
      return INTENT_HINTS[segment];
    }
  }

  return undefined;
}

/**
 * Path segment that marks original source media. A file living beneath a
 * directory with this name is treated as published/final.
 */
const PROTECTED_ROOT_SEGMENT = "content";

/**
 * Determine whether editing this file should trigger a warning.
 *
 * Matches a `content` DIRECTORY SEGMENT, not the substring `"/content/"`.
 * The substring form was a live guardrail bypass: a workspace-RELATIVE target
 * like `content/acme/hero.png` has no leading separator, so it was not flagged,
 * and agents pass relative paths routinely — omitting one slash was enough to
 * overwrite protected originals. Segment matching also stops false positives on
 * directories that merely start with the word (`contents/`, `my_content/`).
 *
 * Only DIRECTORY segments count, so a file literally named `content` is not
 * flagged. That preserves the original intent: what is protected is the media
 * *under* a content directory.
 */
export function shouldWarnOnEdit(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  // A trailing separator means every segment names a directory; otherwise the
  // last segment is the file itself and cannot be the protecting directory.
  const directorySegments = normalized.endsWith("/") ? segments : segments.slice(0, -1);
  return directorySegments.includes(PROTECTED_ROOT_SEGMENT);
}

/**
 * Build complete PathMetadata for a file.
 */
export function buildPathMetadata(filePath: string, workspaceRoot?: string): PathMetadata {
  return {
    brand: inferBrand(filePath, workspaceRoot),
    intent: classifyIntent(filePath),
    warnOnEdit: shouldWarnOnEdit(filePath),
  };
}

/**
 * Build asset metadata from path analysis. Convenience for the indexer.
 */
export function buildMetadata(filePath: string, workspaceRoot?: string): AssetMetadata {
  const pathMeta = buildPathMetadata(filePath, workspaceRoot);
  return {
    brand: pathMeta.brand,
    intent: pathMeta.intent,
    warnOnEdit: pathMeta.warnOnEdit,
  };
}
