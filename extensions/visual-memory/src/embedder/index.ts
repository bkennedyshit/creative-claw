import type { EmbedderConfig, EmbedderReport } from "../types.js";
import { HashEmbedder } from "./hash.js";

/** Embedder contract: produce fixed-dimension vectors for text or image input. */
export interface Embedder {
  readonly dim: number;
  /**
   * True only when the vectors carry real semantic meaning (a trained model).
   * The hash backend is deterministic but NOT semantic, so it reports false.
   * Nothing in this plugin may declare `true` unless it actually runs a model.
   */
  readonly semantic: boolean;
  embedText(text: string): Promise<Float32Array>;
  embedImage(filePath: string): Promise<Float32Array>;
}

/**
 * Backends this plugin can actually run today.
 *
 * Only `hash` ships. A CLIP/ONNX backend was previously advertised while every
 * encoder call threw and was silently swallowed into the hash fallback, so the
 * option was removed rather than left as a stub. Anything else a user still has
 * in config is reported as an explicit degradation (see `resolveEmbedder`).
 */
export const SUPPORTED_EMBEDDER_BACKENDS = ["hash"] as const;
export type SupportedEmbedderBackend = (typeof SUPPORTED_EMBEDDER_BACKENDS)[number];

export interface EmbedderResolution {
  embedder: Embedder;
  /** Honest, user-visible account of which backend is really in use. */
  report: EmbedderReport;
}

function isSupportedBackend(backend: string): backend is SupportedEmbedderBackend {
  return (SUPPORTED_EMBEDDER_BACKENDS as readonly string[]).includes(backend);
}

/**
 * Resolve the configured embedder backend.
 *
 * An unsupported backend never fails silently: the hash embedder is used and
 * the returned `report` records the requested backend, `degraded: true`, and
 * the reason. Callers surface that in `media_search` / `media_index` output and
 * log it once at startup.
 */
export function resolveEmbedder(config: EmbedderConfig): EmbedderResolution {
  const requested = (config.backend ?? "hash").trim() || "hash";
  const dim = config.dim || 512;

  if (isSupportedBackend(requested)) {
    return {
      embedder: new HashEmbedder(dim),
      report: { used: requested, requested, degraded: false, semantic: false },
    };
  }

  return {
    embedder: new HashEmbedder(dim),
    report: {
      used: "hash",
      requested,
      degraded: true,
      semantic: false,
      reason:
        `embedder "${requested}" is not implemented in this build — no model inference is available. ` +
        `Supported backends: ${SUPPORTED_EMBEDDER_BACKENDS.join(", ")}. ` +
        `Falling back to the deterministic hash embedder: results are lexical/byte similarity, NOT semantic.`,
    },
  };
}

export { HashEmbedder } from "./hash.js";
