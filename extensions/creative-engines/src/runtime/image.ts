import type { EngineConfig } from "../types.js";
import type { CodecConfig } from "../ffi/codec.js";
import { imageBindings } from "../ffi/image-bindings.js";
import { EngineRuntime } from "./engine-runtime.js";

/**
 * Image engine runtime — loads `libomni_image_bridge` in-process and calls its
 * `bridge_*` filters directly via koffi. No port, no HTTP, no co-process.
 */
export class ImageEngineRuntime extends EngineRuntime {
  constructor(config: Partial<EngineConfig> = {}, codec?: CodecConfig) {
    super({
      engineName: "image",
      bindings: imageBindings,
      config: { binaryPath: config.binaryPath, available: false },
      codec,
    });
  }
}
