import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the filesystem so tests never touch disk. createHash (node:crypto) stays
// real, so distinct buffers produce distinct hashes and identical buffers collide.
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  copyFile: vi.fn(async () => {}),
}));

import { readFile } from "node:fs/promises";
import type { ImageEngineRuntime } from "../runtime/image.js";
import type { ApplyResult, Step } from "../types.js";
import { registerEditSessionTools } from "./edit-session.js";

const readFileMock = readFile as unknown as ReturnType<typeof vi.fn>;

type ToolResult = { content: Array<{ type: string; text: string }>; details: unknown };
type Tool = { name: string; execute: (toolCallId: string, params: unknown) => Promise<ToolResult> };

function makeImageEngine(available = true): ImageEngineRuntime {
  return {
    engineName: "image",
    isAvailable: () => available,
    reason: () => (available ? undefined : "libomni_image_bridge not found"),
    applyChain: async (_input: string, _steps: Step[], output: string): Promise<ApplyResult> => ({
      ok: true,
      output_path: output,
      engine_path: "/fake/image.dll",
      duration_ms: 1,
    }),
  } as unknown as ImageEngineRuntime;
}

function tools(engine: ImageEngineRuntime): Map<string, Tool> {
  const map = new Map<string, Tool>();
  registerEditSessionTools((t) => map.set(t.name, t as unknown as Tool), engine);
  return map;
}

describe("image edit session — stacking + revert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Distinct content per path class → distinct sha256 hashes (real change).
    readFileMock.mockImplementation(async (p: unknown) => {
      const s = String(p);
      if (s.includes("_v1")) return Buffer.from("edited-committed");
      if (s.includes("_preview")) return Buffer.from("edited-preview");
      return Buffer.from("original");
    });
  });

  it("commits a preview as a new working version, then reverts to the original", async () => {
    const t = tools(makeImageEngine());

    const planned = (await t.get("image.edit_session.plan")!.execute("call-1", {
      input: "/img.png",
      instruction: "blur the photo",
    })).details as { session_id: string; planned_steps: Step[] };
    expect(planned.planned_steps).toContainEqual({ op: "gaussian_blur", params: { radius: 3 } });

    const confirmed = (await t.get("image.edit_session.confirm")!.execute("call-1", {
      session_id: planned.session_id,
      preview_path: "/img_preview.png",
      steps: planned.planned_steps,
    })).details as { ok: boolean; version: number; committed_path: string };
    // Result becomes the working image at v1 (stacking).
    expect(confirmed.ok).toBe(true);
    expect(confirmed.version).toBe(1);
    expect(confirmed.committed_path).toContain("_v1");

    const reverted = (await t.get("image.edit_session.revert")!.execute("call-1", {
      session_id: planned.session_id,
    })).details as { ok: boolean; version: number; reverted_to: string; discarded_versions: number };
    expect(reverted).toMatchObject({ ok: true, version: 0, reverted_to: "/img.png", discarded_versions: 1 });
  });
});

describe("image edit session — Anti_Fake_Guard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports no_change_detected instead of faking a no-op edit", async () => {
    // Every path returns identical content → identical hashes → no real change.
    readFileMock.mockImplementation(async () => Buffer.from("unchanged"));
    const t = tools(makeImageEngine());

    const planned = (await t.get("image.edit_session.plan")!.execute("call-1", {
      input: "/img.png",
      instruction: "sharpen",
    })).details as { session_id: string; planned_steps: Step[] };

    const preview = (await t.get("image.edit_session.preview")!.execute("call-1", {
      session_id: planned.session_id,
      steps: planned.planned_steps,
    })).details as { ok: boolean; reason?: string };

    expect(preview.ok).toBe(false);
    expect(preview.reason).toBe("no_change_detected");
  });

  it("skips-with-reason when the native image engine is unavailable", async () => {
    readFileMock.mockImplementation(async () => Buffer.from("x"));
    const t = tools(makeImageEngine(false));

    const planned = (await t.get("image.edit_session.plan")!.execute("call-1", {
      input: "/img.png",
      instruction: "blur",
    })).details as { session_id: string; planned_steps: Step[] };

    const preview = (await t.get("image.edit_session.preview")!.execute("call-1", {
      session_id: planned.session_id,
      steps: planned.planned_steps,
    })).details as { ok: boolean; reason?: string };

    expect(preview.ok).toBe(false);
    expect(preview.reason).toMatch(/not found|unavailable/i);
  });
});
