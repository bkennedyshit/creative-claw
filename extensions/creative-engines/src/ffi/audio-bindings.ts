/**
 * Audio engine koffi bindings (`libomni_audio_bridge`).
 *
 * Buffer contract: float32 PCM samples. The dispatcher decodes audio to
 * interleaved/mono float32 via ffmpeg, calls the C++ DSP op in-process, then
 * re-encodes via ffmpeg.
 *
 * Two families:
 *   - in-place  : `void bridge_x(float* samples, int n, <params>)` — mutates
 *                 the sample buffer directly; no output buffer.
 *   - out-buffer: `void bridge_x(float* samples, int n, <params>, float* out)`.
 *
 * A param literally named `sample_rate` is overridden at dispatch time with the
 * media's real sample rate (mirrors the Python `sample_rate` injection).
 *
 * Stereo / byref / analysis ops (freeverb, autopan, ms_encode, time_stretch,
 * beat_detect, lufs_measure, …) are marked `special` and reported honestly
 * rather than run through the single-buffer file apply path.
 */

import { buildPrototype, P, type EngineBindingModule, type FfiParam, type OpBinding } from "./binding-types.js";

const LEADING = "float* samples, int n";

/** In-place DSP op: mutates the sample buffer, no output buffer. */
function inPlace(name: string, symbol: string, params: FfiParam[], description: string): OpBinding {
  return {
    name,
    signature: buildPrototype(symbol, params, { leading: LEADING, trailing: "" }),
    params,
    kind: "filter",
    chainable: true,
    inPlace: true,
    description,
  };
}

/** Out-buffer DSP op: reads samples, writes a same-length float32 out buffer. */
function outBuf(name: string, symbol: string, params: FfiParam[], description: string): OpBinding {
  return {
    name,
    signature: buildPrototype(symbol, params, { leading: LEADING, trailing: "float* out" }),
    params,
    kind: "filter",
    chainable: true,
    inPlace: false,
    description,
  };
}

/** Stereo / byref / analysis op not reachable via the mono file apply path. */
function special(name: string, signature: string, params: FfiParam[], description: string): OpBinding {
  return { name, signature, params, kind: "special", chainable: false, stereo: true, description };
}

const ops: OpBinding[] = [
  // ── ORIGINAL — in-place ──────────────────────────────────────────────────
  inPlace("noise_gate", "noise_gate", [P.float("threshold_db", -40.0), P.float("attack_ms", 1.0), P.float("release_ms", 50.0), P.int("sample_rate", 44100)], "Noise gate."),
  inPlace("limiter", "limiter", [P.float("ceiling_db", -1.0), P.float("release_ms", 50.0), P.int("sample_rate", 44100)], "Brickwall limiter."),
  inPlace("chorus", "chorus", [P.int("sample_rate", 44100), P.float("rate_hz", 1.5), P.float("depth_ms", 7.0), P.float("mix", 0.5)], "Chorus."),
  inPlace("flanger", "flanger", [P.int("sample_rate", 44100), P.float("rate_hz", 0.5), P.float("depth_ms", 3.0), P.float("feedback", 0.7)], "Flanger."),
  inPlace("phaser", "phaser", [P.int("sample_rate", 44100), P.float("rate_hz", 0.5), P.float("depth", 0.7), P.float("feedback", 0.7), P.int("stages", 4)], "Phaser."),
  inPlace("deesser", "deesser", [P.int("sample_rate", 44100), P.float("freq_hz", 6000.0), P.float("threshold_db", -20.0), P.float("ratio", 4.0)], "De-esser."),
  inPlace("transient_shaper", "transient_shaper", [P.int("sample_rate", 44100), P.float("attack_gain", 2.0), P.float("sustain_gain", 1.0)], "Transient shaper."),
  inPlace("eq_parametric", "eq_parametric", [P.int("sample_rate", 44100), P.float("freq_hz", 1000.0), P.float("gain_db", 0.0), P.float("q", 1.0)], "Parametric EQ band."),
  inPlace("compressor", "compressor", [P.int("sample_rate", 44100), P.float("threshold_db", -20.0), P.float("ratio", 4.0), P.float("attack_ms", 5.0), P.float("release_ms", 50.0)], "Compressor."),

  // ── ORIGINAL — out-buffer ────────────────────────────────────────────────
  outBuf("pitch_shift", "pitch_shift", [P.float("semitones", 0.0)], "Pitch shift (semitones)."),
  outBuf("reverb_simple", "reverb_simple", [P.int("sample_rate", 44100), P.float("decay", 0.5), P.float("mix", 0.3)], "Simple reverb."),

  // ── ORIGINAL — special (byref / analysis / stereo) ───────────────────────
  special("time_stretch", "void bridge_time_stretch(float* samples, int n, float factor, float* out, int* out_count)", [P.float("factor", 1.0)], "Time stretch (variable-length out)."),
  { name: "beat_detect", signature: "void bridge_beat_detect(float* samples, int n, int sample_rate, float* beats, int max_beats, int* num_beats)", params: [], kind: "analysis", chainable: false, description: "Beat detection (returns timestamps)." },
  { name: "lufs_measure", signature: "void bridge_lufs_measure(float* samples, int n, int sample_rate, float* result)", params: [], kind: "analysis", chainable: false, description: "LUFS loudness measurement." },
  special("stereo_widen", "void bridge_stereo_widen(float* left, float* right, int n, float width)", [P.float("width", 1.5)], "Stereo widen (L/R in-place)."),

  // ── NEW (30) — out-buffer ────────────────────────────────────────────────
  outBuf("reverb_allpass", "audio_reverb_allpass", [P.int("delay", 500), P.float("gain", 0.5)], "Allpass reverb stage."),
  outBuf("reverb_comb", "audio_reverb_comb", [P.int("delay", 1557), P.float("feedback", 0.84), P.float("damp", 0.2)], "Comb reverb stage."),
  special("reverb_freeverb", "void bridge_audio_reverb_freeverb(float* left, float* right, int n, int sample_rate, float room, float damp, float wet, float dry, float width)", [P.int("sample_rate", 44100), P.float("room", 0.5), P.float("damp", 0.5), P.float("wet", 0.3), P.float("dry", 0.7), P.float("width", 1.0)], "Freeverb (stereo)."),
  outBuf("compressor_rms", "audio_compressor_rms", [P.int("sample_rate", 44100), P.float("threshold_db", -20.0), P.float("ratio", 4.0), P.float("attack_ms", 10.0), P.float("release_ms", 100.0), P.float("knee_db", 0.0), P.float("makeup_db", 0.0)], "RMS compressor."),
  outBuf("compressor_peak", "audio_compressor_peak", [P.int("sample_rate", 44100), P.float("threshold_db", -20.0), P.float("ratio", 4.0), P.float("attack_ms", 5.0), P.float("release_ms", 50.0)], "Peak compressor."),
  outBuf("expander", "audio_expander", [P.int("sample_rate", 44100), P.float("threshold_db", -40.0), P.float("ratio", 2.0), P.float("attack_ms", 5.0), P.float("release_ms", 50.0)], "Expander."),
  outBuf("gate", "audio_gate", [P.int("sample_rate", 44100), P.float("threshold_db", -40.0), P.float("attack_ms", 1.0), P.float("hold_ms", 10.0), P.float("release_ms", 100.0)], "Gate with hold."),
  outBuf("limiter_lookahead", "audio_limiter_lookahead", [P.int("sample_rate", 44100), P.float("ceiling_db", -0.1), P.float("lookahead_ms", 5.0), P.float("release_ms", 50.0)], "Look-ahead limiter."),
  outBuf("chorus_multi", "audio_chorus_multi", [P.int("sample_rate", 44100), P.int("voices", 3), P.float("rate", 1.5), P.float("depth_ms", 7.0), P.float("spread", 1.0), P.float("mix", 0.5)], "Multi-voice chorus."),
  outBuf("flanger_effect", "audio_flanger", [P.int("sample_rate", 44100), P.float("rate", 0.5), P.float("depth_ms", 3.0), P.float("feedback", 0.7), P.float("mix", 0.5)], "Flanger (out-buffer)."),
  outBuf("phaser_4stage", "audio_phaser_4stage", [P.int("sample_rate", 44100), P.float("rate", 0.5), P.float("depth", 0.7), P.float("feedback", 0.7), P.float("mix", 0.5)], "4-stage phaser."),
  outBuf("tremolo", "audio_tremolo", [P.int("sample_rate", 44100), P.float("rate", 4.0), P.float("depth", 0.5)], "Tremolo."),
  outBuf("vibrato", "audio_vibrato", [P.int("sample_rate", 44100), P.float("rate", 5.0), P.float("depth_ms", 2.0)], "Vibrato."),
  outBuf("distortion_soft_clip", "audio_distortion_soft_clip", [P.float("drive", 2.0), P.float("mix", 1.0)], "Soft-clip distortion."),
  outBuf("distortion_hard_clip", "audio_distortion_hard_clip", [P.float("threshold", 0.8)], "Hard-clip distortion."),
  outBuf("distortion_waveshape", "audio_distortion_waveshape", [P.float("amount", 2.0)], "Waveshaper distortion."),
  outBuf("bitcrusher", "audio_bitcrusher", [P.int("bits", 8), P.float("sample_rate_reduction", 0.5)], "Bitcrusher."),
  outBuf("ring_mod", "audio_ring_mod", [P.int("sample_rate", 44100), P.float("freq", 440.0), P.float("mix", 1.0)], "Ring modulator."),
  special("autopan", "void bridge_audio_autopan(float* left, float* right, int n, int sample_rate, float rate, float depth, float* out_l, float* out_r)", [P.int("sample_rate", 44100), P.float("rate", 1.0), P.float("depth", 1.0)], "Auto-pan (stereo)."),
  special("haas", "void bridge_audio_haas(float* left, float* right, int n, int sample_rate, float delay_ms, float* out_l, float* out_r)", [P.int("sample_rate", 44100), P.float("delay_ms", 10.0)], "Haas widening (stereo)."),
  special("ms_encode", "void bridge_audio_ms_encode(float* left, float* right, int n, float* mid, float* side)", [], "Mid/side encode (stereo)."),
  special("ms_decode", "void bridge_audio_ms_decode(float* mid, float* side, int n, float width, float* left, float* right)", [P.float("width", 1.0)], "Mid/side decode (stereo)."),
  outBuf("deesser_split", "audio_deesser_split", [P.int("sample_rate", 44100), P.float("freq", 6000.0), P.float("threshold_db", -20.0), P.float("ratio", 4.0)], "Split-band de-esser."),
  outBuf("transient_attack", "audio_transient_attack", [P.int("sample_rate", 44100), P.float("attack_gain_db", 6.0), P.float("attack_ms", 1.0)], "Transient attack shaper."),
  outBuf("transient_sustain", "audio_transient_sustain", [P.int("sample_rate", 44100), P.float("sustain_gain_db", 6.0), P.float("release_ms", 50.0)], "Transient sustain shaper."),
  outBuf("eq_low_shelf", "audio_eq_low_shelf", [P.int("sample_rate", 44100), P.float("freq", 200.0), P.float("gain_db", 0.0)], "Low-shelf EQ."),
  outBuf("eq_high_shelf", "audio_eq_high_shelf", [P.int("sample_rate", 44100), P.float("freq", 8000.0), P.float("gain_db", 0.0)], "High-shelf EQ."),
  outBuf("eq_band_pass", "audio_eq_band_pass", [P.int("sample_rate", 44100), P.float("freq", 1000.0), P.float("q", 1.0)], "Band-pass EQ."),
  outBuf("eq_notch", "audio_eq_notch", [P.int("sample_rate", 44100), P.float("freq", 1000.0), P.float("q", 1.0)], "Notch EQ."),
  outBuf("eq_high_pass", "audio_eq_high_pass", [P.int("sample_rate", 44100), P.float("freq", 80.0), P.float("q", 0.707)], "High-pass EQ."),
];

export const KNOWN_BROKEN = new Set<string>();

/** Ops that require stereo/byref handling, not the mono file apply path. */
export const SPECIAL = new Set<string>(ops.filter((o) => o.kind === "special" || o.kind === "analysis").map((o) => o.name));

export const audioBindings: EngineBindingModule = {
  engine: "audio",
  libraryStem: "omni_audio_bridge",
  ops,
  knownBroken: KNOWN_BROKEN,
};
