import type { CodecConfig } from "../ffi/codec.js";
import { vectorBindings } from "../ffi/vector-bindings.js";
import type { EngineConfig } from "../types.js";
import { EngineRuntime } from "./engine-runtime.js";

/**
 * Vector engine runtime — loads `omni_vector_bridge` in-process and calls its
 * path/geometry `bridge_*` ops directly via koffi. SVG in → SVG/PNG out.
 */
export class VectorEngineRuntime extends EngineRuntime {
  constructor(config: Partial<EngineConfig> = {}, codec?: CodecConfig) {
    super({
      engineName: "vector",
      bindings: vectorBindings,
      config: { binaryPath: config.binaryPath, available: false },
      codec,
    });
  }
}
