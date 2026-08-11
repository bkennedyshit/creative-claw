import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { VectorStore } from "./store.js";
import { resolveEmbedder } from "./embedder/index.js";
import type { ToolContext } from "./tools.js";
import { registerMediaSurface, MEDIA_CONTROL_UI_ID, type MediaSurfaceApi } from "./surface.js";

describe("registerMediaSurface", () => {
  let ctx: ToolContext;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "vmem-surface-"));
    const store = new VectorStore({ dbPath: join(tempDir, "test.sqlite") });
    const { embedder, report } = resolveEmbedder({ backend: "hash", dim: 512 });
    ctx = { store, embedder, embedderReport: report };
  });

  afterEach(() => {
    ctx.store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("registers cli + control-ui when both are supported", () => {
    let capturedRegistrar: ((c: { program: Command }) => void) | undefined;
    const registerCli = vi.fn((registrar: (c: { program: Command }) => void) => {
      capturedRegistrar = registrar;
    });
    const registerControlUiDescriptor = vi.fn();
    const api: MediaSurfaceApi = { registerCli, registerControlUiDescriptor };

    const result = registerMediaSurface(api, ctx);

    expect(result).toEqual({ cli: true, controlUi: true });
    expect(registerCli).toHaveBeenCalledTimes(1);
    expect(registerControlUiDescriptor).toHaveBeenCalledWith(
      expect.objectContaining({
        id: MEDIA_CONTROL_UI_ID,
        surface: "settings",
        label: "Visual Memory",
      }),
    );

    // Running the captured registrar must build the `media` command tree.
    const program = new Command();
    expect(capturedRegistrar).toBeTypeOf("function");
    capturedRegistrar!({ program });

    const media = program.commands.find((c) => c.name() === "media");
    expect(media).toBeDefined();
    const subNames = media!.commands.map((c) => c.name()).sort();
    expect(subNames).toEqual(["describe", "index", "search"]);
  });

  it("no-ops honestly when the api exposes neither method", () => {
    const api: MediaSurfaceApi = {};
    const result = registerMediaSurface(api, ctx);
    expect(result).toEqual({ cli: false, controlUi: false });
  });

  it("registers only what the host supports (cli only)", () => {
    const registerCli = vi.fn();
    const api: MediaSurfaceApi = { registerCli };

    const result = registerMediaSurface(api, ctx);

    expect(result).toEqual({ cli: true, controlUi: false });
    expect(registerCli).toHaveBeenCalledTimes(1);
  });

  it("registers only what the host supports (control-ui only)", () => {
    const registerControlUiDescriptor = vi.fn();
    const api: MediaSurfaceApi = { registerControlUiDescriptor };

    const result = registerMediaSurface(api, ctx);

    expect(result).toEqual({ cli: false, controlUi: true });
    expect(registerControlUiDescriptor).toHaveBeenCalledTimes(1);
  });
});
