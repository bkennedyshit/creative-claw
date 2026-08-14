import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { IndexStats, SearchResult } from "./types.js";

/** Known native binary names that provide media-memory functionality. */
const NATIVE_BINARIES = ["omni-search", "media-memory"];

export interface NativeDelegate {
  available: boolean;
  binaryPath: string | null;
  index(directory: string, opts?: { force?: boolean }): IndexStats | null;
  search(query: string, opts?: { topK?: number; type?: string }): SearchResult[] | null;
  searchByImage(imagePath: string, opts?: { topK?: number }): SearchResult[] | null;
}

/**
 * Detect and route through a native omni-search/media-memory binary when present.
 * Returns a delegate that transparently uses native indexing/search if available.
 */
export function createNativeDelegate(): NativeDelegate {
  const binaryPath = detectNativeBinary();

  return {
    available: binaryPath !== null,
    binaryPath,

    index(directory: string, opts?: { force?: boolean }): IndexStats | null {
      if (!binaryPath) {
        return null;
      }
      try {
        const args = ["index", directory];
        if (opts?.force) {
          args.push("--force");
        }
        const result = execFileSync(binaryPath, args, {
          timeout: 300_000,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        return JSON.parse(result) as IndexStats;
      } catch {
        return null;
      }
    },

    search(query: string, opts?: { topK?: number; type?: string }): SearchResult[] | null {
      if (!binaryPath) {
        return null;
      }
      try {
        const args = ["search", "--query", query];
        if (opts?.topK) {
          args.push("--top-k", String(opts.topK));
        }
        if (opts?.type) {
          args.push("--type", opts.type);
        }
        const result = execFileSync(binaryPath, args, {
          timeout: 30_000,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        return JSON.parse(result) as SearchResult[];
      } catch {
        return null;
      }
    },

    searchByImage(imagePath: string, opts?: { topK?: number }): SearchResult[] | null {
      if (!binaryPath) {
        return null;
      }
      try {
        const args = ["search-image", "--image", imagePath];
        if (opts?.topK) {
          args.push("--top-k", String(opts.topK));
        }
        const result = execFileSync(binaryPath, args, {
          timeout: 30_000,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        return JSON.parse(result) as SearchResult[];
      } catch {
        return null;
      }
    },
  };
}

/** Search PATH and common locations for a native media-memory binary. */
function detectNativeBinary(): string | null {
  // Check PATH via which/where
  for (const name of NATIVE_BINARIES) {
    try {
      const cmd = process.platform === "win32" ? "where" : "which";
      const result = execFileSync(cmd, [name], {
        encoding: "utf-8",
        timeout: 5_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (result && existsSync(result.split("\n")[0]!)) {
        return result.split("\n")[0]!;
      }
    } catch {
      // not in PATH
    }
  }

  // Check common install locations
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const candidates = NATIVE_BINARIES.flatMap((name) => [
    join(home, ".local", "bin", name),
    join(home, ".openclaw", "bin", name),
    join("/usr", "local", "bin", name),
  ]);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}
