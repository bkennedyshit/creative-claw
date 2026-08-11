import { describe, it, expect } from "vitest";
import { resolveEmbedder, SUPPORTED_EMBEDDER_BACKENDS, HashEmbedder } from "./index.js";

describe("resolveEmbedder", () => {
  it("only advertises backends that actually run", () => {
    expect([...SUPPORTED_EMBEDDER_BACKENDS]).toEqual(["hash"]);
  });

  it("resolves hash without degradation and never claims semantics", () => {
    const { embedder, report } = resolveEmbedder({ backend: "hash", dim: 512 });

    expect(embedder).toBeInstanceOf(HashEmbedder);
    expect(embedder.semantic).toBe(false);
    expect(report).toEqual({
      used: "hash",
      requested: "hash",
      degraded: false,
      semantic: false,
    });
  });

  it("reports an explicit degradation for the removed clip backend", () => {
    const { embedder, report } = resolveEmbedder({ backend: "clip", dim: 512 });

    expect(embedder).toBeInstanceOf(HashEmbedder);
    expect(embedder.semantic).toBe(false);
    expect(report.used).toBe("hash");
    expect(report.requested).toBe("clip");
    expect(report.degraded).toBe(true);
    expect(report.semantic).toBe(false);
    expect(report.reason).toContain("not implemented");
    expect(report.reason).toContain("NOT semantic");
  });

  it("treats blank/absent backends as hash", () => {
    expect(resolveEmbedder({ backend: "  ", dim: 512 }).report.degraded).toBe(false);
  });

  it("degrades any other unknown backend rather than throwing", () => {
    const { report } = resolveEmbedder({ backend: "siglip", dim: 256 });
    expect(report.degraded).toBe(true);
    expect(report.requested).toBe("siglip");
  });

  it("honours the configured dimension", async () => {
    const { embedder } = resolveEmbedder({ backend: "hash", dim: 64 });
    expect(embedder.dim).toBe(64);
    expect((await embedder.embedText("hello world")).length).toBe(64);
  });
});
