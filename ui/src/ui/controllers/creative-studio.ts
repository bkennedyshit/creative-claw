// Control UI controller manages creative studio gateway state.
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../gateway.ts";

export type CreativeMedia = "image" | "audio" | "video" | "vector";

/** Fixed media order drives the tab switcher; keep stable for deterministic UI. */
export const CREATIVE_MEDIA_ORDER: readonly CreativeMedia[] = ["image", "audio", "video", "vector"];

export type CreativeOp = {
  id: string;
  label: string;
  parametersSchema?: Record<string, unknown>;
};
export type CreativeEngineState = {
  available: boolean;
  reason?: string;
  ops: CreativeOp[];
};
export type CreativeGpuState = {
  state: string;
  usedMb: number;
  totalMb: number;
  models: string[];
  dormant: boolean;
};
export type CreativeRecentOutput = { id: string; path: string; type: string; previewUrl?: string };
export type CreativePreview = { url: string; type: string; path: string };
export type CreativeRunForm = {
  input: string;
  op: string;
  output: string;
  params: Record<string, unknown>;
};
export type CreativeRunResult = { ok: boolean; message: string };

/** Host contract: the app supplies the gateway client + connection flag. */
type CreativeStudioHost = ReactiveControllerHost & {
  client: GatewayBrowserClient | null;
  connected: boolean;
  settings?: { token?: string; gatewayUrl?: string };
};

function emptyEngine(reason: string): CreativeEngineState {
  return { available: false, reason, ops: [] };
}

function defaultEngines(reason: string): Record<CreativeMedia, CreativeEngineState> {
  return {
    image: emptyEngine(reason),
    audio: emptyEngine(reason),
    video: emptyEngine(reason),
    vector: emptyEngine(reason),
  };
}

function defaultGpu(state: string): CreativeGpuState {
  return { state, usedMb: 0, totalMb: 0, models: [], dormant: false };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeOps(value: unknown): CreativeOp[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ops: CreativeOp[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) {
      continue;
    }
    const id = asString(record.id);
    if (!id) {
      continue;
    }
    const label = asString(record.label) || asString(record.name) || id;
    const parametersSchema = asRecord(record.parametersSchema) ?? undefined;
    ops.push({
      id,
      label,
      ...(parametersSchema ? { parametersSchema } : {}),
    });
  }
  return ops;
}

function normalizeRecentOutputs(value: unknown): CreativeRecentOutput[] {
  const record = asRecord(value);
  const list = Array.isArray(value)
    ? value
    : Array.isArray(record?.items)
      ? record.items
      : Array.isArray(record?.results)
        ? record.results
        : [];
  const outputs: CreativeRecentOutput[] = [];
  for (const entry of list) {
    const row = asRecord(entry);
    if (!row) {
      continue;
    }
    const path = asString(row.path) || asString(row.uri) || asString(row.url);
    if (!path) {
      continue;
    }
    const id = asString(row.id) || path;
    const type = asString(row.type) || asString(row.mediaType) || "unknown";
    const previewUrl = asString(row.previewUrl);
    outputs.push({
      id,
      path,
      type,
      ...(previewUrl.startsWith("/plugins/creative-engines/artifacts/") ? { previewUrl } : {}),
    });
  }
  return outputs;
}

/**
 * Holds all Creative Studio view state and drives gateway RPCs. State mutations
 * call host.requestUpdate() so the Lit host re-renders; nothing is fabricated —
 * missing engines/GPU/memory degrade to honest empty/unavailable states.
 */
export class CreativeStudioController implements ReactiveController {
  private readonly host: CreativeStudioHost;

  activeMedia: CreativeMedia = "image";
  engines: Record<CreativeMedia, CreativeEngineState> = defaultEngines("Not loaded yet");
  gpu: CreativeGpuState = defaultGpu("unknown");
  recentOutputs: CreativeRecentOutput[] = [];
  runForm: CreativeRunForm = { input: "", op: "", output: "", params: {} };
  running = false;
  lastResult?: CreativeRunResult;
  library: CreativeRecentOutput[] = [];
  libraryError?: string;
  preview?: CreativePreview;
  private restored = false;

  constructor(host: CreativeStudioHost) {
    this.host = host;
    this.host.addController(this);
  }

  setActiveMedia(media: CreativeMedia) {
    if (this.activeMedia === media) {
      return;
    }
    this.activeMedia = media;
    // Reset the op selection and params so the run form matches the newly active engine.
    this.runForm = { ...this.runForm, op: "", params: {} };
    this.host.requestUpdate();
  }

  updateRunForm(patch: Partial<CreativeRunForm>) {
    let nextParams = patch.params !== undefined ? patch.params : this.runForm.params;
    // When op selection changes and caller did not supply explicit params, populate default parameters from its parametersSchema
    if (patch.op !== undefined && patch.op !== this.runForm.op && patch.params === undefined) {
      nextParams = {};
      const opObj = this.engines[this.activeMedia].ops.find((o) => o.id === patch.op);
      const schema = opObj?.parametersSchema as
        | {
            properties?: Record<string, { default?: unknown }>;
          }
        | undefined;
      if (schema?.properties) {
        for (const [k, p] of Object.entries(schema.properties)) {
          if (p.default !== undefined) {
            nextParams[k] = p.default;
          }
        }
      }
    }
    this.runForm = { ...this.runForm, ...patch, params: nextParams };
    this.host.requestUpdate();
  }

  async refresh(): Promise<void> {
    const client = this.host.client;
    if (!client || !this.host.connected) {
      this.engines = defaultEngines("Gateway not connected");
      this.gpu = defaultGpu("disconnected");
      this.recentOutputs = [];
      this.host.requestUpdate();
      return;
    }
    await Promise.allSettled([
      ...CREATIVE_MEDIA_ORDER.map((media) => this.loadEngine(client, media)),
      this.loadGpu(client),
      this.loadRecentOutputs(client),
      this.searchMedia(""),
    ]);
    this.host.requestUpdate();
  }

  async runOp(): Promise<void> {
    const client = this.host.client;
    if (!client || !this.host.connected) {
      this.lastResult = { ok: false, message: "Gateway not connected" };
      this.host.requestUpdate();
      return;
    }
    if (this.running) {
      return;
    }
    const { input, op, output, params } = this.runForm;
    if (!op) {
      this.lastResult = { ok: false, message: "Select an operation to run" };
      this.host.requestUpdate();
      return;
    }
    this.running = true;
    this.lastResult = undefined;
    this.host.requestUpdate();
    try {
      const res = await client.request<Record<string, unknown>>("creative.studio.run", {
        engine: this.activeMedia,
        op,
        input,
        output,
        params,
      });
      const record = asRecord(res) ?? {};
      const ok = record.ok !== false && record.error === undefined;
      const message =
        asString(record.message) ||
        asString(record.output) ||
        asString(record.error) ||
        (ok ? "Operation completed" : "Operation failed");
      this.lastResult = { ok, message };
      // Refresh recent outputs so a successful run surfaces immediately.
      if (ok) {
        await this.loadRecentOutputs(client);
        const artifact = asRecord(record.artifact);
        const recent = this.recentOutputs.find((entry) => entry.id === artifact?.id);
        if (recent) {
          await this.showPreview(recent);
        }
      }
    } catch (err) {
      this.lastResult = { ok: false, message: String(err) };
    } finally {
      this.running = false;
      this.host.requestUpdate();
    }
  }

  private async loadEngine(client: GatewayBrowserClient, media: CreativeMedia): Promise<void> {
    try {
      const res = await client.request<Record<string, unknown>>(`${media}.list_ops`, {});
      const record = asRecord(res) ?? {};
      const available = record.available !== false;
      const reason = asString(record.reason) || undefined;
      const ops = normalizeOps(record.ops ?? record.operations);
      this.engines = {
        ...this.engines,
        [media]: {
          available,
          reason: available ? reason : reason || "Engine unavailable",
          ops,
        },
      };
    } catch (err) {
      // A missing/rejecting RPC is treated as an unavailable engine, not fabricated data.
      this.engines = { ...this.engines, [media]: emptyEngine(String(err)) };
    }
  }

  private async loadGpu(client: GatewayBrowserClient): Promise<void> {
    try {
      const res = await client.request<Record<string, unknown>>("gpu.status", {});
      const record = asRecord(res) ?? {};
      const models = Array.isArray(record.models)
        ? record.models.map((model) => asString(model)).filter((model) => model.length > 0)
        : [];
      this.gpu = {
        state: asString(record.state) || "unknown",
        usedMb: asNumber(record.usedMb ?? record.vramUsedMb),
        totalMb: asNumber(record.totalMb ?? record.vramTotalMb),
        models,
        dormant: record.dormant === true,
      };
    } catch {
      this.gpu = defaultGpu("unavailable");
    }
  }

  private async loadRecentOutputs(client: GatewayBrowserClient): Promise<void> {
    try {
      const res = await client.request("creative.studio.snapshot", {});
      this.recentOutputs = normalizeRecentOutputs(res);
      if (!this.restored && !this.runForm.op && !this.runForm.input) {
        const snapshot = asRecord(res);
        const run = asRecord(Array.isArray(snapshot?.runs) ? snapshot.runs[0] : undefined);
        const graph = asRecord(run?.graph);
        const node = asRecord(Array.isArray(graph?.nodes) ? graph.nodes[0] : undefined);
        const [engine, op] = asString(node?.capability).split(".");
        if (CREATIVE_MEDIA_ORDER.includes(engine as CreativeMedia) && op) {
          this.activeMedia = engine as CreativeMedia;
          this.runForm = {
            input: asString(run?.input),
            op,
            output: "",
            params: asRecord(node?.parameters) ?? {},
          };
        }
      }
      this.restored = true;
    } catch {
      this.recentOutputs = [];
    }
  }

  async searchMedia(query: string) {
    if (!this.host.client || !this.host.connected) {
      return;
    }
    try {
      const result = await this.host.client.request("visual-memory.search.v1", {
        query,
        limit: 12,
      });
      this.library = normalizeRecentOutputs(result);
      this.libraryError = undefined;
    } catch (error) {
      this.libraryError = String(error);
      this.library = [];
    }
    this.host.requestUpdate();
  }

  async showPreview(output: CreativeRecentOutput) {
    if (!output.previewUrl) {
      return;
    }
    try {
      const url = new URL(this.host.settings?.gatewayUrl || window.location.href);
      url.protocol =
        url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
      url.pathname = output.previewUrl;
      url.search = "";
      url.hash = "";
      const headers = new Headers();
      const token = this.host.settings?.token?.trim();
      if (token) {
        headers.set("Authorization", `Bearer ${token}`);
      }
      const response = await fetch(url, { headers });
      if (!response.ok) {
        throw new Error(`Preview unavailable (${response.status})`);
      }
      const blob = await response.blob();
      if (this.preview) {
        URL.revokeObjectURL(this.preview.url);
      }
      this.preview = { url: URL.createObjectURL(blob), type: output.type, path: output.path };
    } catch (error) {
      this.lastResult = { ok: true, message: `Output saved. ${String(error)}` };
    }
    this.host.requestUpdate();
  }

  hostDisconnected() {
    if (this.preview) {
      URL.revokeObjectURL(this.preview.url);
    }
    this.preview = undefined;
  }
}
