import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import sharp from "sharp";
import { expect, it } from "vitest";
import { buildStudioRecipe } from "./studio-recipes.js";
import { CreativeStudio } from "./studio.js";

it("does not publish or export a result cancelled during a non-interruptible operation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-cancellation-"));
  try {
    const env = { ...process.env, OPENCLAW_STATE_DIR: directory };
    const controller = new AbortController();
    const studio = new CreativeStudio(
      join(directory, "project"),
      createPluginStateKeyedStoreForTests("creative-engines", {
        namespace: "sources",
        maxEntries: 10,
        env,
      }),
      createPluginStateKeyedStoreForTests("creative-engines", {
        namespace: "runs",
        maxEntries: 10,
        env,
      }),
      {
        image: {
          ensureStarted: async () => {},
          isAvailable: () => true,
          reason: () => undefined,
          apply: async (input, _operation, output) => {
            await copyFile(input, output);
            controller.abort(new Error("Operator cancelled"));
            return { ok: true, output_path: output, engine_path: "test", duration_ms: 0 };
          },
        },
      },
    );
    const input = join(directory, "source.png");
    const output = join(directory, "export.png");
    await sharp({ create: { width: 2, height: 2, channels: 4, background: "red" } })
      .png()
      .toFile(input);
    const original = await readFile(input);
    await expect(
      studio.runGraph(buildStudioRecipe("image-mono"), input, output, {
        signal: controller.signal,
      }),
    ).rejects.toThrow("Operator cancelled");
    expect((await studio.snapshot()).runs).toEqual([]);
    expect(existsSync(output)).toBe(false);
    expect(await readFile(input)).toEqual(original);
  } finally {
    resetPluginStateStoreForTests();
    await rm(directory, { recursive: true, force: true });
  }
});
