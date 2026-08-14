import { audioBindings } from "../ffi/audio-bindings.js";
import type { CodecConfig } from "../ffi/codec.js";
import type { EngineConfig } from "../types.js";
import { EngineRuntime } from "./engine-runtime.js";

/**
 * Audio engine runtime — loads `libomni_audio_bridge` in-process and calls its
 * DSP `bridge_*` ops directly via koffi. ffmpeg is used only to decode/encode
 * float PCM; the effects run on the C++ engine in-process.
 */
export class AudioEngineRuntime extends EngineRuntime {
  constructor(config: Partial<EngineConfig> = {}, codec?: CodecConfig) {
    super({
      engineName: "audio",
      bindings: audioBindings,
      config: { binaryPath: config.binaryPath, available: false },
      codec,
    });
  }
}
