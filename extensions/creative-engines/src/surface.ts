import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import type { EngineRuntime } from "./runtime/engine-runtime.js";
import type { Graph } from "./graph/types.js";
import type { Step } from "./types.js";
import { PipelineExecutor } from "./graph/executor.js";

/**
 * Operator surface for the creative engines (tasks.md 9.1).
 *
 * Exposes the same engine runtimes the agent tools use through an operator-side
 * `openclaw creative ...` CLI plus an optional Control UI settings descriptor.
 * Both registrations are capability-guarded: when the host api lacks the method
 * we no-op honestly instead of throwing, so the plugin degrades on older hosts.
 */

const ENGINE_NAMES = ["image", "audio", "video", "vector"] as const;
type EngineName = (typeof ENGINE_NAMES)[number];

const CREATIVE_CLI_DESCRIPTION =
  "Drive the native image/audio/video/vector engines from the operator side (list-ops, apply, batch, graph).";

/** Control UI settings card. Kept minimal per OQ5 (studio reuse deferred). */
export const CREATIVE_STUDIO_DESCRIPTOR = {
  id: "creative-engines-studio",
  surface: "settings" as const,
  label: "Creative Engines",
  description:
    "Inspect and operate the native image, audio, video, and vector engines: list ops, apply, batch, and run graphs.",
};

/** Structural view of the host api we consume, so the surface stays testable
 * and every register* call is optional. */
export interface CreativeSurfaceApi {
  registerCli?: (
    registrar: (ctx: { program: Command }) => void | Promise<void>,
    opts?: { descriptors?: Array<{ name: string; description: string; hasSubcommands: boolean }> },
  ) => void;
  registerControlUiDescriptor?: (descriptor: typeof CREATIVE_STUDIO_DESCRIPTOR) => void;
}

export type CreativeEngineRecord = Record<string, EngineRuntime>;

/** What actually got wired — lets callers/tests confirm honest no-ops. */
export interface CreativeSurfaceRegistration {
  cli: boolean;
  controlUi: boolean;
}

/** Per-engine availability + op summary used by `creative list-ops`. */
export interface EngineOpsSummary {
  engine: string;
  available: boolean;
  reason?: string;
  op_count: number;
  ops: string[];
}

/**
 * Register the operator CLI and the Control UI descriptor when the host
 * supports them. Returns which surfaces were wired.
 */
export function registerCreativeSurface(
  api: CreativeSurfaceApi,
  engines: CreativeEngineRecord,
): CreativeSurfaceRegistration {
  const registration: CreativeSurfaceRegistration = { cli: false, controlUi: false };

  if (typeof api.registerCli === "function") {
    api.registerCli(
      ({ program }) => {
        // buildCreativeCommand returns the created Command; the registrar
        // contract is void, so discard the return rather than leaking it.
        buildCreativeCommand(program, engines);
      },
      {
        descriptors: [{ name: "creative", description: CREATIVE_CLI_DESCRIPTION, hasSubcommands: true }],
      },
    );
    registration.cli = true;
  }

  if (typeof api.registerControlUiDescriptor === "function") {
    api.registerControlUiDescriptor(CREATIVE_STUDIO_DESCRIPTOR);
    registration.controlUi = true;
  }

  return registration;
}

/**
 * Build the `creative` command tree on a commander program. Exported so the
 * surface can be exercised without a live plugin host.
 */
export function buildCreativeCommand(program: Command, engines: CreativeEngineRecord): Command {
  const creative = program.command("creative").description(CREATIVE_CLI_DESCRIPTION);

  creative
    .command("list-ops")
    .description("List available operations per engine and their availability.")
    .argument("[engine]", "Restrict to a single engine (image|audio|video|vector)")
    .action((engine: string | undefined) => {
      const summaries = collectEngineOps(engines, engine as EngineName | undefined);
      printJson(summaries);
    });

  creative
    .command("apply")
    .description("Apply a single engine operation to a file.")
    .argument("<engine>", "Engine name (image|audio|video|vector)")
    .argument("<input>", "Input file path")
    .argument("<op>", "Operation id")
    .argument("<output>", "Output file path")
    .option("--params <json>", "JSON object of operation parameters", "{}")
    .action(async (engine: string, input: string, op: string, output: string, opts: { params?: string }) => {
      const runtime = resolveEngine(engines, engine);
      const params = parseJsonOption(opts.params, "--params") as Record<string, unknown>;
      const result = await runtime.apply(input, op, output, params);
      printJson(result);
    });

  creative
    .command("batch")
    .description("Run a pipeline over multiple inputs. One failure never aborts the batch.")
    .argument("<engine>", "Engine name (image|audio|video|vector)")
    .argument("<output_dir>", "Directory for processed outputs")
    .option("--pipeline <json>", "JSON array of { op, params } steps", "[]")
    .option("--folder <path>", "Input folder")
    .option("--glob <pattern>", "Input glob pattern")
    .option("--list <files...>", "Explicit input file list")
    .action(
      async (
        engine: string,
        outputDir: string,
        opts: { pipeline?: string; folder?: string; glob?: string; list?: string[] },
      ) => {
        const runtime = resolveEngine(engines, engine);
        const pipeline = parseJsonOption(opts.pipeline, "--pipeline") as Step[];
        const inputSet = { folder: opts.folder, glob: opts.glob, list: opts.list };
        const { manifest, items } = await runtime.batch(inputSet, pipeline, outputDir);
        printJson({ summary: manifestSummary(manifest), items, manifest });
      },
    );

  creative
    .command("graph")
    .description("Execute a node-graph of engine operations from a JSON file.")
    .argument("<file>", "Path to a graph JSON file ({ id, nodes, connections })")
    .action(async (file: string) => {
      const raw = await readFile(file, "utf8");
      const graph = JSON.parse(raw) as Graph;
      const executor = new PipelineExecutor(engines);
      const result = await executor.execute(graph);
      printJson(result);
    });

  return creative;
}

/**
 * Summarize each engine's availability and op ids. Availability is reported
 * honestly; op listing degrades to an empty list when an engine has no loaded
 * dispatch (never started / missing binary) rather than throwing.
 */
export function collectEngineOps(engines: CreativeEngineRecord, only?: EngineName): EngineOpsSummary[] {
  const names = only ? [only] : ENGINE_NAMES;
  const summaries: EngineOpsSummary[] = [];
  for (const name of names) {
    const engine = engines[name];
    if (!engine) continue;
    const available = engine.isAvailable();
    let ops: string[] = [];
    try {
      ops = engine.listOps().ops.map((op) => op.id);
    } catch {
      // Engine not started (no dispatch yet) — availability still reported.
      ops = [];
    }
    summaries.push({
      engine: name,
      available,
      reason: engine.reason(),
      op_count: ops.length,
      ops,
    });
  }
  return summaries;
}

function resolveEngine(engines: CreativeEngineRecord, name: string): EngineRuntime {
  const engine = engines[name];
  if (!engine) {
    throw new Error(`unknown engine '${name}' (expected one of: ${ENGINE_NAMES.join(", ")})`);
  }
  return engine;
}

function parseJsonOption(value: string | undefined, flag: string): unknown {
  if (value === undefined || value === "") return undefined;
  try {
    return JSON.parse(value);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid JSON for ${flag}: ${message}`);
  }
}

function manifestSummary(manifest: { total_items: number; succeeded: number; failed: number; output_dir: string }) {
  return {
    total: manifest.total_items,
    succeeded: manifest.succeeded,
    failed: manifest.failed,
    output_dir: manifest.output_dir,
  };
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
