import type { AssetMetadata, EmbedderReport, IndexStats, SearchResult } from "./types.js";

/** Result returned by media_index tool. */
export interface IndexResult {
  success: boolean;
  stats: IndexStats;
  message: string;
  /** Which embedding backend really ran, and whether it was degraded. */
  embedder: EmbedderReport;
}

/** Result returned by media_search / media_search_by_image tools. */
export interface MediaSearchResult {
  results: SearchResult[];
  query: string;
  backend: string;
  elapsed: number;
  /** Which embedding backend really ran, and whether it was degraded. */
  embedder: EmbedderReport;
}

/** Result returned by media_describe tool. */
export interface DescribeResult {
  found: boolean;
  id: string;
  path?: string;
  type?: string;
  timestamp?: number;
  metadata?: AssetMetadata;
  message?: string;
}
