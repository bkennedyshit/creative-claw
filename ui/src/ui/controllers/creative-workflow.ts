import type {
  CreativeCapabilityDescriptor,
  CreativeGraph,
  CreativeGraphNode,
} from "@openclaw/creative-contracts";
import type { CreativeStudioController, CreativeStudioHost } from "./creative-studio.ts";

type FileType = "image" | "audio" | "video" | "vector";
const FILE_TYPES = new Set(["image", "audio", "video", "vector"]);
type Connection = { node: string; port: string; label: string };

/** Canonical graph editing state; the gateway remains authoritative for validation. */
export class CreativeWorkflowController {
  graph?: CreativeGraph;
  saved: CreativeGraph[] = [];
  dirty = false;
  busy = false;
  message = "";
  issues: string[] = [];
  private validationPassed = false;
  selectedNodeId = "";
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

  restore(graphs: CreativeGraph[], activeId?: string) {
    this.saved = graphs;
    if (!this.graph && !this.dirty) {
      const active = graphs.find((graph) => graph.id === activeId) ?? graphs[0];
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
    this.dirty = false;
    this.issues = [];
    this.message = "";
    this.selectedNodeId = graph.nodes[0]?.id ?? "";
    this.studio.lastResult = undefined;
    this.studio.lastNodes = [];
    const source = graph.metadata.sourcePath;
    if (typeof source === "string") {
      this.studio.updateRunForm({ input: source });
    }
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
          metadata: { ...this.graph.metadata, sourcePath: this.studio.runForm.input },
        },
      });
      if (result.error || !result.graph) {
        throw new Error(result.error || "Workflow save failed");
      }
      this.graph = result.graph;
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
