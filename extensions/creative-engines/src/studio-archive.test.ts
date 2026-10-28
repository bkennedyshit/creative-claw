import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreativeGraph, CreativeProject } from "@openclaw/creative-contracts";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { expect, it } from "vitest";
import { buildStudioRecipe } from "./studio-recipes.js";
import { CreativeStudio } from "./studio.js";

it("archives recoverably across restart and rejects stale updates or edits to archived copies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-archive-"));
  const env = { ...process.env, OPENCLAW_STATE_DIR: directory };
  const open = () =>
    new CreativeStudio(
      directory,
      createPluginStateKeyedStoreForTests("creative-engines", {
        namespace: "sources",
        maxEntries: 100,
        env,
      }),
      createPluginStateKeyedStoreForTests("creative-engines", {
        namespace: "runs",
        maxEntries: 100,
        env,
      }),
      {},
      undefined,
      createPluginStateKeyedStoreForTests<CreativeProject>("creative-engines", {
        namespace: "projects",
        maxEntries: 100,
        env,
      }),
      createPluginStateKeyedStoreForTests<CreativeGraph>("creative-engines", {
        namespace: "graphs",
        maxEntries: 100,
        env,
      }),
    );
  try {
    const studio = open();
    const first = (await studio.saveGraph(buildStudioRecipe("image-mono"))).graph;
    const second = (await studio.saveGraph(buildStudioRecipe("image-invert"))).graph;
    const archived = (await studio.archiveGraph(first.id, first.revision, true)).graph;
    const snapshot = await open().snapshot();
    expect(snapshot.graphs.map((graph) => graph.id)).toEqual([second.id]);
    expect(snapshot.archivedGraphs[0].id).toBe(first.id);
    await expect(open().getGraph(first.id)).rejects.toThrow("not found");
    await expect(open().archiveGraph(first.id, first.revision, false)).rejects.toThrow(
      "changed elsewhere",
    );
    await expect(open().saveGraph(archived)).rejects.toThrow("Restore");
    const restored = (await open().archiveGraph(first.id, archived.revision, false)).graph;
    expect(restored.metadata.archivedAt).toBeUndefined();
    expect((await open().getGraph(first.id)).nodes).toEqual(first.nodes);
    expect((await open().snapshot()).archivedGraphs).toEqual([]);
  } finally {
    resetPluginStateStoreForTests();
    await rm(directory, { recursive: true, force: true });
  }
});
