import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type {
  CreativeAsset,
  CreativeArtifact,
  CreativeGraph,
  CreativeProject,
} from "@openclaw/creative-contracts";
import { CreativeGraphSchema } from "@openclaw/creative-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import sharp from "sharp";
import { Check } from "typebox/value";
import { getCreativeCapability, validateCreativeGraph } from "./capabilities.js";
import { resolveFfprobe, runCapture, type CodecConfig } from "./ffi/codec.js";
import { PipelineExecutor, type ExecutionEngine } from "./graph/executor.js";
import type { Graph } from "./graph/types.js";
import type { ExecutionContext } from "./runtime/execution.js";
import { isStudioFileType, prepareStudioGraph } from "./studio-graph.js";
import { registerStudioJobs } from "./studio-jobs.js";
import { buildStudioRecipe, STUDIO_RECIPES } from "./studio-recipes.js";

type Source = { asset: CreativeAsset; originalPath: string };
type Run = { graph: CreativeGraph; artifact: CreativeArtifact; input: string; output: string };
const PROJECT_ID = "studio";
const ARTIFACT_ROUTE = "/plugins/creative-engines/artifacts/";

async function fileIdentity(path: string) {
  const info = await stat(path);
  if (!info.isFile() || info.size === 0) {
    throw new Error("Expected a nonempty media file");
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return { contentHash: `sha256:${hash.digest("hex")}`, byteLength: info.size };
}

function mediaType(path: string): string {
  const types: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".svg": "image/svg+xml",
  };
  return types[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Studio owns immutable source copies and finalized artifacts; SQLite owns their lineage. */
export class CreativeStudio {
  constructor(
    private root: string,
    private sources: PluginStateKeyedStore<Source>,
    private runs: PluginStateKeyedStore<Run>,
    private engines: Record<string, ExecutionEngine>,
    private codec?: CodecConfig,
    private projects?: PluginStateKeyedStore<CreativeProject>,
    private graphs?: PluginStateKeyedStore<CreativeGraph>,
  ) {}

  async snapshot() {
    const runs = (await this.runs.entries())
      .map((entry) => entry.value)
      .toSorted((a, b) => b.artifact.createdAt.localeCompare(a.artifact.createdAt));
    const assets = (await this.sources.entries()).map((entry) => entry.value);
    const now = new Date().toISOString();
    const persistedProject = await this.projects?.lookup(PROJECT_ID);
    const graphs = ((await this.graphs?.entries()) ?? []).map((entry) => entry.value);
    const project: CreativeProject = {
      schemaVersion: 1,
      id: PROJECT_ID,
      name: "Creative Studio",
      rootDirectory: ".",
      createdAt: persistedProject?.createdAt ?? now,
      updatedAt: runs[0]?.artifact.createdAt ?? now,
      assetIds: assets.map((source) => source.asset.id),
      artifactIds: runs.map((run) => run.artifact.id),
      graphIds: [
        ...new Set([...graphs.map((graph) => graph.id), ...runs.map((run) => run.graph.id)]),
      ],
      tags: [],
      ...(persistedProject?.activeGraphId
        ? { activeGraphId: persistedProject.activeGraphId }
        : runs[0]
          ? { activeGraphId: runs[0].graph.id }
          : {}),
    };
    return {
      project,
      graphs,
      projectId: PROJECT_ID,
      assets: assets.slice(-50),
      runs: runs.slice(0, 12),
      results: runs.slice(0, 12).map(({ artifact, output }) => ({
        id: artifact.id,
        path: output,
        type: artifact.kind,
        previewUrl: `${ARTIFACT_ROUTE}${artifact.id}`,
        operation: artifact.operation,
      })),
    };
  }

  async importSource(input: string, kind: CreativeAsset["kind"]): Promise<Source> {
    const originalPath = resolve(input);
    const identity = await fileIdentity(originalPath);
    const digest = identity.contentHash.slice("sha256:".length);
    const id = `asset-${digest}`;
    const existing = await this.sources.lookup(id);
    if (existing) {
      return existing;
    }
    const uri = `sources/${digest}${extname(originalPath).toLowerCase()}`;
    const target = join(this.root, uri);
    await mkdir(join(this.root, "sources"), { recursive: true });
    try {
      await copyFile(originalPath, target, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    // Hash the preserved copy too: importing a source being edited must never
    // associate one file's identity with another file's bytes.
    if ((await fileIdentity(target)).contentHash !== identity.contentHash) {
      throw new Error("Source changed during import; retry after the source is saved");
    }
    const metadata: Record<string, unknown> = {};
    if (kind === "image") {
      const image = await sharp(target).metadata();
      if (image.width) {
        metadata.width = image.width;
      }
      if (image.height) {
        metadata.height = image.height;
      }
    } else if (kind === "audio" || kind === "video") {
      const probe = await runCapture(resolveFfprobe(this.codec), [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_name,codec_type,width,height,sample_rate",
        "-of",
        "json",
        target,
      ]);
      metadata.media = JSON.parse(probe.toString("utf8")) as unknown;
    }
    const source: Source = {
      originalPath,
      asset: {
        schemaVersion: 1,
        id,
        kind,
        uri,
        ...identity,
        mediaType: mediaType(target),
        importedAt: new Date().toISOString(),
        metadata,
        source: "user",
      },
    };
    await this.sources.register(id, source);
    return source;
  }

  async saveGraph(value: unknown) {
    if (!this.graphs || !Check(CreativeGraphSchema, value) || value.projectId !== PROJECT_ID) {
      throw new Error("Expected a canonical Studio graph");
    }
    if (
      value.inputs.length !== 1 ||
      value.outputs.length !== 1 ||
      !isStudioFileType(value.inputs[0].dataType) ||
      !isStudioFileType(value.outputs[0].dataType)
    ) {
      throw new Error("Studio workflows need one source file input and one result output");
    }
    const existing = await this.graphs.lookup(value.id);
    const graph: CreativeGraph = {
      ...structuredClone(value),
      revision: value.revision + 1,
      createdAt: existing?.createdAt ?? value.createdAt,
      updatedAt: new Date().toISOString(),
    };
    if (existing) {
      if (!this.graphs.update) {
        throw new Error("Graph store does not support atomic updates");
      }
      const accepted = await this.graphs.update(value.id, (current) =>
        current?.revision === value.revision ? graph : undefined,
      );
      if (!accepted) {
        throw new Error("Workflow changed elsewhere; reload before saving");
      }
    } else if (!(await this.graphs.registerIfAbsent(graph.id, graph))) {
      throw new Error("Workflow changed elsewhere; reload before saving");
    }
    await this.activateGraph(graph);
    let validation = validateCreativeGraph(graph);
    if (validation.valid) {
      try {
        prepareStudioGraph(graph);
      } catch (error) {
        validation = {
          valid: false,
          issues: [
            {
              code: "invalid-graph",
              severity: "error",
              message: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    }
    return { graph, validation };
  }

  async getGraph(id: string) {
    const graph = await this.graphs?.lookup(id);
    if (!graph) {
      throw new Error("Workflow not found");
    }
    return graph;
  }

  private async activateGraph(graph: CreativeGraph) {
    const existing = await this.projects?.lookup(PROJECT_ID);
    await this.projects?.register(PROJECT_ID, {
      schemaVersion: 1,
      id: PROJECT_ID,
      name: "Creative Studio",
      rootDirectory: ".",
      createdAt: existing?.createdAt ?? graph.createdAt,
      updatedAt: graph.updatedAt,
      assetIds: [],
      graphIds: [],
      artifactIds: [],
      tags: [],
      activeGraphId: graph.id,
    });
  }

  async copyGraph(value: unknown) {
    if (!Check(CreativeGraphSchema, value)) {
      throw new Error("Expected a canonical workflow JSON document");
    }
    const graph = structuredClone(value);
    const originalId = graph.id;
    graph.id = `workflow-${randomUUID()}`;
    graph.projectId = PROJECT_ID;
    graph.name = `${graph.name} (copy)`;
    graph.revision = 0;
    graph.createdAt = graph.updatedAt = new Date().toISOString();
    for (const edge of graph.edges) {
      if (edge.sourceNodeId === originalId) {
        edge.sourceNodeId = graph.id;
      }
      if (edge.targetNodeId === originalId) {
        edge.targetNodeId = graph.id;
      }
    }
    return this.saveGraph(graph);
  }

  async run(params: Record<string, unknown>) {
    const input = typeof params.input === "string" ? params.input.trim() : "";
    const output = typeof params.output === "string" ? params.output.trim() : "";
    const capability = getCreativeCapability(
      `${typeof params.engine === "string" ? params.engine : ""}.${typeof params.op === "string" ? params.op : ""}`,
    );
    if (!capability || !input) {
      throw new Error("Select an operation and input file");
    }
    const raw = params.params;
    if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) {
      throw new Error("Operation params must be an object");
    }
    const sourcePort = Object.entries(capability.inputs)[0];
    const outputPort = Object.entries(capability.outputs)[0];
    if (!sourcePort || !outputPort) {
      throw new Error("This operation needs a specialized editor");
    }
    const id = `graph-${randomUUID()}`;
    const now = new Date().toISOString();
    const graph: CreativeGraph = {
      schemaVersion: 1,
      id,
      projectId: PROJECT_ID,
      name: capability.label,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      metadata: { sourcePath: input },
      nodes: [
        {
          id: "operation",
          capability: capability.id,
          capabilityVersion: capability.version,
          parameters: (raw ?? {}) as Record<string, unknown>,
          position: { x: 250, y: 80 },
        },
      ],
      inputs: [{ name: "source", dataType: sourcePort[1].dataType, required: true }],
      outputs: [{ name: "result", dataType: outputPort[1].dataType, required: true }],
      edges: [
        {
          id: "input",
          sourceNodeId: id,
          sourcePort: "source",
          targetNodeId: "operation",
          targetPort: sourcePort[0],
        },
        {
          id: "output",
          sourceNodeId: "operation",
          sourcePort: outputPort[0],
          targetNodeId: id,
          targetPort: "result",
        },
      ],
    };
    return this.runGraph(graph, input, output);
  }

  async runGraph(value: unknown, input: string, output = "", context: ExecutionContext = {}) {
    context.signal?.throwIfAborted();
    const { graph, capabilities } = prepareStudioGraph(value);
    if (!input.trim()) {
      throw new Error("Workflow source path is required");
    }
    const sourceType = graph.inputs[0].dataType;
    if (!isStudioFileType(sourceType)) {
      throw new Error("Unsupported source media type");
    }
    for (const cap of capabilities.values()) {
      const engine = this.engines[cap.id.split(".")[0]];
      if (!engine) {
        throw new Error(`Engine unavailable for ${cap.id}`);
      }
      await engine.ensureStarted();
      if (!engine.isAvailable()) {
        throw new Error(engine.reason() ?? "Engine unavailable");
      }
    }
    if (output) {
      try {
        await stat(resolve(output));
        throw new Error("Output already exists; choose a new path to preserve existing files");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
    const source = await this.importSource(input, sourceType);
    const previousArtifact = (await this.runs.entries())
      .map((entry) => entry.value.artifact)
      .find((artifact) => artifact.contentHash === source.asset.contentHash);
    const graphRunId = randomUUID();
    const ids = new Map([...capabilities.keys()].map((nodeId) => [nodeId, randomUUID()]));
    const extensions = { image: ".png", video: ".mp4", audio: ".wav", vector: ".svg" };
    await mkdir(join(this.root, "artifacts"), { recursive: true });
    const plan: Graph = {
      id: graph.id,
      nodes: graph.nodes
        .filter((node) => capabilities.has(node.id))
        .map((node) => {
          const cap = capabilities.get(node.id)!;
          const type = Object.values(cap.outputs)[0].dataType;
          if (!isStudioFileType(type)) {
            throw new Error("Unsupported result media type");
          }
          const incoming = graph.edges.find((edge) => edge.targetNodeId === node.id);
          return Object.assign(
            {
              id: node.id,
              engine: cap.id.split(".")[0] as Graph["nodes"][number]["engine"],
              op: cap.id.split(".").slice(1).join("."),
              params: node.parameters,
            },
            incoming?.sourceNodeId === graph.id ? { input: join(this.root, source.asset.uri) } : {},
            { output: join(this.root, "artifacts", `${ids.get(node.id)}${extensions[type]}`) },
          );
        }),
      connections: graph.edges
        .filter(
          (edge) => capabilities.has(edge.sourceNodeId) && capabilities.has(edge.targetNodeId),
        )
        .map((edge) => ({
          from_node: edge.sourceNodeId,
          from_output: edge.sourcePort,
          to_node: edge.targetNodeId,
          to_input: edge.targetPort,
        })),
    };
    const execution = await new PipelineExecutor(this.engines).execute(plan, context);
    const resultEdge = graph.edges.find(
      (edge) => edge.targetNodeId === graph.id && edge.targetPort === graph.outputs[0].name,
    )!;
    const artifacts = new Map<string, CreativeArtifact>();
    let finalRun: Run | undefined;
    for (const result of execution.nodes) {
      if (result.status !== "ok" || !result.output_path) {
        continue;
      }
      const cap = capabilities.get(result.node_id)!;
      const type = Object.values(cap.outputs)[0].dataType;
      if (!isStudioFileType(type)) {
        throw new Error("Unsupported result media type");
      }
      const edge = graph.edges.find((item) => item.targetNodeId === result.node_id);
      const parent =
        edge?.sourceNodeId === graph.id
          ? previousArtifact
          : artifacts.get(edge?.sourceNodeId ?? "");
      const id = ids.get(result.node_id)!;
      const final = result.node_id === resultEdge.sourceNodeId;
      const artifact: CreativeArtifact = {
        schemaVersion: 1,
        id,
        projectId: PROJECT_ID,
        kind: type,
        role: final ? "final" : "intermediate",
        uri: `artifacts/${id}${extensions[type]}`,
        mediaType: mediaType(result.output_path),
        ...(await fileIdentity(result.output_path)),
        createdAt: new Date().toISOString(),
        createdBy: "engine",
        graphId: graph.id,
        graphRunId,
        nodeId: result.node_id,
        sourceAssetIds: parent?.sourceAssetIds ?? [source.asset.id],
        parentArtifactIds: parent ? [parent.id] : [],
        operation: {
          capability: cap.id,
          version: cap.version,
          parameters: graph.nodes.find((node) => node.id === result.node_id)!.parameters,
        },
        metadata: {
          ...result.metadata,
          durationMs: result.duration_ms ?? 0,
          ...(result.engine_path ? { enginePath: result.engine_path } : {}),
        },
      };
      const record: Run = {
        graph,
        artifact,
        input: source.originalPath,
        output: final && output ? resolve(output) : result.output_path,
      };
      if (final && output) {
        await copyFile(result.output_path, resolve(output), constants.COPYFILE_EXCL);
      }
      await this.runs.register(id, record);
      artifacts.set(result.node_id, artifact);
      if (final) {
        finalRun = record;
      }
    }
    await this.activateGraph(graph);
    if (!execution.ok || !finalRun) {
      context.signal?.throwIfAborted();
      const failure = execution.nodes.find((node) => node.status === "failed");
      throw new Error(
        failure
          ? `Node ${failure.node_id}: ${failure.error}`
          : "Workflow did not produce its result",
      );
    }
    return {
      ok: true,
      output: finalRun.output,
      output_path: finalRun.output,
      message: finalRun.output,
      artifact: finalRun.artifact,
      graph,
      nodes: execution.nodes,
      duration_ms: execution.total_duration_ms,
    };
  }

  async artifactFile(id: string) {
    const run = await this.runs.lookup(id);
    if (!run) {
      return undefined;
    }
    return { path: join(this.root, run.artifact.uri), mediaType: run.artifact.mediaType };
  }
}

export function registerCreativeStudio(
  api: OpenClawPluginApi,
  engines: Record<string, ExecutionEngine>,
  codec?: CodecConfig,
) {
  const studio = new CreativeStudio(
    join(api.runtime.state.resolveStateDir(), "creative-claw", "projects", PROJECT_ID),
    api.runtime.state.openKeyedStore<Source>({ namespace: "studio-sources", maxEntries: 10000 }),
    api.runtime.state.openKeyedStore<Run>({ namespace: "studio-runs", maxEntries: 10000 }),
    engines,
    codec,
    api.runtime.state.openKeyedStore<CreativeProject>({
      namespace: "studio-projects",
      maxEntries: 100,
    }),
    api.runtime.state.openKeyedStore<CreativeGraph>({
      namespace: "studio-graphs",
      maxEntries: 1000,
    }),
  );
  const register = (
    name: string,
    handler: (params: Record<string, unknown>) => Promise<unknown>,
  ) => {
    api.registerGatewayMethod(name, async ({ params, respond }) => {
      try {
        respond(true, await handler(params));
      } catch (error) {
        respond(true, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  };
  registerStudioJobs(api, studio);
  register("creative.studio.graph.save", (params) => studio.saveGraph(params.graph));
  register("creative.studio.recipes", async () => ({
    recipes: STUDIO_RECIPES.map(({ steps, ...recipe }) =>
      Object.assign(recipe, { operations: steps.map(([capability]) => capability) }),
    ),
  }));
  register("creative.studio.recipe.create", async (params) => {
    const graph = buildStudioRecipe(typeof params.id === "string" ? params.id : "");
    graph.metadata.sourcePath = typeof params.input === "string" ? params.input : "";
    return studio.saveGraph(graph);
  });
  register("creative.studio.graph.copy", (params) => studio.copyGraph(params.graph));
  register("creative.studio.graph.get", async (params) => ({
    graph: await studio.getGraph(typeof params.id === "string" ? params.id : ""),
  }));
  register("creative.studio.graph.run", async (params) => {
    const graph = await studio.getGraph(typeof params.id === "string" ? params.id : "");
    if (graph.revision !== params.revision) {
      throw new Error("Workflow changed elsewhere; reload before running");
    }
    return studio.runGraph(
      graph,
      typeof params.input === "string" ? params.input : "",
      typeof params.output === "string" ? params.output : "",
    );
  });
  api.registerGatewayMethod("creative.studio.snapshot", async ({ respond }) => {
    respond(true, await studio.snapshot());
  });
  api.registerGatewayMethod("creative.studio.run", async ({ params, respond }) => {
    try {
      respond(true, await studio.run(params));
    } catch (error) {
      respond(true, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  api.registerHttpRoute({
    path: ARTIFACT_ROUTE,
    match: "prefix",
    auth: "gateway",
    async handler(req, res) {
      if (req.method !== "GET") {
        res.writeHead(405).end();
        return;
      }
      const id = new URL(req.url ?? "", "http://localhost").pathname.slice(ARTIFACT_ROUTE.length);
      const file = await studio.artifactFile(id);
      if (!file) {
        res.writeHead(404).end();
        return;
      }
      try {
        const info = await stat(file.path);
        res.writeHead(200, {
          "Content-Type": file.mediaType,
          "Content-Length": info.size,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        await pipeline(createReadStream(file.path), res);
      } catch {
        if (!res.headersSent) {
          res.writeHead(404).end();
        } else {
          res.destroy();
        }
      }
    },
  });
  return studio;
}
