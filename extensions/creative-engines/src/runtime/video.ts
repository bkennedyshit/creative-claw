import type { CodecConfig } from "../ffi/codec.js";
import { videoBindings } from "../ffi/video-bindings.js";
import type { EngineConfig } from "../types.js";
import { EngineRuntime } from "./engine-runtime.js";

/**
 * Video engine runtime — loads `libomni_video_bridge` in-process. Per-frame
 * effects run on the C++ engine via koffi (frames decoded/encoded with
 * ffmpeg); file-level ops (cut/concat/silence/export) use ffmpeg as a codec.
 */
export class VideoEngineRuntime extends EngineRuntime {
  constructor(config: Partial<EngineConfig> = {}, codec?: CodecConfig) {
    super({
      engineName: "video",
      bindings: videoBindings,
      config: { binaryPath: config.binaryPath, available: false },
      codec,
    });
  }
}
