import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import { GpuBroker } from "./broker.js";

// GPU/Ollama-gated real-VRAM evacuation proof (Task 9.2 / Property 1).
//
// This test is intentionally NOT mocked: it exercises the real nvidia-smi and
// Ollama paths. When a GPU or Ollama is unavailable it SKIPS WITH A REASON via
// the Vitest test context — it never fabricates a pass. It only asserts a real
// measured VRAM drop where the hardware actually exists.

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const OLLAMA_WARM_MODEL = process.env.OLLAMA_WARM_MODEL ?? "llama3:8b";

function nvidiaSmiAvailable(): boolean {
  const result = spawnSync("nvidia-smi", [
    "--query-gpu=memory.used,memory.total",
    "--format=csv,noheader,nounits",
  ]);
  return result.status === 0 && !result.error;
}

async function ollamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/ps`);
    return res.ok;
  } catch {
    return false;
  }
}

async function warmModel(model: string): Promise<boolean> {
  try {
    // A zero-length generate with a positive keep_alive loads the model into VRAM.
    const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: "", keep_alive: "5m" }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

describe("real-VRAM evacuation (GPU + Ollama gated)", () => {
  it("evicts a warmed Ollama model and measured VRAM drops", async (ctx) => {
    if (!nvidiaSmiAvailable()) {
      ctx.skip();
      return;
    }
    if (!(await ollamaAvailable())) {
      // Skip-with-reason: honest degradation, never a fake pass.
      console.warn(
        `[skip] Ollama not reachable at ${OLLAMA_BASE_URL}; real-VRAM evacuation proof requires a live GPU + Ollama.`,
      );
      ctx.skip();
      return;
    }

    const broker = new GpuBroker({ ollamaBaseUrl: OLLAMA_BASE_URL });
    try {
      const warmed = await warmModel(OLLAMA_WARM_MODEL);
      if (!warmed) {
        console.warn(
          `[skip] Could not warm model "${OLLAMA_WARM_MODEL}" (pull it or set OLLAMA_WARM_MODEL); skipping.`,
        );
        ctx.skip();
        return;
      }

      // Give Ollama a moment to report the resident model.
      await new Promise((r) => {
        setTimeout(r, 1500);
      });
      const before = broker.readGpuSnapshot();
      const footprintBefore = await broker.getOllamaFootprintMb();
      expect(before).not.toBeNull();
      expect(footprintBefore).toBeGreaterThan(0);

      // Evacuate: release for the user, which evicts all resident models.
      await broker.release("test-user", "real-vram evacuation proof");

      // Allow the eviction (keep_alive:0) to take effect.
      await new Promise((r) => {
        setTimeout(r, 2500);
      });
      const after = broker.readGpuSnapshot();
      const footprintAfter = await broker.getOllamaFootprintMb();
      expect(after).not.toBeNull();

      // The Ollama footprint must genuinely drop; VRAM used should not rise.
      expect(footprintAfter).toBeLessThan(footprintBefore);
      expect(after!.usedMb).toBeLessThanOrEqual(before!.usedMb);
    } finally {
      broker.stop();
    }
  });
});
