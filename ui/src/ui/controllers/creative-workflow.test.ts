import type { CreativeCapabilityDescriptor, CreativeGraph } from "@openclaw/creative-contracts";
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../gateway.ts";
import { renderCreativeWorkflow } from "../views/creative-workflow.ts";
import { CreativeStudioController } from "./creative-studio.ts";

function setup() {
  const request = vi.fn(
    async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (method === "creative.studio.graph.save") {
        const graph = params.graph as CreativeGraph;
        return {
          graph: { ...graph, revision: graph.revision + 1 },
          validation: { valid: true, issues: [] },
        };
      }
      if (method === "creative.studio.snapshot") {
        return { graphs: [], results: [] };
      }
      return { ok: true, message: "done" };
    },
  );
  const host = {
    connected: true,
    client: { request } as unknown as GatewayBrowserClient,
    addController() {},
    removeController() {},
    requestUpdate: vi.fn(),
    updateComplete: Promise.resolve(true),
  };
  const studio = new CreativeStudioController(host);
  const capability = (id: string, type = "image"): CreativeCapabilityDescriptor => ({
    id,
    label: id,
    version: "1.0.0",
    family: "image",
    description: "Test operation",
    inputs: { source: { dataType: type, required: true } },
    outputs: { output: { dataType: type, required: true } },
    parametersSchema: {
      type: "object",
      properties: { amount: { type: "number", default: 1, minimum: 0 } },
    },
    execution: {
      runtime: "native",
      supportsProgress: false,
      supportsCancellation: false,
      deterministic: true,
      cacheable: true,
    },
    requirements: {},
    risk: { writesFiles: true, mayOverwrite: false, externalUpload: false, publishes: false },
  });
  studio.engines.image = {
    available: true,
    ops: ["image.invert", "image.scale"].map((id) => ({
      id,
      label: id,
      capability: capability(id),
    })),
  };
  studio.engines.video = {
    available: true,
    ops: [{ id: "video.blur", label: "video blur", capability: capability("video.blur", "video") }],
  };
  return { studio, editor: studio.workflow, request };
}

describe("Creative workflow editor", () => {
  it("adds typed nodes, connects a chain, edits parameters/layout, and removes incident edges", () => {
    const { editor } = setup();
    editor.add("image.invert");
    editor.add("image.scale");
    const graph = editor.graph!;
    const [first, second] = graph.nodes;
    expect(first.parameters).toEqual({ amount: 1 });
    expect(graph.edges.map((edge) => [edge.sourceNodeId, edge.targetNodeId])).toEqual([
      [graph.id, first.id],
      [first.id, second.id],
      [second.id, graph.id],
    ]);
    editor.parameters(second.id, { amount: 1.5 });
    editor.move(second.id, 410.2, 175.8);
    expect(second.parameters.amount).toBe(1.5);
    expect(second.position).toEqual({ x: 410, y: 176 });
    expect(editor.connections("video", second.id)).toEqual([]);
    editor.remove(first.id);
    expect(graph.edges).toHaveLength(1);
    expect(editor.dirty).toBe(true);
  });

  it("saves canonical revisions and runs the exact saved version with source and export paths", async () => {
    const { studio, editor, request } = setup();
    studio.updateRunForm({ input: "source.png", output: "new-export.png" });
    editor.add("image.invert");
    editor.rename("My workflow");
    await editor.run();
    expect(request).toHaveBeenCalledWith("creative.studio.graph.run", {
      id: editor.graph!.id,
      revision: 1,
      input: "source.png",
      output: "new-export.png",
    });
    expect(editor.graph!.metadata.sourcePath).toBe("source.png");
    expect(studio.lastResult).toEqual({ ok: true, message: "done" });
    expect(studio.running).toBe(false);
    expect(editor.dirty).toBe(false);
  });

  it("blocks execution for validation issues and preserves an edited draft on a save conflict", async () => {
    const { editor, request } = setup();
    editor.add("image.invert");
    request.mockImplementation(async (method, params) =>
      method === "creative.studio.graph.save"
        ? {
            graph: { ...(params.graph as CreativeGraph), revision: 1 },
            validation: { valid: false, issues: [{ message: "Cycle detected" }] },
          }
        : {},
    );
    await editor.run();
    expect(editor.issues).toEqual(["Cycle detected"]);
    expect(request.mock.calls.some(([method]) => method === "creative.studio.graph.run")).toBe(
      false,
    );
    editor.rename("Unsaved rename");
    request.mockResolvedValue({
      ok: false,
      error: "Workflow changed elsewhere; reload before saving",
    });
    expect(await editor.save()).toBe(false);
    expect(editor.graph!.name).toBe("Unsaved rename");
    expect(editor.dirty).toBe(true);
    expect(editor.message).toContain("changed elsewhere");
  });

  it("restores node positions, topology and source without overwriting a dirty graph during refresh", () => {
    const { studio, editor } = setup();
    editor.add("image.invert");
    const graph = structuredClone(editor.graph!);
    graph.metadata.sourcePath = "restored.png";
    const other = setup();
    other.editor.restore([graph], graph.id);
    expect(other.editor.graph).toEqual(graph);
    expect(other.studio.runForm.input).toBe("restored.png");
    other.editor.rename("Draft edits");
    other.editor.restore([graph], graph.id);
    expect(other.editor.graph!.name).toBe("Draft edits");
    expect(studio.runForm.input).toBe("");
  });

  it("does not treat validation warnings as execution-blocking errors", async () => {
    const { editor, request } = setup();
    editor.add("image.invert");
    request.mockImplementation(async (method, params) =>
      method === "creative.studio.graph.save"
        ? {
            graph: { ...(params.graph as CreativeGraph), revision: 1 },
            validation: { valid: true, issues: [{ message: "A draft node is disabled" }] },
          }
        : {
            ok: true,
            nodes: [
              {
                node_id: editor.graph!.nodes[0].id,
                status: "ok",
                duration_ms: 4,
                engine_path: "native-image.dll",
              },
            ],
          },
    );
    await editor.run();
    expect(request.mock.calls.some(([method]) => method === "creative.studio.graph.run")).toBe(
      true,
    );
  });

  it("renders keyboard-editable nodes, typed connections and descriptor parameters", () => {
    const { studio, editor } = setup();
    editor.add("image.invert");
    const container = document.createElement("div");
    render(renderCreativeWorkflow(studio), container);
    const node = container.querySelector<HTMLButtonElement>('[aria-label="Edit image.invert"]')!;
    node.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(editor.graph!.nodes[0].position!.x).toBe(40);
    const amount = container.querySelector<HTMLInputElement>('input[type="number"]')!;
    amount.value = "2.5";
    amount.dispatchEvent(new Event("change"));
    expect(editor.graph!.nodes[0].parameters.amount).toBe(2.5);
    const connection = container.querySelector<HTMLSelectElement>('[aria-label="Node input"]')!;
    connection.value = "";
    connection.dispatchEvent(new Event("change"));
    expect(
      editor.graph!.edges.filter((edge) => edge.targetNodeId === editor.graph!.nodes[0].id),
    ).toEqual([]);
    render(null, container);
  });
});
