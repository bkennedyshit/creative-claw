import type {
  CreativeCapabilityDescriptor,
  CreativeGraph,
  CreativeGraphNode,
} from "@openclaw/creative-contracts";
import type {
  CreativeMedia,
  CreativeStudioController,
  CreativeStudioHost,
} from "./creative-studio.ts";

type FileType = "image" | "audio" | "video" | "vector";
const FILE_TYPES = new Set(["image", "audio", "video", "vector"]);
type Connection = { node: string; port: string; label: string };
export type CreativeRecipe = {
  id: string;
  name: string;
  category: string;
  description: string;
  sourceType: FileType;
  operations: string[];
  note?: string;
};

/** Canonical graph editing state; the gateway remains authoritative for validation. */
export class CreativeWorkflowController {
  graph?: CreativeGraph;
  saved: CreativeGraph[] = [];
  archived: CreativeGraph[] = [];
  confirmArchive = false;
  dirty = false;
  busy = false;
  message = "";
  issues: string[] = [];
  private validationPassed = false;
  selectedNodeId = "";
  recipes: CreativeRecipe[] = [];
  recipeQuery = "";
  recipeCategory = "All";
  paletteQuery = "";
  paletteAllMedia = false;
  canvasWidth = 800;
  private viewport?: Element;
  private resizeObserver?: ResizeObserver;
  readonly observeViewport = (element?: Element) => {
    if (element === this.viewport) {
      return;
    }
    this.resizeObserver?.disconnect();
    this.viewport = element;
    if (!element || typeof ResizeObserver === "undefined") {
      return;
    }
    this.resizeObserver = new ResizeObserver(([entry]) => {
      const width = Math.floor(entry.contentRect.width);
      if (width > 0 && width !== this.canvasWidth) {
        this.canvasWidth = width;
        this.host.requestUpdate();
      }
    });
    this.resizeObserver.observe(element);
  };
  private drag?: { id: string; x: number; y: number; origin: { x: number; y: number } };

  constructor(
    private host: CreativeStudioHost,
    private studio: CreativeStudioController,
  ) {}

  get capabilities(): CreativeCapabilityDescriptor[] {
    return Object.values(this.studio.engines).flatMap((engine) =>
      engine.ops.flatMap((op) => {
        const cap = op.capability;
        return cap &&
          Object.keys(cap.inputs).length === 1 &&
          Object.keys(cap.outputs).length === 1 &&
          Object.values(cap.inputs).every((port) => FILE_TYPES.has(port.dataType)) &&
          Object.values(cap.outputs).every((port) => FILE_TYPES.has(port.dataType))
          ? [cap]
          : [];
      }),
    );
  }

  capability(id: string) {
    return this.capabilities.find((cap) => cap.id === id);
  }

  private matchesMedia(source: string, operations: string[], media = this.studio.activeMedia) {
    if (
      media === "audio" &&
      operations.some((id) =>
        Object.values(this.capability(id)?.outputs ?? {}).some((port) => port.dataType === "audio"),
      )
    ) {
      return true;
    }
    return media === "ai" || media === "vfx"
      ? operations.some((operation) => operation.startsWith(`${media}.`))
      : source === media;
  }

  get mediaRecipes() {
    return this.recipes.filter((recipe) => this.matchesMedia(recipe.sourceType, recipe.operations));
  }

  get mediaSaved() {
    return this.saved.filter((graph) =>
      this.matchesMedia(
        graph.inputs[0].dataType,
        graph.nodes.map((node) => node.capability),
      ),
    );
  }

  get paletteCapabilities() {
    const available = new Set([this.graph?.inputs[0].dataType]);
    for (const node of this.graph?.nodes ?? []) {
      for (const port of Object.values(this.capability(node.capability)?.outputs ?? {})) {
        available.add(port.dataType);
      }
    }
    return this.capabilities.filter(
      (cap) =>
        (this.paletteAllMedia || cap.id.startsWith(`${this.studio.activeMedia}.`)) &&
        available.has(Object.values(cap.inputs)[0].dataType),
    );
  }

  switchMedia() {
    this.recipeCategory = "All";
    this.recipeQuery = this.paletteQuery = "";
    this.paletteAllMedia = false;
    this.confirmArchive = false;
    const saved = this.mediaSaved[0];
    if (saved) {
      this.select(saved.id);
    } else {
      this.create(
        this.studio.activeMedia === "ai" || this.studio.activeMedia === "vfx"
          ? "image"
          : this.studio.activeMedia,
      );
      // Merely visiting a studio must not create unsaved work that blocks the next tab.
      this.dirty = false;
    }
  }

  discard() {
    if (this.busy || this.studio.running) {
      return;
    }
    const saved = this.saved.find((entry) => entry.id === this.graph?.id);
    if (saved) {
      this.select(saved.id);
    } else {
      this.switchMedia();
    }
    this.message = "Draft changes discarded. Saved workflows and media are unchanged.";
    this.host.requestUpdate();
  }

  editPaths(patch: { input?: string; output?: string }) {
    this.studio.updateRunForm(patch);
    if (this.graph) {
      this.graph.metadata.sourcePath = this.studio.runForm.input;
      this.graph.metadata.exportPath = this.studio.runForm.output;
      this.touch();
    }
  }

  async setArchived(graph: CreativeGraph, archived: boolean) {
    if (
      !this.host.client ||
      !this.host.connected ||
      this.busy ||
      this.studio.running ||
      this.dirty
    ) {
      return;
    }
    this.busy = true;
    this.host.requestUpdate();
    try {
      const result = await this.host.client.request<{ graph?: CreativeGraph; error?: string }>(
        "creative.studio.graph.archive",
        { id: graph.id, revision: graph.revision, archived },
      );
      if (!result.graph || result.error) {
        throw new Error(result.error || "Workflow could not be updated");
      }
      this.saved = this.saved.filter((entry) => entry.id !== graph.id);
      this.archived = this.archived.filter((entry) => entry.id !== graph.id);
      (archived ? this.archived : this.saved).unshift(result.graph);
      this.busy = false;
      if (archived) {
        this.switchMedia();
      } else {
        this.select(result.graph.id);
      }
      this.confirmArchive = false;
      this.message = archived
        ? "Workflow moved to archive. Restore it below; source files and outputs are kept."
        : "Workflow restored.";
    } catch (error) {
      this.message = String(error);
    } finally {
      this.busy = false;
      this.host.requestUpdate();
    }
  }

  async loadRecipes() {
    if (!this.host.client || !this.host.connected) {
      return;
    }
    try {
      const result = await this.host.client.request<{ recipes?: CreativeRecipe[] }>(
        "creative.studio.recipes",
        {},
      );
      this.recipes = result.recipes ?? [];
    } catch {
      this.recipes = [];
    }
    this.host.requestUpdate();
  }

  filterRecipes(query: string, category = this.recipeCategory) {
    this.recipeQuery = query;
    this.recipeCategory = category;
    this.host.requestUpdate();
  }

  filterPalette(query: string) {
    this.paletteQuery = query;
    this.host.requestUpdate();
  }

  get filteredRecipes() {
    const query = this.recipeQuery.toLowerCase().trim();
    return this.mediaRecipes.filter(
      (recipe) =>
        (this.recipeCategory === "All" || recipe.category === this.recipeCategory) &&
        `${recipe.name} ${recipe.description} ${recipe.operations.join(" ")}`
          .toLowerCase()
          .includes(query),
    );
  }

  recipeUnavailable(recipe: CreativeRecipe) {
    const missing = [
      ...new Set(recipe.operations.map((operation) => operation.split(".")[0])),
    ].filter(
      (engine) => !this.studio.engines[engine as keyof typeof this.studio.engines]?.available,
    );
    return missing.length ? `Requires available engine: ${missing.join(", ")}` : "";
  }

  async useRecipe(id: string) {
    if (this.dirty || this.busy || this.studio.running) {
      return;
    }
    await this.adoptGraph("creative.studio.recipe.create", {
      id,
      input: this.studio.runForm.input,
    });
  }

  async duplicate() {
    if (!this.graph || this.busy || this.studio.running) {
      return;
    }
    await this.adoptGraph("creative.studio.graph.copy", {
      graph: {
        ...this.graph,
        metadata: { ...this.graph.metadata, sourcePath: this.studio.runForm.input },
      },
    });
  }

  async importGraph(text: string) {
    if (this.dirty || this.busy || this.studio.running) {
      return;
    }
    try {
      if (text.length > 65536) {
        throw new Error("Workflow JSON exceeds 64 KB");
      }
      await this.adoptGraph("creative.studio.graph.copy", { graph: JSON.parse(text) as unknown });
    } catch (error) {
      this.message = String(error);
      this.host.requestUpdate();
    }
  }

  private async adoptGraph(method: string, params: Record<string, unknown>) {
    if (!this.host.client || !this.host.connected) {
      return;
    }
    this.busy = true;
    this.host.requestUpdate();
    try {
      const result = await this.host.client.request<{ graph?: CreativeGraph; error?: string }>(
        method,
        params,
      );
      if (!result.graph || result.error) {
        throw new Error(result.error || "Workflow could not be loaded");
      }
      this.saved = [result.graph, ...this.saved.filter((entry) => entry.id !== result.graph!.id)];
      this.busy = false;
      this.dirty = false;
      this.select(result.graph.id);
      this.studio.updateRunForm({ output: "" });
      this.message = "Workflow loaded. Set your source, adjust any node, then run.";
    } catch (error) {
      this.message = String(error);
    } finally {
      this.busy = false;
      this.host.requestUpdate();
    }
  }

  exportGraph() {
    if (!this.graph) {
      return;
    }
    const graph = {
      ...this.graph,
      metadata: { ...this.graph.metadata, sourcePath: this.studio.runForm.input },
    };
    const blob = new Blob([JSON.stringify(graph, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${this.graph.name.replace(/[^a-z0-9-]+/gi, "-") || "workflow"}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  restore(graphs: CreativeGraph[], activeId?: string, archived: CreativeGraph[] = []) {
    this.saved = graphs;
    this.archived = archived;
    if (!this.graph && !this.dirty) {
      // An inline operation can be active without being an editable saved workflow.
      // Do not replace its restored source/parameters with an unrelated saved graph.
      const active = activeId ? graphs.find((graph) => graph.id === activeId) : graphs[0];
      if (active) {
        this.select(active.id);
      }
    }
  }

  select(id: string) {
    const graph = this.saved.find((entry) => entry.id === id);
    if (!graph || this.busy || this.studio.running) {
      return;
    }
    this.graph = structuredClone(graph);
    this.confirmArchive = false;
    this.dirty = false;
    this.issues = [];
    this.message = "";
    this.selectedNodeId = graph.nodes[0]?.id ?? "";
    const media = graph.inputs[0].dataType;
    if (
      FILE_TYPES.has(media) &&
      !this.matchesMedia(
        media,
        graph.nodes.map((node) => node.capability),
      )
    ) {
      this.studio.activeMedia = media as CreativeMedia;
    }
    this.studio.lastResult = undefined;
    this.studio.lastNodes = [];
    const source = graph.metadata.sourcePath;
    if (typeof source === "string") {
      this.studio.updateRunForm({ input: source });
    }
    this.studio.updateRunForm({
      output: typeof graph.metadata.exportPath === "string" ? graph.metadata.exportPath : "",
    });
    this.host.requestUpdate();
  }

  create(kind: FileType = "image") {
    if (this.busy || this.studio.running) {
      return;
    }
    const now = new Date().toISOString();
    this.graph = {
      schemaVersion: 1,
      id: `workflow-${crypto.randomUUID()}`,
      projectId: "studio",
      name: "Untitled workflow",
      revision: 0,
      createdAt: now,
      updatedAt: now,
      nodes: [],
      edges: [],
      inputs: [{ name: "source", dataType: kind, required: true }],
      outputs: [{ name: "result", dataType: kind, required: true }],
      metadata: { sourcePath: this.studio.runForm.input },
    };
    this.selectedNodeId = "";
    this.studio.lastResult = undefined;
    this.studio.lastNodes = [];
    this.touch();
  }

  rename(name: string) {
    if (!this.graph) {
      return;
    }
    this.graph.name = name.trim() || "Untitled workflow";
    this.touch();
  }

  setSourceType(kind: FileType) {
    if (!this.graph) {
      return;
    }
    this.graph.inputs[0].dataType = kind;
    if (this.studio.activeMedia !== "ai" && this.studio.activeMedia !== "vfx") {
      this.studio.activeMedia = kind;
      this.recipeCategory = "All";
    }
    this.touch();
  }

  add(capabilityId: string) {
    const cap = this.capability(capabilityId);
    if (!cap) {
      return;
    }
    if (!this.graph) {
      this.create(Object.values(cap.inputs)[0].dataType as FileType);
    }
    const graph = this.graph!;
    if (graph.nodes.length >= 32) {
      this.message = "Workflows support at most 32 nodes";
      this.host.requestUpdate();
      return;
    }
    const parameters: Record<string, unknown> = {};
    const properties = cap.parametersSchema.properties as
      | Record<string, { default?: unknown }>
      | undefined;
    for (const [key, property] of Object.entries(properties ?? {})) {
      if (property.default !== undefined) {
        parameters[key] = property.default;
      }
    }
    const node: CreativeGraphNode = {
      id: `node-${crypto.randomUUID()}`,
      capability: cap.id,
      parameters,
      position: { x: 30 + graph.nodes.length * 230, y: 55 },
    };
    const previous = graph.edges.find((edge) => edge.targetNodeId === graph.id);
    graph.nodes.push(node);
    const input = Object.entries(cap.inputs)[0];
    const output = Object.entries(cap.outputs)[0];
    const candidates = this.connections(input[1].dataType, node.id);
    const upstream =
      candidates.find((candidate) => candidate.node === previous?.sourceNodeId) ??
      candidates.find((candidate) => candidate.node === graph.id);
    if (upstream) {
      this.connect(node.id, upstream.node, upstream.port);
    }
    graph.outputs[0].dataType = output[1].dataType;
    this.connect(graph.id, node.id, output[0]);
    this.selectedNodeId = node.id;
    this.touch();
  }

  remove(id: string) {
    if (!this.graph) {
      return;
    }
    this.graph.nodes = this.graph.nodes.filter((node) => node.id !== id);
    this.graph.edges = this.graph.edges.filter(
      (edge) => edge.sourceNodeId !== id && edge.targetNodeId !== id,
    );
    this.selectedNodeId = "";
    this.touch();
  }

  parameters(id: string, patch: Record<string, unknown>) {
    const node = this.graph?.nodes.find((entry) => entry.id === id);
    if (!node) {
      return;
    }
    node.parameters = { ...node.parameters, ...patch };
    this.touch();
  }

  connections(dataType: string, exclude = ""): Connection[] {
    const graph = this.graph;
    if (!graph) {
      return [];
    }
    const candidates: Connection[] = [];
    if (graph.inputs[0].dataType === dataType && exclude !== graph.id) {
      candidates.push({ node: graph.id, port: graph.inputs[0].name, label: "Source file" });
    }
    for (const node of graph.nodes) {
      if (node.id === exclude) {
        continue;
      }
      const cap = this.capability(node.capability);
      for (const [port, descriptor] of Object.entries(cap?.outputs ?? {})) {
        if (descriptor.dataType === dataType) {
          candidates.push({
            node: node.id,
            port,
            label: `${node.label ?? cap?.label ?? node.capability} · ${node.id.slice(-6)}`,
          });
        }
      }
    }
    return candidates;
  }

  connect(target: string, source?: string, port?: string) {
    const graph = this.graph;
    if (!graph) {
      return;
    }
    const node = graph.nodes.find((entry) => entry.id === target);
    const targetPort =
      target === graph.id
        ? graph.outputs[0].name
        : Object.keys(this.capability(node?.capability ?? "")?.inputs ?? {})[0];
    if (!targetPort) {
      return;
    }
    graph.edges = graph.edges.filter(
      (edge) => edge.targetNodeId !== target || edge.targetPort !== targetPort,
    );
    if (source && port) {
      graph.edges.push({
        id: `edge-${crypto.randomUUID()}`,
        sourceNodeId: source,
        sourcePort: port,
        targetNodeId: target,
        targetPort,
      });
    }
    this.touch();
  }

  choose(id: string) {
    this.selectedNodeId = id;
    this.host.requestUpdate();
  }

  move(id: string, x: number, y: number) {
    const node = this.graph?.nodes.find((entry) => entry.id === id);
    if (!node) {
      return;
    }
    node.position = { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) };
    this.touch();
  }

  beginDrag(id: string, event: PointerEvent) {
    if (event.button !== 0 || this.busy || this.studio.running) {
      return;
    }
    const node = this.graph?.nodes.find((entry) => entry.id === id);
    if (!node) {
      return;
    }
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.drag = { id, x: event.clientX, y: event.clientY, origin: node.position ?? { x: 0, y: 0 } };
    this.choose(id);
  }

  dragTo(event: PointerEvent) {
    if (this.drag) {
      this.move(
        this.drag.id,
        this.drag.origin.x + event.clientX - this.drag.x,
        this.drag.origin.y + event.clientY - this.drag.y,
      );
    }
  }

  endDrag() {
    this.drag = undefined;
  }

  private touch() {
    this.validationPassed = false;
    this.dirty = true;
    this.message = "";
    this.issues = [];
    if (this.graph) {
      this.graph.updatedAt = new Date().toISOString();
    }
    this.host.requestUpdate();
  }

  async save(): Promise<boolean> {
    if (!this.graph || this.busy || !this.host.client || !this.host.connected) {
      return false;
    }
    this.busy = true;
    this.host.requestUpdate();
    try {
      const result = await this.host.client.request<{
        graph?: CreativeGraph;
        error?: string;
        validation?: { valid: boolean; issues: { message: string }[] };
      }>("creative.studio.graph.save", {
        graph: {
          ...this.graph,
          metadata: {
            ...this.graph.metadata,
            sourcePath: this.studio.runForm.input,
            exportPath: this.studio.runForm.output,
          },
        },
      });
      if (result.error || !result.graph) {
        throw new Error(result.error || "Workflow save failed");
      }
      // The editable draft must not alias the saved snapshot used by Discard edits.
      this.graph = structuredClone(result.graph);
      this.saved = [result.graph, ...this.saved.filter((entry) => entry.id !== result.graph!.id)];
      this.dirty = false;
      this.issues = result.validation?.issues.map((issue) => issue.message) ?? [];
      this.validationPassed = result.validation?.valid === true;
      this.message = `Saved revision ${result.graph.revision}${result.validation?.valid === false ? " · fix validation issues before running" : ""}`;
      return true;
    } catch (error) {
      this.message = String(error);
      return false;
    } finally {
      this.busy = false;
      this.host.requestUpdate();
    }
  }

  async run() {
    if (this.studio.running || !this.graph || !(await this.save())) {
      return;
    }
    if (!this.validationPassed) {
      return;
    }
    await this.studio.runWorkflow(this.graph);
  }
}
