import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import {
  cudaProviderDependencyStatus,
  describeCudaProviderDependencies,
  ensureCudaProviderDependencies,
  ortSidecarStatus,
  resolveBinaryPath,
} from "./ffi/loader.js";
import { PipelineExecutor } from "./graph/executor.js";
import type { Graph } from "./graph/types.js";
import type { EngineRuntime } from "./runtime/engine-runtime.js";
import type { Step } from "./types.js";

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
        descriptors: [
          { name: "creative", description: CREATIVE_CLI_DESCRIPTION, hasSubcommands: true },
        ],
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
    .action(async (engine: string | undefined) => {
      // Start on demand first: this command runs in a standalone CLI process
      // where the gateway service never ran, and without this every engine
      // reported available:false with zero ops on a healthy install.
      await startEnginesForListing(engines, engine as EngineName | undefined);
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
    .action(
      async (
        engine: string,
        input: string,
        op: string,
        output: string,
        opts: { params?: string },
      ) => {
        const runtime = resolveEngine(engines, engine);
        const params = parseJsonOption(opts.params, "--params") as Record<string, unknown>;
        const result = await runtime.apply(input, op, output, params);
        printJson(result);
      },
    );

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
    .command("onnx-status")
    .description(
      "Report the ONNX Runtime sidecar state and the CUDA 12 / cuDNN 9 provider-dependency discovery (which libraries were found, where, and which are missing).",
    )
    .action(() => {
      printJson(collectAcceleratorStatus());
    });

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
 * Start the engines a `list-ops` invocation is about to report on.
 *
 * Availability is only knowable after a load attempt, and in a standalone CLI
 * process nothing has attempted one (`start()` is a gateway service). Failures
 * are swallowed on purpose: `loadEngine` already reports a missing binary
 * through `reason()`, which is exactly what the summary prints.
 */
export async function startEnginesForListing(
  engines: CreativeEngineRecord,
  only?: EngineName,
): Promise<void> {
  const names = only ? [only] : ENGINE_NAMES;
  await Promise.all(
    names.map(async (name) => {
      await engines[name]?.ensureStarted().catch(() => {});
    }),
  );
}

/**
 * Summarize each engine's availability and op ids. Availability is reported
 * honestly; op listing degrades to an empty list when an engine has no loaded
 * dispatch (never started / missing binary) rather than throwing.
 */
export function collectEngineOps(
  engines: CreativeEngineRecord,
  only?: EngineName,
): EngineOpsSummary[] {
  const names = only ? [only] : ENGINE_NAMES;
  const summaries: EngineOpsSummary[] = [];
  for (const name of names) {
    const engine = engines[name];
    if (!engine) {
      continue;
    }
    const available = engine.isAvailable();
    let ops: string[];
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

/** What `creative onnx-status` prints. */
export interface AcceleratorStatus {
  onnxRuntime: ReturnType<typeof ortSidecarStatus>;
  /**
   * Whether the ORT sidecar FILES are present, checked without loading them.
   * In a short-lived CLI process nothing has mapped ORT, so `onnxRuntime.state`
   * is legitimately `not-attempted` there and this is the useful signal.
   */
  onnxRuntimeFiles: { core?: string; providersShared?: string; providersCuda?: string };
  cuda: ReturnType<typeof cudaProviderDependencyStatus>;
  /** One-line human summary of the CUDA state, in every state. */
  summary: string;
  /**
   * Deliberately conservative wording. Resolved dependencies mean ORT CAN load
   * `onnxruntime_providers_cuda.dll`; they do not prove a session was created on
   * the GPU. The engine's own log line is the authority on that, so this reads
   * as a capability, never as "GPU acceleration is active".
   */
  note: string;
}

/**
 * Snapshot the accelerator diagnostics.
 *
 * Never loads a native library: the ORT state is read from the memo and the
 * sidecar files are only stat'ed. It DOES run the CUDA dependency discovery when
 * it has not run yet, because otherwise `openclaw creative onnx-status` in a
 * fresh CLI process could only ever answer "not attempted", which is useless for
 * debugging. Discovery is filesystem probing plus this process's own library
 * search path, and it is memoized, so triggering it here is idempotent and
 * cannot change what a gateway already decided.
 */
export function collectAcceleratorStatus(): AcceleratorStatus {
  ensureCudaProviderDependencies();
  return {
    onnxRuntime: ortSidecarStatus(),
    onnxRuntimeFiles: {
      ...(resolveBinaryPath("onnxruntime") ? { core: resolveBinaryPath("onnxruntime") } : {}),
      ...(resolveBinaryPath("onnxruntime_providers_shared")
        ? { providersShared: resolveBinaryPath("onnxruntime_providers_shared") }
        : {}),
      ...(resolveBinaryPath("onnxruntime_providers_cuda")
        ? { providersCuda: resolveBinaryPath("onnxruntime_providers_cuda") }
        : {}),
    },
    cuda: cudaProviderDependencyStatus(),
    summary: describeCudaProviderDependencies(),
    note:
      "Resolved dependencies mean ORT can LOAD the CUDA execution provider, not that any given session ran on the GPU. " +
      "The engine logs '[omni][onnx_model_host] ... CUDA execution provider unavailable ...; falling back to CPU provider' " +
      "when it does not, and neural ops work either way.",
  };
}

function resolveEngine(engines: CreativeEngineRecord, name: string): EngineRuntime {
  const engine = engines[name];
  if (!engine) {
    throw new Error(`unknown engine '${name}' (expected one of: ${ENGINE_NAMES.join(", ")})`);
  }
  return engine;
}

function parseJsonOption(value: string | undefined, flag: string): unknown {
  if (value === undefined || value === "") {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid JSON for ${flag}: ${message}`, { cause: err });
  }
}

function manifestSummary(manifest: {
  total_items: number;
  succeeded: number;
  failed: number;
  output_dir: string;
}) {
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
