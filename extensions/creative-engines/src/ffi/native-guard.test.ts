import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { resolveBinaryPath } from "./loader.js";

const engine = resolveBinaryPath("omni_image_bridge");
const ort = resolveBinaryPath("onnxruntime");
const shared = resolveBinaryPath("onnxruntime_providers_shared");
it.skipIf(!engine || !ort)(
  "guards invalid buffers and corrupt models without terminating the native process",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "creative-native-guard-"));
    try {
      const model = join(directory, "corrupt.onnx");
      await writeFile(model, "not an ONNX graph");
      const script = `import koffi from 'koffi';
      ${shared ? `koffi.load(${JSON.stringify(shared)});` : ""}
      koffi.load(${JSON.stringify(ort)});
      const lib = koffi.load(${JSON.stringify(engine)});
      lib.func('void bridge_segment_cpu_only(int enabled)')(1);
      const segment = lib.func('int bridge_segment_foreground(uint8_t *pixels, int w, int h, int channels, uint8_t *out)');
      const pixels = Buffer.alloc(64, 100), out = Buffer.alloc(16, 17);
      const invalid = segment(pixels, 0, 4, 4, out);
      const untouched = out.every(value => value === 17);
      const corrupt = await new Promise((resolve, reject) => segment.async(pixels, 4, 4, 4, out, (error, status) => error ? reject(error) : resolve(status)));
      console.log(JSON.stringify({invalid, untouched, corrupt, sentinel: out.every(value => value === 255), preserved: pixels.every(value => value === 100)}));`;
      const result = await promisify(execFile)(
        process.execPath,
        ["--input-type=module", "-e", script],
        { env: { ...process.env, OMNI_SEG_MODEL: model }, timeout: 20000 },
      );
      expect(JSON.parse(result.stdout.trim())).toEqual({
        invalid: 1,
        untouched: true,
        corrupt: 2,
        sentinel: true,
        preserved: true,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);
