import { readFileSync } from "node:fs";
import type { Embedder } from "./index.js";

/**
 * HashEmbedder: deterministic, non-semantic embedding via char-trigram bags (text)
 * or byte-chunk hashing (images). L2-normalized to a fixed dimension (default 512).
 * Same input always produces the same output — no model required.
 */
export class HashEmbedder implements Embedder {
  readonly dim: number;
  readonly semantic = false;

  constructor(dim = 512) {
    this.dim = dim;
  }

  async embedText(text: string): Promise<Float32Array> {
    const vec = new Float32Array(this.dim);
    const normalized = text.toLowerCase();

    // Generate char trigrams and accumulate into buckets
    for (let i = 0; i <= normalized.length - 3; i++) {
      const trigram = normalized.slice(i, i + 3);
      const bucket = hashString(trigram) % this.dim;
      vec[bucket] += 1;
    }

    return l2Normalize(vec);
  }

  async embedImage(filePath: string): Promise<Float32Array> {
    const vec = new Float32Array(this.dim);
    const bytes = readFileSync(filePath);

    // Hash chunks of 64 bytes into buckets
    const chunkSize = 64;
    for (let offset = 0; offset + chunkSize <= bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, offset + chunkSize);
      const hash = hashBytes(chunk);
      const bucket = hash % this.dim;
      // Use a secondary hash for the value to add variation
      const value = ((hash >>> 16) & 0xffff) / 65535;
      vec[bucket] += value;
    }

    // Also hash any trailing bytes
    if (bytes.length % chunkSize !== 0) {
      const trailing = bytes.subarray(bytes.length - (bytes.length % chunkSize));
      const hash = hashBytes(trailing);
      vec[hash % this.dim] += 1;
    }

    return l2Normalize(vec);
  }
}

/** FNV-1a hash for a short string, returns unsigned 32-bit int. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** FNV-1a hash for a byte buffer, returns unsigned 32-bit int. */
function hashBytes(buf: Uint8Array): number {
  let h = 0x811c9dc5;
  for (const byte of buf) {
    h ^= byte;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** L2-normalize a vector in place. Returns the same array. */
function l2Normalize(vec: Float32Array): Float32Array {
  let sumSq = 0;
  for (const value of vec) {
    sumSq += value * value;
  }
  const norm = Math.sqrt(sumSq);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) {
      vec[i] /= norm;
    }
  }
  return vec;
}
