/**
 * Video engine koffi bindings (`libomni_video_bridge`) — a hybrid engine.
 *
 * Two layers, exactly as in the reference bridge:
 *   - C++ frame ops : per-frame pixel/signal math called in-process via koffi.
 *                     The dispatcher decodes the video to raw RGBA frames with
 *                     ffmpeg, applies the C++ op to every frame in-process, then
 *                     re-encodes with ffmpeg. The OPERATION runs on the C++
 *                     engine; ffmpeg is only the codec.
 *   - ffmpeg ops    : file-level editing (cut, concat, silence removal, scene
 *                     detection, platform export, …). These are `kind: "ffmpeg"`
 *                     and shell out to ffmpeg — a codec/container tool, not a
 *                     separate app orchestrated for the effect itself.
 *
 * Two-buffer transitions, blend modes, timeline handles, timecode and keyframe
 * math are `special` and reported honestly by the single-input file apply path.
 */

import { buildPrototype, P, type EngineBindingModule, type FfiParam, type OpBinding } from "./binding-types.js";

/** Per-frame C++ filter: RGBA frame in, same-sized frame out. */
function frame(name: string, symbol: string, params: FfiParam[], description: string): OpBinding {
  return { name, signature: buildPrototype(symbol, params), params, kind: "filter", chainable: true, description };
}

/** Per-frame C++ op that resizes each frame (dims from params). */
function frameResize(name: string, symbol: string, params: FfiParam[], leading: string, description: string): OpBinding {
  return { name, signature: buildPrototype(symbol, params, { leading }), params, kind: "resizing", chainable: true, description };
}

/** ffmpeg pipeline op — file in/out; no koffi prototype. */
function ffmpeg(name: string, params: FfiParam[], description: string): OpBinding {
  return { name, signature: `ffmpeg:${name}`, params, kind: "ffmpeg", chainable: false, description };
}

/** ffmpeg analysis op — returns data (timestamps/segments). */
function ffmpegAnalysis(name: string, params: FfiParam[], description: string): OpBinding {
  return { name, signature: `ffmpeg:${name}`, params, kind: "analysis", chainable: false, description };
}

/** Multi-buffer / handle / timecode op not reachable via single-input apply. */
function special(name: string, signature: string, params: FfiParam[], description: string): OpBinding {
  return { name, signature, params, kind: "special", chainable: false, description };
}

const ops: OpBinding[] = [
  // ── C++ FRAME EFFECTS ────────────────────────────────────────────────────
  frame("motion_blur", "motion_blur", [P.float("angle_deg", 0.0), P.float("strength", 5.0)], "Directional motion blur."),
  frame("chromatic_aberration", "chromatic_aberration", [P.float("offset_px", 3.0)], "Chromatic aberration."),
  frame("vignette", "vignette", [P.float("strength", 0.5), P.float("feather", 0.3)], "Vignette."),
  frame("film_grain", "film_grain", [P.float("intensity", 0.05), P.int("seed", 42)], "Film grain."),
  frame("sharpen", "sharpen", [P.float("strength", 1.0)], "Sharpen."),
  frame("lens_distort", "lens_distort", [P.float("k1", 0.1), P.float("k2", 0.05)], "Lens distortion."),
  frame("stabilize_frame", "stabilize_frame", [P.float("dx", 0.0), P.float("dy", 0.0), P.float("angle", 0.0)], "Per-frame stabilization transform."),
  frame("chroma_key", "chroma_key", [P.u8("key_r", 0), P.u8("key_g", 255), P.u8("key_b", 0), P.float("tolerance", 0.15), P.float("softness", 0.1)], "Chroma key."),
  frame("letterbox", "letterbox", [P.float("aspect_ratio", 1.7778)], "Letterbox to aspect ratio."),
  frame("video_transform_flip_h", "video_transform_flip_h", [], "Flip horizontally."),
  frame("video_transform_flip_v", "video_transform_flip_v", [], "Flip vertically."),
  frame("video_transform_apply", "video_transform_apply", [P.float("tx", 0.0), P.float("ty", 0.0), P.float("sx", 1.0), P.float("sy", 1.0), P.float("rot_deg", 0.0)], "Translate/scale/rotate."),
  frame("video_clip_set_opacity", "video_clip_set_opacity", [P.float("opacity", 1.0)], "Set clip opacity."),

  // ── C++ FRAME RESIZE / CROP ──────────────────────────────────────────────
  frameResize("video_transform_resize", "video_transform_resize", [P.int("dw", 0), P.int("dh", 0)], "uint8* pixels, int sw, int sh, int channels", "Resize each frame."),
  frameResize("video_transform_crop", "video_transform_crop", [P.int("x", 0), P.int("y", 0), P.int("cw", 0), P.int("crop_h", 0)], "uint8* pixels, int w, int h, int channels", "Crop each frame."),

  // ── ffmpeg PIPELINE OPS (codec/container; effect logic is elsewhere) ──────
  ffmpeg("cut_clip", [P.float("start_sec", 0.0), P.float("end_sec", 0.0), P.bool("stream_copy", true)], "Extract a clip [start,end]."),
  ffmpeg("remove_silence", [P.float("noise_db", -40.0), P.float("min_duration", 0.5), P.float("padding", 0.1)], "Remove silent segments."),
  ffmpeg("stabilize", [P.int("smoothing", 10)], "Two-pass video stabilization."),
  ffmpeg("speed_ramp", [P.float("factor", 2.0)], "Change playback speed."),
  ffmpeg("add_subtitles", [P.str("srt_path", "")], "Burn subtitles from an SRT file."),
  ffmpeg("extract_audio", [], "Extract audio track to WAV."),
  ffmpeg("replace_audio", [P.str("audio_path", "")], "Replace the audio track."),
  ffmpeg("thumbnail", [P.float("time_sec", 3.0)], "Extract a thumbnail frame."),
  ffmpeg("export_for_platform", [P.str("platform", "youtube")], "Export for tiktok/instagram/youtube/twitter/linkedin."),
  ffmpegAnalysis("detect_scenes", [P.float("threshold", 0.3)], "Detect scene-cut timestamps (ffmpeg)."),
  ffmpegAnalysis("detect_silence", [P.float("noise_db", -40.0), P.float("min_duration", 0.5)], "Detect silent segments (ffmpeg)."),

  // ── SPECIAL — two-buffer transitions / blends ────────────────────────────
  special("transition_dissolve", "void bridge_transition_dissolve(uint8* frame_a, uint8* frame_b, int w, int h, int channels, float progress, uint8* out)", [P.float("progress", 0.5)], "Dissolve transition (2 frames)."),
  special("transition_wipe", "void bridge_transition_wipe(uint8* frame_a, uint8* frame_b, int w, int h, int channels, float progress, int direction, uint8* out)", [P.float("progress", 0.5), P.int("direction", 0)], "Wipe transition (2 frames)."),
  special("frame_blend", "void bridge_frame_blend(uint8* frame_a, uint8* frame_b, int w, int h, int channels, float alpha, uint8* out)", [P.float("alpha", 0.5)], "Blend two frames."),
  special("color_match", "void bridge_color_match(uint8* src, uint8* ref, int w, int h, int channels, uint8* out)", [], "Match color to a reference frame."),
  special("temporal_denoise", "void bridge_temporal_denoise(uint8* curr, uint8* prev, int w, int h, int channels, float blend, uint8* out)", [P.float("blend", 0.3)], "Temporal denoise (needs prev frame)."),
  special("scene_detect", "void bridge_scene_detect(uint8* frame_a, uint8* frame_b, int w, int h, int channels, float* score)", [], "Scene-change score between two frames."),
  special("video_clip_blend_mode_multiply", "void bridge_video_clip_blend_mode_multiply(uint8* a, uint8* b, int w, int h, int channels, uint8* out)", [], "Multiply blend (2 frames)."),
  special("video_clip_blend_mode_screen", "void bridge_video_clip_blend_mode_screen(uint8* a, uint8* b, int w, int h, int channels, uint8* out)", [], "Screen blend (2 frames)."),
  special("video_clip_blend_mode_overlay", "void bridge_video_clip_blend_mode_overlay(uint8* a, uint8* b, int w, int h, int channels, uint8* out)", [], "Overlay blend (2 frames)."),
  special("video_clip_blend_mode_add", "void bridge_video_clip_blend_mode_add(uint8* a, uint8* b, int w, int h, int channels, uint8* out)", [], "Add blend (2 frames)."),

  // ── SPECIAL — subtitle burn (string + color) ─────────────────────────────
  special("subtitle_burn", "void bridge_subtitle_burn(uint8* pixels, int w, int h, int channels, int x, int y, int font_h, uint8 r, uint8 g, uint8 b, const char* text, uint8* out)", [P.int("x", 0), P.int("y", 0), P.int("font_h", 24), P.u8("r", 255), P.u8("g", 255), P.u8("b", 255), P.str("text", "")], "Burn text onto a frame."),

  // ── SPECIAL — timeline handle / timecode / keyframe ──────────────────────
  special("video_timeline_create", "void* bridge_video_timeline_create(float fps_num, float fps_den, int samplerate)", [P.float("fps_num", 30.0), P.float("fps_den", 1.0), P.int("samplerate", 48000)], "Create a timeline handle."),
  special("video_timeline_destroy", "void bridge_video_timeline_destroy(void* tl)", [], "Destroy a timeline handle."),
  special("video_timecode_frames_to_smpte", "void bridge_video_timecode_frames_to_smpte(int frames, float fps, char* out, int out_len)", [P.int("frames", 0), P.float("fps", 30.0)], "Frames → SMPTE timecode."),
  special("video_timecode_smpte_to_frames", "int bridge_video_timecode_smpte_to_frames(const char* smpte, float fps)", [P.str("smpte", "00:00:00:00"), P.float("fps", 30.0)], "SMPTE timecode → frames."),
  special("video_keyframe_lerp", "float bridge_video_keyframe_lerp(float* times, float* values, int n, float t)", [P.float("t", 0.0)], "Keyframe linear interpolation."),
  special("video_keyframe_ease_in_out", "float bridge_video_keyframe_ease_in_out(float* times, float* values, int n, float t)", [P.float("t", 0.0)], "Keyframe ease in/out."),

  // ── SPECIAL — LUT / curves / lift-gamma-gain (multi-array) ───────────────
  special("lut_apply", "void bridge_lut_apply(uint8* pixels, int w, int h, int channels, uint8* lut, int lut_size, uint8* out)", [P.int("lut_size", 0)], "Apply a 3D LUT (needs LUT buffer)."),
  special("color_curves", "void bridge_color_curves(uint8* pixels, int w, int h, int channels, float* curve_r, float* curve_g, float* curve_b, int curve_len, uint8* out)", [], "RGB curves (needs curve arrays)."),
  special("lift_gamma_gain", "void bridge_lift_gamma_gain(uint8* pixels, int w, int h, int channels, float lr, float lg, float lb, float gr, float gg, float gb, float gnr, float gng, float gnb, uint8* out)", [P.float("lr", 0), P.float("lg", 0), P.float("lb", 0), P.float("gr", 1), P.float("gg", 1), P.float("gb", 1), P.float("gnr", 1), P.float("gng", 1), P.float("gnb", 1)], "Lift/gamma/gain color grade."),
];

export const KNOWN_BROKEN = new Set<string>();

/** ffmpeg-dispatched ops (file in/out). */
export const FFMPEG_OPS = new Set<string>(ops.filter((o) => o.kind === "ffmpeg").map((o) => o.name));

/** ffmpeg-backed analysis ops. */
export const ANALYSIS_OPS = new Set<string>(ops.filter((o) => o.kind === "analysis").map((o) => o.name));

/** Per-frame C++ ops that run in-process on every decoded frame. */
export const FRAME_OPS = new Set<string>(ops.filter((o) => o.kind === "filter" || o.kind === "resizing").map((o) => o.name));

export const videoBindings: EngineBindingModule = {
  engine: "video",
  libraryStem: "omni_video_bridge",
  ops,
  knownBroken: KNOWN_BROKEN,
};
