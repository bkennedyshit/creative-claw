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
      if (method === "creative.studio.job.start") {
        return {
          job: {
            id: "job-1",
            graphId: params.id,
            name: "Test",
            status: "succeeded",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            result: { ok: true, message: "done" },
          },
        };
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
  it("preserves path edits through save, studio changes, and explicit discard", async () => {
    const { studio, editor } = setup();
    editor.add("image.invert");
    editor.editPaths({ input: "first.png", output: "first-export.png" });
    await editor.save();
    editor.editPaths({ input: "second.png", output: "second-export.png" });
    studio.setActiveMedia("video");
    expect(studio.activeMedia).toBe("image");
    expect(studio.runForm.input).toBe("second.png");
    editor.discard();
    expect(studio.runForm).toMatchObject({ input: "first.png", output: "first-export.png" });
    editor.editPaths({ input: "third.png", output: "third-export.png" });
    await editor.save();
    studio.setActiveMedia("video");
    studio.setActiveMedia("image");
    expect(studio.runForm).toMatchObject({ input: "third.png", output: "third-export.png" });
  });
  it("switches graph, source, saved list and palette together with the media tab", async () => {
    const { studio, editor } = setup();
    editor.add("image.invert");
    studio.updateRunForm({ input: "photo.png" });
    await editor.save();
    const imageId = editor.graph!.id;
    studio.setActiveMedia("video");
    expect(editor.graph!.inputs[0].dataType).toBe("video");
    expect(studio.runForm.input).toBe("");
    expect(editor.mediaSaved).toHaveLength(0);
    expect(editor.paletteCapabilities.map((cap) => cap.id)).toEqual(["video.blur"]);
    studio.setActiveMedia("image");
    expect(editor.graph!.id).toBe(imageId);
    expect(studio.runForm.input).toBe("photo.png");
  });

  it("preserves unsaved work when switching is blocked and offers explicit discard", async () => {
    const { studio, editor } = setup();
    editor.add("image.invert");
    await editor.save();
    editor.rename("Draft edit");
    studio.setActiveMedia("audio");
    expect(studio.activeMedia).toBe("image");
    expect(editor.graph!.name).toBe("Draft edit");
    expect(editor.message).toContain("Save or discard");
    editor.discard();
    expect(editor.graph!.name).toBe("Untitled workflow");
    studio.setActiveMedia("audio");
    expect(editor.graph!.inputs[0].dataType).toBe("audio");
  });

  it("archives and restores saved copies while protecting dirty drafts", async () => {
    const { studio, editor, request } = setup();
    editor.add("image.invert");
    await editor.save();
    const saved = structuredClone(editor.graph!);
    request.mockImplementation(async (method, params) =>
      method === "creative.studio.graph.archive"
        ? {
            graph: {
              ...saved,
              revision: saved.revision + 1,
              metadata: params.archived ? { archivedAt: "2026-10-28" } : {},
            },
          }
        : {},
    );
    await editor.setArchived(saved, true);
    expect(editor.saved).toHaveLength(0);
    expect(editor.archived).toHaveLength(1);
    expect(editor.message).toContain("source files and outputs are kept");
    await editor.setArchived(editor.archived[0], false);
    expect(editor.archived).toHaveLength(0);
    expect(editor.graph!.id).toBe(saved.id);
    editor.rename("Don't discard me");
    request.mockClear();
    await editor.setArchived(editor.graph!, true);
    expect(request).not.toHaveBeenCalled();
    expect(studio.workflow.graph!.name).toBe("Don't discard me");
  });
  it("filters workflow starters and identifies unavailable native dependencies", () => {
    const { editor, studio } = setup();
    studio.activeMedia = "video";
    editor.recipes = [
      {
        id: "cut",
        name: "Clean cut",
        category: "Editing",
        description: "Trim footage",
        sourceType: "video",
        operations: ["video.cut_clip"],
      },
      {
        id: "warm",
        name: "Warm film",
        category: "Looks",
        description: "Color grading",
        sourceType: "video",
        operations: ["vfx.video_color_grade"],
      },
    ];
    editor.filterRecipes("warm");
    expect(editor.filteredRecipes.map((recipe) => recipe.id)).toEqual(["warm"]);
    expect(editor.recipeUnavailable(editor.recipes[1])).toContain("vfx");
    editor.filterRecipes("", "Editing");
    expect(editor.filteredRecipes.map((recipe) => recipe.id)).toEqual(["cut"]);
    expect(editor.recipeUnavailable(editor.recipes[0])).toBe("");
  });

  it("loads a recipe as an independent saved workflow and clears the old export target", async () => {
    const { editor, studio, request } = setup();
    const fixture = setup();
    fixture.editor.add("image.invert");
    const graph = {
      ...fixture.editor.graph!,
      name: "Starter",
      revision: 1,
      metadata: { sourcePath: "chosen.png" },
    };
    studio.updateRunForm({ input: "chosen.png", output: "previous-export.png" });
    request.mockResolvedValue({ graph });
    await editor.useRecipe("image-invert");
    expect(request).toHaveBeenCalledWith("creative.studio.recipe.create", {
      id: "image-invert",
      input: "chosen.png",
    });
    expect(editor.graph!.name).toBe("Starter");
    expect(editor.dirty).toBe(false);
    expect(studio.runForm.output).toBe("");
  });

  it("protects unsaved work on recipe/import switches and duplicates current draft edits", async () => {
    const { editor, request } = setup();
    editor.add("image.invert");
    editor.parameters(editor.graph!.nodes[0].id, { amount: 2.5 });
    await editor.useRecipe("another");
    await editor.importGraph("{}");
    expect(request).not.toHaveBeenCalled();
    const graph = structuredClone(editor.graph!);
    request.mockResolvedValue({ graph: { ...graph, id: "new-copy", name: "Copy", revision: 1 } });
    await editor.duplicate();
    expect(request).toHaveBeenCalledWith("creative.studio.graph.copy", {
      graph: { ...graph, metadata: { ...graph.metadata, sourcePath: "" } },
    });
    expect(editor.graph!.nodes[0].parameters.amount).toBe(2.5);
    expect(editor.graph!.id).toBe("new-copy");
  });

  it("rejects malformed/oversized imports and sends valid JSON to authoritative graph validation", async () => {
    const { editor, request } = setup();
    await editor.importGraph("not JSON");
    expect(editor.message).toContain("SyntaxError");
    await editor.importGraph(" ".repeat(65537));
    expect(editor.message).toContain("64 KB");
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValue({ error: "Expected a canonical workflow JSON document" });
    await editor.importGraph('{"nodes":[]}');
    expect(request).toHaveBeenCalledWith("creative.studio.graph.copy", { graph: { nodes: [] } });
    expect(editor.message).toContain("canonical workflow");
  });

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
    expect(request).toHaveBeenCalledWith("creative.studio.job.start", {
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
    expect(request.mock.calls.some(([method]) => method === "creative.studio.job.start")).toBe(
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
    const { editor, request, studio } = setup();
    editor.add("image.invert");
    request.mockImplementation(async (method, params) =>
      method === "creative.studio.graph.save"
        ? {
            graph: { ...(params.graph as CreativeGraph), revision: 1 },
            validation: { valid: true, issues: [{ message: "A draft node is disabled" }] },
          }
        : {
            job: {
              id: "warning-job",
              graphId: editor.graph!.id,
              name: "Warning job",
              status: "succeeded",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              result: {
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
            },
          },
    );
    await editor.run();
    expect(request.mock.calls.some(([method]) => method === "creative.studio.job.start")).toBe(
      true,
    );
    expect(studio.lastResult?.ok).toBe(true);
  });

  it("restores the latest inline operation instead of selecting an unrelated saved workflow", async () => {
    const first = setup();
    first.editor.add("image.invert");
    const { studio, request } = setup();
    request.mockImplementation(async (method) =>
      method === "creative.studio.snapshot"
        ? {
            project: { activeGraphId: "inline-operation" },
            graphs: [first.editor.graph],
            runs: [
              {
                input: "latest.mp4",
                graph: {
                  nodes: [{ capability: "video.cut_clip", parameters: { start_sec: 1.5 } }],
                },
              },
            ],
          }
        : { available: true, ops: [] },
    );
    await studio.refresh();
    expect(studio.workflow.graph).toBeUndefined();
    expect(studio.runForm).toMatchObject({
      input: "latest.mp4",
      op: "cut_clip",
      params: { start_sec: 1.5 },
    });
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
