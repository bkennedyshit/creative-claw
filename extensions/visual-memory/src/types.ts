/** Core type definitions for Visual Memory plugin. */

export interface Asset {
  id: string;
  path: string;
  type: "image" | "video" | "text" | "code";
  timestamp: number;
  dim: number;
  embedding: Float32Array;
  metadata: AssetMetadata;
}

export interface AssetMetadata {
  brand?: string;
  intent?: string;
  warnOnEdit?: boolean;
  width?: number;
  height?: number;
  size?: number;
  mimeType?: string;
  duration?: number;
  [key: string]: unknown;
}

export interface SearchResult {
  id: string;
  path: string;
  type: Asset["type"];
  score: number;
  metadata: AssetMetadata;
}

export interface IndexStats {
  total: number;
  indexed: number;
  skipped: number;
  failed: number;
  elapsed: number;
  backend: string;
}

export interface PathMetadata {
  brand: string | undefined;
  intent: string | undefined;
  warnOnEdit: boolean;
}

export interface EmbedderConfig {
  /**
   * Backend requested via plugin config. Only the values in
   * `SUPPORTED_EMBEDDER_BACKENDS` are runnable; anything else resolves to the
   * hash embedder and is reported as a degradation instead of failing silently.
   */
  backend: string;
  dim: number;
}

/**
 * Honest, user- and model-visible account of the embedding backend actually in
 * use for a request. Returned by `media_search`, `media_search_by_image`, and
 * `media_index` so a degraded run can never look like a semantic one.
 */
export interface EmbedderReport {
  /** Backend that actually produced the vectors. */
  used: string;
  /** Backend the config asked for. */
  requested: string;
  /** True when `used` differs from `requested`. */
  degraded: boolean;
  /** True only when `used` runs a real model. The hash backend is never semantic. */
  semantic: boolean;
  /** Present when `degraded` is true: what is missing and what the fallback means. */
  reason?: string;
}
