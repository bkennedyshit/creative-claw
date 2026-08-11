import Database from "better-sqlite3";
import { ulid } from "ulid";
import type { Asset, AssetMetadata, SearchResult } from "./types.js";

export interface StoreOptions {
  dbPath: string;
}

export interface SearchOptions {
  topK?: number;
  minScore?: number;
  typeFilter?: Asset["type"];
}

/**
 * SQLite-backed vector store for media assets.
 * Stores embeddings as raw Float32Array BLOBs.
 * Cosine similarity = dot product of L2-normalized vectors.
 */
export class VectorStore {
  private db: Database.Database;

  constructor(opts: StoreOptions) {
    this.db = new Database(opts.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        dim INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_assets_path ON assets(path);
      CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(type);
    `);
  }

  /** Insert or replace an asset. Returns the generated/provided id. */
  upsert(asset: Omit<Asset, "id"> & { id?: string }): string {
    const id = asset.id || ulid();
    const embeddingBuf = Buffer.from(asset.embedding.buffer, asset.embedding.byteOffset, asset.embedding.byteLength);
    const metadataJson = JSON.stringify(asset.metadata || {});

    this.db.prepare(`
      INSERT OR REPLACE INTO assets (id, path, type, timestamp, dim, embedding, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, asset.path, asset.type, asset.timestamp, asset.dim, embeddingBuf, metadataJson);

    return id;
  }

  /** Get an asset by id. */
  getById(id: string): Asset | null {
    const row = this.db.prepare("SELECT * FROM assets WHERE id = ?").get(id) as RawRow | undefined;
    if (!row) return null;
    return rowToAsset(row);
  }

  /** Get an asset by path. */
  getByPath(path: string): Asset | null {
    const row = this.db.prepare("SELECT * FROM assets WHERE path = ?").get(path) as RawRow | undefined;
    if (!row) return null;
    return rowToAsset(row);
  }

  /** Delete an asset by id. Returns true if deleted. */
  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM assets WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /** Count total assets. */
  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM assets").get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Search by cosine similarity (dot product of L2-normalized vectors).
   * Skips rows with mismatched dimensions.
   */
  search(queryEmbedding: Float32Array, opts: SearchOptions = {}): SearchResult[] {
    const { topK = 10, minScore = 0, typeFilter } = opts;
    const queryDim = queryEmbedding.length;

    let sql = "SELECT * FROM assets WHERE dim = ?";
    const params: unknown[] = [queryDim];

    if (typeFilter) {
      sql += " AND type = ?";
      params.push(typeFilter);
    }

    const rows = this.db.prepare(sql).all(...params) as RawRow[];

    // Compute cosine similarity (dot product for L2-normalized vectors)
    const scored: SearchResult[] = [];
    for (const row of rows) {
      const embedding = bufferToFloat32(row.embedding, row.dim);
      if (embedding.length !== queryDim) continue; // skip dim-mismatched

      const score = dotProduct(queryEmbedding, embedding);
      if (score >= minScore) {
        scored.push({
          id: row.id,
          path: row.path,
          type: row.type as Asset["type"],
          score,
          metadata: JSON.parse(row.metadata) as AssetMetadata,
        });
      }
    }

    // Sort descending by score, return topK
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}

// Internal helpers

interface RawRow {
  id: string;
  path: string;
  type: string;
  timestamp: number;
  dim: number;
  embedding: Buffer;
  metadata: string;
}

function rowToAsset(row: RawRow): Asset {
  return {
    id: row.id,
    path: row.path,
    type: row.type as Asset["type"],
    timestamp: row.timestamp,
    dim: row.dim,
    embedding: bufferToFloat32(row.embedding, row.dim),
    metadata: JSON.parse(row.metadata) as AssetMetadata,
  };
}

function bufferToFloat32(buf: Buffer, dim: number): Float32Array {
  const expected = dim * 4;
  if (buf.length !== expected) {
    return new Float32Array(0);
  }
  return new Float32Array(buf.buffer, buf.byteOffset, dim);
}

function dotProduct(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i]! * b[i]!;
  }
  return sum;
}
