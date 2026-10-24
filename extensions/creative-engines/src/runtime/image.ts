import type { CodecConfig } from "../ffi/codec.js";
import type { NativeDispatch } from "../ffi/dispatch.js";
import { imageBindings } from "../ffi/image-bindings.js";
import { withGpuClaim } from "../gpu-coop.js";
import type { EngineConfig } from "../types.js";
import { EngineRuntime } from "./engine-runtime.js";

/**
 * Image engine runtime — loads `libomni_image_bridge` in-process and calls its
 * `bridge_*` filters directly via koffi. No port, no HTTP, no co-process.
 */
export class ImageEngineRuntime extends EngineRuntime {
  segmentationReason() {
    return this.isAvailable() ? this.ensureDispatch().segmentationReason() : this.reason();
  }

  async withForegroundSegmenter<T>(
    run: (segment: NativeDispatch["segmentRgba"]) => Promise<T>,
  ): Promise<T> {
    await this.ensureStarted();
    const reason = this.segmentationReason();
    if (reason) {
      throw new Error(reason);
    }
    const dispatch = this.ensureDispatch();
    // Hold a single broker lease across all frames, not an eviction/reload per frame.
    return withGpuClaim(() =>
      run((data, width, height) => dispatch.segmentRgba(data, width, height)),
    );
  }
  constructor(config: Partial<EngineConfig> = {}, codec?: CodecConfig) {
    super({
      engineName: "image",
      bindings: imageBindings,
      config: { binaryPath: config.binaryPath, available: false },
      codec,
    });
  }
}
