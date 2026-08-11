import type { Command } from "commander";
import type { ToolContext } from "./tools.js";
import { handleMediaIndex, handleMediaSearch, handleMediaDescribe } from "./tools.js";

/**
 * Control UI descriptor id/surface for the operator-facing index browser.
 * Kept as a constant so tests and the descriptor stay in sync.
 */
export const MEDIA_CONTROL_UI_ID = "visual-memory-browser";

/**
 * Minimal structural view of the plugin API this surface needs.
 * Register hooks are optional so the surface no-ops honestly on a host
 * (or test double) that does not expose them.
 */
export interface MediaSurfaceApi {
  registerCli?: (
    registrar: (ctx: { program: Command }) => void | Promise<void>,
    opts?: {
      parentPath?: string[];
      commands?: string[];
      descriptors?: Array<{ name: string; description: string; hasSubcommands: boolean }>;
    },
  ) => void;
  registerControlUiDescriptor?: (descriptor: {
    id: string;
    surface: "session" | "tool" | "run" | "settings";
    label: string;
    description?: string;
  }) => void;
}

/** What actually got wired, so callers/tests can assert honest behavior. */
export interface MediaSurfaceResult {
  cli: boolean;
  controlUi: boolean;
}

/**
 * Register the operator surface for visual memory:
 *  - `openclaw media {index,search,describe}` CLI backed by the live store.
 *  - an optional Control UI descriptor to browse the index from settings.
 *
 * Every register* call is typeof-guarded so a host without that capability
 * simply skips it instead of throwing.
 */
export function registerMediaSurface(api: MediaSurfaceApi, ctx: ToolContext): MediaSurfaceResult {
  const result: MediaSurfaceResult = { cli: false, controlUi: false };

  if (typeof api.registerCli === "function") {
    api.registerCli(
      ({ program }) => {
        const media = program
          .command("media")
          .description("Browse and query the visual memory index");

        media
          .command("index")
          .description("Index a directory of media/text/code files into visual memory")
          .argument("<directory>", "Absolute path to the directory to index")
          .option("--force", "Re-index already indexed files", false)
          .option("--json", "Print raw JSON result")
          .action(async (directory: string, opts: { force?: boolean; json?: boolean }) => {
            const res = await handleMediaIndex({ directory, force: opts.force }, ctx);
            if (opts.json) {
              process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
              return;
            }
            process.stdout.write(`${res.message}\n`);
          });

        media
          .command("search")
          .description("Search indexed media by text query")
          .argument("<query>", "Text search query")
          .option("--top-k <n>", "Max results to return", (v) => Number(v), 10)
          .option("--min-score <n>", "Minimum similarity score (0-1)", (v) => Number(v), 0.1)
          .option("--type <type>", "Filter by asset type (image|video|text|code)")
          .option("--json", "Print raw JSON result")
          .action(
            async (
              query: string,
              opts: { topK?: number; minScore?: number; type?: string; json?: boolean },
            ) => {
              const res = await handleMediaSearch(
                { query, topK: opts.topK, minScore: opts.minScore, type: opts.type },
                ctx,
              );
              if (opts.json) {
                process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
                return;
              }
              process.stdout.write(
                `${res.results.length} result(s) for "${res.query}" (${res.backend}, ${res.elapsed}ms)\n`,
              );
              if (res.embedder.degraded) {
                process.stderr.write(`DEGRADED: ${res.embedder.reason ?? "embedder fell back"}\n`);
              }
              for (const r of res.results) {
                process.stdout.write(`  ${r.score.toFixed(4)}  ${r.type}  ${r.path}  [${r.id}]\n`);
              }
            },
          );

        media
          .command("describe")
          .description("Show full details of an indexed asset by id")
          .argument("<id>", "Asset ID (ULID)")
          .option("--json", "Print raw JSON result")
          .action((id: string, opts: { json?: boolean }) => {
            const res = handleMediaDescribe({ id }, ctx);
            if (opts.json) {
              process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
              return;
            }
            if (!res.found) {
              process.stdout.write(`${res.message}\n`);
              return;
            }
            process.stdout.write(
              `${res.id}\n  path: ${res.path}\n  type: ${res.type}\n  timestamp: ${res.timestamp}\n  metadata: ${JSON.stringify(res.metadata)}\n`,
            );
          });
      },
      {
        commands: ["media"],
        descriptors: [
          { name: "media", description: "Browse and query the visual memory index", hasSubcommands: true },
        ],
      },
    );
    result.cli = true;
  }

  if (typeof api.registerControlUiDescriptor === "function") {
    api.registerControlUiDescriptor({
      id: MEDIA_CONTROL_UI_ID,
      surface: "settings",
      label: "Visual Memory",
      description: "Browse, search, and inspect the visual memory index.",
    });
    result.controlUi = true;
  }

  return result;
}
