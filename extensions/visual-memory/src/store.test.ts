import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { VectorStore } from "./store.js";

describe("VectorStore", () => {
  let store: VectorStore;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "vmem-test-"));
    store = new VectorStore({ dbPath: join(tempDir, "test.sqlite") });
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeEmbedding(dim: number, seed: number): Float32Array {
    const vec = new Float32Array(dim);
    for (let i = 0; i < dim; i++) {
      vec[i] = Math.sin(seed * (i + 1) * 0.1);
    }
    // L2-normalize
    let sumSq = 0;
    for (let i = 0; i < dim; i++) {
      sumSq += vec[i]! * vec[i]!;
    }
    const norm = Math.sqrt(sumSq);
    if (norm > 0) {
      for (let i = 0; i < dim; i++) {
        vec[i] /= norm;
      }
    }
    return vec;
  }

  describe("upsert / getById / getByPath", () => {
    it("inserts and retrieves an asset by id", () => {
      const embedding = makeEmbedding(512, 1);
      const id = store.upsert({
        path: "/test/image.png",
        type: "image",
        timestamp: 1000,
        dim: 512,
        embedding,
        metadata: { brand: "acme" },
      });

      const asset = store.getById(id);
      expect(asset).not.toBeNull();
      expect(asset!.path).toBe("/test/image.png");
      expect(asset!.type).toBe("image");
      expect(asset!.dim).toBe(512);
      expect(asset!.metadata.brand).toBe("acme");
    });

    it("retrieves asset by path", () => {
      store.upsert({
        path: "/test/doc.md",
        type: "text",
        timestamp: 2000,
        dim: 512,
        embedding: makeEmbedding(512, 2),
        metadata: {},
      });

      const asset = store.getByPath("/test/doc.md");
      expect(asset).not.toBeNull();
      expect(asset!.type).toBe("text");
    });

    it("replaces on same path (upsert)", () => {
      store.upsert({
        path: "/test/file.png",
        type: "image",
        timestamp: 1000,
        dim: 512,
        embedding: makeEmbedding(512, 1),
        metadata: { brand: "old" },
      });

      store.upsert({
        path: "/test/file.png",
        type: "image",
        timestamp: 2000,
        dim: 512,
        embedding: makeEmbedding(512, 2),
        metadata: { brand: "new" },
      });

      expect(store.count()).toBe(1);
      const asset = store.getByPath("/test/file.png");
      expect(asset!.metadata.brand).toBe("new");
    });
  });

  describe("delete", () => {
    it("deletes an existing asset", () => {
      const id = store.upsert({
        path: "/test/del.png",
        type: "image",
        timestamp: 1000,
        dim: 512,
        embedding: makeEmbedding(512, 5),
        metadata: {},
      });

      expect(store.delete(id)).toBe(true);
      expect(store.getById(id)).toBeNull();
    });

    it("returns false for non-existent id", () => {
      expect(store.delete("nonexistent")).toBe(false);
    });
  });

  describe("count", () => {
    it("returns correct count", () => {
      expect(store.count()).toBe(0);

      store.upsert({
        path: "/a.png",
        type: "image",
        timestamp: 1000,
        dim: 512,
        embedding: makeEmbedding(512, 1),
        metadata: {},
      });
      store.upsert({
        path: "/b.png",
        type: "image",
        timestamp: 1000,
        dim: 512,
        embedding: makeEmbedding(512, 2),
        metadata: {},
      });

      expect(store.count()).toBe(2);
    });
  });

  describe("search (cosine similarity)", () => {
    it("returns results ranked by similarity", () => {
      const queryEmbed = makeEmbedding(512, 10);

      // Insert assets with varying similarity to query
      store.upsert({
        path: "/similar.png",
        type: "image",
        timestamp: 1000,
        dim: 512,
        embedding: makeEmbedding(512, 10), // identical = score ~1
        metadata: { brand: "close" },
      });
      store.upsert({
        path: "/different.png",
        type: "image",
        timestamp: 1000,
        dim: 512,
        embedding: makeEmbedding(512, 99), // different seed = lower score
        metadata: { brand: "far" },
      });

      const results = store.search(queryEmbed, { topK: 10, minScore: 0 });
      expect(results.length).toBe(2);
      expect(results[0]!.path).toBe("/similar.png");
      expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
      // Identical embedding should have score ~1
      expect(results[0]!.score).toBeCloseTo(1, 2);
    });

    it("filters by minScore", () => {
      const queryEmbed = makeEmbedding(512, 1);

      store.upsert({
        path: "/high.png",
        type: "image",
        timestamp: 1000,
        dim: 512,
        embedding: makeEmbedding(512, 1), // identical
        metadata: {},
      });
      store.upsert({
        path: "/low.png",
        type: "image",
        timestamp: 1000,
        dim: 512,
        embedding: makeEmbedding(512, 999), // very different
        metadata: {},
      });

      const results = store.search(queryEmbed, { topK: 10, minScore: 0.9 });
      expect(results.length).toBe(1);
      expect(results[0]!.path).toBe("/high.png");
    });

    it("filters by type", () => {
      const queryEmbed = makeEmbedding(512, 1);

      store.upsert({
        path: "/image.png",
        type: "image",
        timestamp: 1000,
        dim: 512,
        embedding: makeEmbedding(512, 1),
        metadata: {},
      });
      store.upsert({
        path: "/code.ts",
        type: "code",
        timestamp: 1000,
        dim: 512,
        embedding: makeEmbedding(512, 1),
        metadata: {},
      });

      const results = store.search(queryEmbed, { topK: 10, minScore: 0, typeFilter: "code" });
      expect(results.length).toBe(1);
      expect(results[0]!.path).toBe("/code.ts");
    });

    it("respects topK limit", () => {
      const queryEmbed = makeEmbedding(512, 1);

      for (let i = 0; i < 5; i++) {
        store.upsert({
          path: `/file${i}.png`,
          type: "image",
          timestamp: 1000,
          dim: 512,
          embedding: makeEmbedding(512, i + 1),
          metadata: {},
        });
      }

      const results = store.search(queryEmbed, { topK: 2, minScore: 0 });
      expect(results.length).toBe(2);
    });

    it("skips dimension-mismatched rows", () => {
      const queryEmbed = makeEmbedding(512, 1);

      store.upsert({
        path: "/match.png",
        type: "image",
        timestamp: 1000,
        dim: 512,
        embedding: makeEmbedding(512, 1),
        metadata: {},
      });
      store.upsert({
        path: "/mismatch.png",
        type: "image",
        timestamp: 1000,
        dim: 256,
        embedding: makeEmbedding(256, 1),
        metadata: {},
      });

      const results = store.search(queryEmbed, { topK: 10, minScore: 0 });
      expect(results.length).toBe(1);
      expect(results[0]!.path).toBe("/match.png");
    });
  });
});
