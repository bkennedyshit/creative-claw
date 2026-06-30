// GPU snapshot acquisition via nvidia-smi or Ollama /api/ps fallback.
import { exec } from "node:child_process";
import type { GpuSnapshot } from "./types.js";

/**
 * Attempt to parse nvidia-smi XML output for memory usage.
 * Returns a GpuSnapshot or null on failure.
 */
function parseNvidiaSmiOutput(stdout: string): GpuSnapshot | null {
  // nvidia-smi --query-gpu=memory.total,memory.used,memory.free --format=csv,noheader,nounits
  // returns lines like: "24576, 1234, 23342"
  const lines = stdout.trim().split("\n");
  const firstLine = lines[0];
  if (!firstLine) return null;

  const parts = firstLine.split(",").map((s) => s.trim());
  if (parts.length < 3) return null;

  const totalMb = Number(parts[0]);
  const usedMb = Number(parts[1]);
  const freeMb = Number(parts[2]);

  if (Number.isNaN(totalMb) || Number.isNaN(usedMb) || Number.isNaN(freeMb)) return null;
  if (totalMb <= 0) return null;

  return { totalMb, usedMb, freeMb, timestamp: Date.now() };
}

/**
 * Run nvidia-smi and return a GpuSnapshot or null if unavailable.
 */
function snapshotViaNvidiaSmi(): Promise<GpuSnapshot | null> {
  return new Promise((resolve) => {
    exec(
      "nvidia-smi --query-gpu=memory.total,memory.used,memory.free --format=csv,noheader,nounits",
      { timeout: 5000 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(parseNvidiaSmiOutput(stdout));
      },
    );
  });
}

/** Shape of a model entry from Ollama /api/ps response. */
interface OllamaPsModel {
  size_vram?: number;
  size?: number;
}

/**
 * Estimate GPU usage from the Ollama /api/ps endpoint.
 * Uses per-model size_vram when available, falling back to size as a heuristic.
 */
async function snapshotViaOllama(ollamaUrl: string): Promise<GpuSnapshot | null> {
  try {
    const response = await fetch(`${ollamaUrl}/api/ps`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;

    const data = (await response.json()) as { models?: OllamaPsModel[] };
    const models = data.models;
    if (!Array.isArray(models)) return null;

    let usedBytes = 0;
    for (const model of models) {
      if (typeof model.size_vram === "number" && model.size_vram > 0) {
        usedBytes += model.size_vram;
      } else if (typeof model.size === "number" && model.size > 0) {
        usedBytes += model.size;
      }
    }

    const usedMb = Math.round(usedBytes / (1024 * 1024));
    // Ollama does not report total VRAM, so we cannot compute free.
    // Return a partial snapshot with freeMb as 0 (caller uses usedMb for threshold).
    return { totalMb: 0, usedMb, freeMb: 0, timestamp: Date.now() };
  } catch {
    return null;
  }
}

/**
 * Capture a GPU VRAM snapshot. Tries nvidia-smi first, then falls back to
 * Ollama /api/ps. Returns null if neither source is available (honest degradation).
 */
export async function snapshotGpu(ollamaUrl: string): Promise<GpuSnapshot | null> {
  const nvResult = await snapshotViaNvidiaSmi();
  if (nvResult) return nvResult;
  return snapshotViaOllama(ollamaUrl);
}
