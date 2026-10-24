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
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import sharp from "sharp";
import {
  getCreativeCapability,
  validateCreativeGraph,
  validateOperationParameters,
} from "./capabilities.js";
import { resolveFfprobe, runCapture, type CodecConfig } from "./ffi/codec.js";
import type { EngineRuntime } from "./runtime/engine-runtime.js";

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
    private engines: Record<string, EngineRuntime>,
    private codec?: CodecConfig,
    private projects?: PluginStateKeyedStore<CreativeProject>,
  ) {}

  async snapshot() {
    const runs = (await this.runs.entries())
      .map((entry) => entry.value)
      .toSorted((a, b) => b.artifact.createdAt.localeCompare(a.artifact.createdAt));
    const assets = (await this.sources.entries()).map((entry) => entry.value);
    const now = new Date().toISOString();
    const project: CreativeProject = {
      schemaVersion: 1,
      id: PROJECT_ID,
      name: "Creative Studio",
      rootDirectory: ".",
      createdAt: (await this.projects?.lookup(PROJECT_ID))?.createdAt ?? now,
      updatedAt: runs[0]?.artifact.createdAt ?? now,
      assetIds: assets.map((source) => source.asset.id),
      artifactIds: runs.map((run) => run.artifact.id),
      graphIds: runs.map((run) => run.graph.id),
      tags: [],
      ...(runs[0] ? { activeGraphId: runs[0].graph.id } : {}),
    };
    return {
      project,
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

  async run(params: Record<string, unknown>) {
    const engineName = typeof params.engine === "string" ? params.engine : "";
    const op = typeof params.op === "string" ? params.op : "";
    const input = typeof params.input === "string" ? params.input.trim() : "";
    const output = typeof params.output === "string" ? params.output.trim() : "";
    const capability = getCreativeCapability(`${engineName}.${op}`);
    const engine = this.engines[engineName];
    if (!capability || !engine || !input) {
      throw new Error("Select an operation and input file");
    }
    const raw = params.params;
    if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) {
      throw new Error("Operation params must be an object");
    }
    const validation = validateOperationParameters(
      capability,
      (raw ?? {}) as Record<string, unknown>,
    );
    if (!validation.valid) {
      throw new Error(validation.errors.join("; "));
    }
    await engine.ensureStarted();
    if (!engine.isAvailable()) {
      throw new Error(engine.reason() ?? "Engine unavailable");
    }
    const outputPort = Object.entries(capability.outputs)[0];
    if (!outputPort || !["image", "video", "audio", "vector"].includes(outputPort[1].dataType)) {
      throw new Error(
        "This operation needs a specialized editor; choose a file-producing operation",
      );
    }
    const kind = outputPort[1].dataType;
    const source = await this.importSource(input, engineName);
    const parent = (await this.runs.entries())
      .map((entry) => entry.value.artifact)
      .find((artifact) => artifact.contentHash === source.asset.contentHash);
    const now = new Date().toISOString();
    const id = randomUUID();
    const graph: CreativeGraph = {
      schemaVersion: 1,
      id: `graph-${id}`,
      projectId: PROJECT_ID,
      name: capability.label,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      metadata: {},
      nodes: [
        {
          id: "operation",
          capability: capability.id,
          capabilityVersion: capability.version,
          parameters: validation.resolvedParams,
        },
      ],
      inputs: [
        {
          name: "source",
          dataType: engineName as "image" | "audio" | "video" | "vector",
          required: true,
        },
      ],
      outputs: [{ name: "result", dataType: outputPort[1].dataType, required: true }],
      edges: [
        {
          id: "input",
          sourceNodeId: `graph-${id}`,
          sourcePort: "source",
          targetNodeId: "operation",
          targetPort: "source",
        },
        {
          id: "output",
          sourceNodeId: "operation",
          sourcePort: outputPort[0],
          targetNodeId: `graph-${id}`,
          targetPort: "result",
        },
      ],
    };
    const preflight = validateCreativeGraph(graph);
    if (!preflight.valid) {
      throw new Error(preflight.issues.map((issue) => issue.message).join("; "));
    }
    const extension =
      kind === "image" ? ".png" : kind === "audio" ? ".wav" : kind === "video" ? ".mp4" : ".svg";
    const uri = `artifacts/${id}${extension}`;
    const artifactPath = join(this.root, uri);
    await mkdir(join(this.root, "artifacts"), { recursive: true });
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
    const result = await engine.apply(
      join(this.root, source.asset.uri),
      op,
      artifactPath,
      validation.resolvedParams,
    );
    if (!result.ok) {
      throw new Error(result.reason ?? "Operation failed");
    }
    const artifact: CreativeArtifact = {
      schemaVersion: 1,
      id,
      projectId: PROJECT_ID,
      kind,
      role: "final",
      uri,
      mediaType: mediaType(artifactPath),
      ...(await fileIdentity(artifactPath)),
      createdAt: new Date().toISOString(),
      createdBy: "engine",
      graphId: graph.id,
      nodeId: "operation",
      sourceAssetIds: parent?.sourceAssetIds ?? [source.asset.id],
      parentArtifactIds: parent ? [parent.id] : [],
      operation: {
        capability: capability.id,
        version: capability.version,
        parameters: validation.resolvedParams,
      },
      metadata: { durationMs: result.duration_ms, enginePath: result.engine_path },
    };
    if (output) {
      await copyFile(artifactPath, resolve(output), constants.COPYFILE_EXCL);
    }
    const record: Run = {
      graph,
      artifact,
      input: source.originalPath,
      output: output ? resolve(output) : artifactPath,
    };
    await this.runs.register(id, record);
    // The project record stays small; asset/graph/artifact relationships are
    // materialized from their durable rows when Studio reloads.
    await this.projects?.registerIfAbsent(PROJECT_ID, {
      schemaVersion: 1,
      id: PROJECT_ID,
      name: "Creative Studio",
      rootDirectory: ".",
      createdAt: now,
      updatedAt: now,
      assetIds: [],
      graphIds: [],
      artifactIds: [],
      tags: [],
    });
    return { ...result, output: record.output, message: record.output, artifact, graph };
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
  engines: Record<string, EngineRuntime>,
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
  );
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
