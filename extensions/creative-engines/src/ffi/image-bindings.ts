/**
 * Image engine koffi bindings — the reference/most complete catalog.
 *
 * Every entry mirrors a compiled `bridge_*` export from the image engine
 * (`libomni_image_bridge`). The koffi C prototype is generated from the param
 * metadata via {@link buildPrototype}, producing declarations equivalent to
 *   koffi.func('void bridge_gaussian_blur(uint8* pixels, int w, int h, int channels, float sigma, uint8* out)')
 * for every op.
 *
 * Buffer contract (RGBA, channels defaults to 4):
 *   - filter    : input pixels `w*h*channels`, output `w*h*channels`.
 *   - mask       : input pixels `w*h*channels`, output single-channel `w*h`.
 *   - resizing   : output dimensions differ (scale/crop/seam_carving).
 *   - generator  : no input pixels; synthesizes `w*h*4` RGBA.
 *
 * Dispatcher gating (ported from omni_dispatch.py):
 *   - `KNOWN_BROKEN`     : empty today; ops here are skipped honestly.
 *   - `MASK_FILTERS`     : magic_wand / quick_select / select_color_range.
 *   - `RESIZING_FILTERS` : scale / crop / seam_carving (custom out dims).
 *   - `NON_FILTER`       : analysis/generator/special ops excluded from the
 *                          image→image filter surface.
 */

import {
  buildPrototype,
  P,
  type EngineBindingModule,
  type FfiParam,
  type OnnxOpSpec,
  type OpBinding,
} from "./binding-types.js";

/** Standard image→image filter: pixels+header in, `w*h*channels` out. */
function filter(
  name: string,
  symbol: string,
  params: FfiParam[],
  description: string,
  chainable = true,
): OpBinding {
  return {
    name,
    signature: buildPrototype(symbol, params),
    params,
    kind: "filter",
    chainable,
    description,
  };
}

/** Selection tool: pixels in, single-channel `w*h` mask out. */
function mask(name: string, symbol: string, params: FfiParam[], description: string): OpBinding {
  return {
    name,
    signature: buildPrototype(symbol, params, { trailing: "uint8* mask" }),
    params,
    kind: "mask",
    chainable: false,
    description,
  };
}

/** Resizing filter: output dimensions are derived from params, not the input. */
function resizing(
  name: string,
  symbol: string,
  params: FfiParam[],
  description: string,
): OpBinding {
  return {
    name,
    signature: buildPrototype(symbol, params),
    params,
    kind: "resizing",
    chainable: true,
    description,
  };
}

/** Generator: no input pixels; produces `w*h*4` RGBA from size + params. */
function generator(
  name: string,
  symbol: string,
  params: FfiParam[],
  description: string,
): OpBinding {
  return {
    name,
    signature: buildPrototype(symbol, params, { leading: "int w, int h" }),
    params,
    kind: "generator",
    chainable: false,
    description,
  };
}

/** Special: stateful, multi-buffer, or handle op not reachable via file apply. */
function special(
  name: string,
  signature: string,
  params: FfiParam[],
  description: string,
): OpBinding {
  return { name, signature, params, kind: "special", chainable: false, description };
}

/** Analysis: returns data rather than media (e.g. histograms). */
function analysis(
  name: string,
  signature: string,
  params: FfiParam[],
  description: string,
): OpBinding {
  return { name, signature, params, kind: "analysis", chainable: false, description };
}

/**
 * Guarded neural filter: same shape as {@link filter}, but the export returns a
 * `BridgeOpStatus` int that the dispatcher must check.
 *
 * The five `bridge_neural_*` exports below are the ONLY ONNX-backed image
 * exports that catch their own exceptions. Declaring them `void` discarded the
 * status, so `OP_EXCEPTION` (model missing / ONNX session create failed /
 * inference failed) reached the caller as `ok: true` plus a sentinel-filled
 * (all-zero) output buffer, which the dispatcher encoded as a valid black PNG.
 */
function guardedNeuralFilter(
  name: string,
  symbol: string,
  params: FfiParam[],
  description: string,
  opts: { trailing?: string } = {},
): OpBinding {
  return {
    name,
    signature: buildPrototype(symbol, params, { restype: "int", ...opts }),
    params,
    kind: "filter",
    chainable: true,
    description,
    status: "bridgeOpStatus",
  };
}

const ops: OpBinding[] = [
  // ── COLOR ──────────────────────────────────────────────────────────────
  filter("adjust_vibrance", "vibrance", [P.float("amount", 0)], "Boost/reduce vibrance (-1..1)."),
  filter(
    "color_temperature",
    "color_temperature",
    [P.float("kelvin", 6500)],
    "Shift color temperature in Kelvin.",
  ),
  filter(
    "hsl_adjust",
    "hsl_adjust",
    [P.float("h", 0), P.float("s", 1), P.float("l", 0)],
    "Legacy HSL adjust.",
  ),
  filter(
    "brightness_contrast",
    "brightness_contrast",
    [P.int("brightness", 0), P.float("contrast", 1)],
    "Brightness (-255..255) + contrast (1=neutral).",
  ),
  filter("invert", "invert", [], "Invert colors (negative)."),
  filter("desaturate", "desaturate", [], "Grayscale, RGBA output preserved."),
  filter(
    "hsl_adjustment",
    "hsl_adjustment",
    [P.float("hue_shift", 0), P.float("saturation_scale", 1), P.float("lightness_offset", 0)],
    "HSL adjustment (hue -180..180, sat scale, lightness -100..100).",
  ),
  filter(
    "histogram_equalization",
    "histogram_equalization",
    [],
    "Contrast enhance via histogram equalization.",
  ),
  analysis(
    "calculate_histogram",
    "void bridge_calculate_histogram(uint8* pixels, int w, int h, int channels, int* out)",
    [],
    "Compute R/G/B/luma histograms.",
  ),
  filter(
    "levels",
    "levels",
    [
      P.int("input_black", 0),
      P.int("input_white", 255),
      P.float("gamma", 1),
      P.int("output_black", 0),
      P.int("output_white", 255),
    ],
    "Levels adjustment.",
  ),
  special(
    "curves_adjustment",
    "void bridge_curves_adjustment(uint8* pixels, int w, int h, int channels, float* points, int n_points, int channel, uint8* out)",
    [P.int("channel", -1)],
    "Curves adjustment (needs a points array; use dedicated tooling).",
  ),
  filter(
    "color_balance",
    "color_balance",
    [
      P.int("shadow_r", 0),
      P.int("shadow_g", 0),
      P.int("shadow_b", 0),
      P.int("midtone_r", 0),
      P.int("midtone_g", 0),
      P.int("midtone_b", 0),
      P.int("highlight_r", 0),
      P.int("highlight_g", 0),
      P.int("highlight_b", 0),
      P.bool("preserve_luminosity", true),
    ],
    "Color balance across shadows/midtones/highlights (-100..100 each).",
  ),

  // ── BLUR ───────────────────────────────────────────────────────────────
  filter("gaussian_blur", "gaussian_blur", [P.float("sigma", 2)], "Gaussian blur."),
  filter("box_blur", "box_blur", [P.int("radius", 3)], "Fast box blur."),
  filter(
    "bilateral_filter",
    "bilateral_filter",
    [P.int("d", 9), P.float("sigma_color", 75), P.float("sigma_space", 75)],
    "Edge-preserving bilateral filter.",
  ),
  filter(
    "motion_blur",
    "motion_blur",
    [P.float("angle", 0), P.float("distance", 20)],
    "Motion blur.",
  ),
  special(
    "lens_blur",
    "void bridge_lens_blur(uint8* pixels, int w, int h, int channels, uint8* depth_map, int radius, int blade_count, float brightness, uint8* out)",
    [P.int("radius", 10), P.int("blade_count", 6), P.float("brightness", 1.5)],
    "Lens/bokeh blur (needs a depth map buffer).",
  ),
  filter(
    "radial_blur",
    "radial_blur",
    [P.int("center_x", 0), P.int("center_y", 0), P.int("amount", 10), P.bool("zoom", true)],
    "Radial (zoom/spin) blur.",
  ),
  filter(
    "smart_blur",
    "smart_blur",
    [P.int("radius", 5), P.float("threshold", 25)],
    "Edge-preserving smart blur.",
  ),
  filter(
    "add_noise",
    "add_noise",
    [P.float("amount", 10), P.int("noise_type", 0), P.bool("monochromatic", false)],
    "Add noise (0=Gaussian,1=Uniform,2=S&P).",
  ),

  // ── SHARPEN / DENOISE ────────────────────────────────────────────────────
  filter(
    "unsharp_mask",
    "unsharp_mask",
    [P.float("radius", 1), P.float("amount", 1), P.int("threshold", 0)],
    "Unsharp mask sharpening.",
  ),
  filter("simple_sharpen", "simple_sharpen", [], "3x3 sharpen kernel."),
  filter("median_filter", "median_filter", [P.int("radius", 1)], "Median filter denoise."),

  // ── EDGE DETECTION ───────────────────────────────────────────────────────
  filter("sobel_magnitude", "sobel_magnitude", [], "Sobel edge magnitude."),
  filter("sobel_direction", "sobel_direction", [], "Sobel gradient direction."),
  filter(
    "canny_edge_detection",
    "canny_edge_detection",
    [P.int("low_threshold", 50), P.int("high_threshold", 150)],
    "Canny edge detection.",
  ),

  // ── TRANSFORMS ───────────────────────────────────────────────────────────
  // rotate_90 / rotate_270 swap output dimensions (handled in dispatch).
  filter("rotate_90", "rotate_90", [], "Rotate 90° CW (dims swap)."),
  filter("rotate_180", "rotate_180", [], "Rotate 180°."),
  filter("rotate_270", "rotate_270", [], "Rotate 270° CW (dims swap)."),
  filter("flip_horizontal", "flip_horizontal", [], "Mirror left-right."),
  filter("flip_vertical", "flip_vertical", [], "Mirror top-bottom."),
  resizing(
    "scale",
    "scale",
    [P.int("new_width", 0), P.int("new_height", 0)],
    "Bilinear scale to new dimensions.",
  ),
  filter("shear", "shear", [P.float("shear_x", 0), P.float("shear_y", 0)], "Shear transform."),
  special(
    "perspective_warp",
    "void bridge_perspective_warp(uint8* pixels, int w, int h, int channels, float* src_points, float* dst_points, uint8* out)",
    [],
    "Perspective warp (needs 4 src/dst corner arrays).",
  ),

  // ── EFFECTS ──────────────────────────────────────────────────────────────
  special(
    "drop_shadow",
    "void bridge_drop_shadow(uint8* pixels, int w, int h, int channels, int offset_x, int offset_y, float blur_radius, uint8* color, float opacity, uint8* out)",
    [
      P.int("offset_x", 5),
      P.int("offset_y", 5),
      P.float("blur_radius", 5),
      P.float("opacity", 0.75),
    ],
    "Drop shadow (needs an RGB color buffer).",
  ),
  filter("sepia", "sepia", [], "Sepia tone."),
  filter("grayscale", "grayscale", [], "Grayscale."),

  // ── SELECTION / MASK ─────────────────────────────────────────────────────
  mask(
    "magic_wand",
    "magic_wand",
    [P.int("start_x", 0), P.int("start_y", 0), P.int("tolerance", 32)],
    "Magic wand selection from a seed point.",
  ),
  // select_color_range takes an RGB color buffer before tolerance (built in dispatch).
  {
    name: "select_color_range",
    signature:
      "void bridge_select_color_range(uint8* pixels, int w, int h, int channels, uint8* target_color, int tolerance, uint8* mask)",
    params: [P.u8("target_r", 0), P.u8("target_g", 0), P.u8("target_b", 0), P.int("tolerance", 32)],
    kind: "mask",
    chainable: false,
    description: "Select pixels within an RGB color range.",
  },
  mask(
    "quick_select",
    "quick_select",
    [P.int("seed_x", 0), P.int("seed_y", 0), P.int("brush_radius", 20), P.int("tolerance", 32)],
    "Quick selection brush.",
  ),
  special(
    "grow_selection",
    "void bridge_grow_selection(uint8* mask, int w, int h, int amount, uint8* out)",
    [P.int("amount", 1)],
    "Grow/shrink a mask (mask-in).",
  ),
  special(
    "feather_mask",
    "void bridge_feather_mask(uint8* mask, int w, int h, float radius, uint8* out)",
    [P.float("radius", 2)],
    "Feather a mask (mask-in).",
  ),
  special(
    "invert_mask",
    "void bridge_invert_mask(uint8* mask, int w, int h, uint8* out)",
    [],
    "Invert a mask (mask-in).",
  ),

  // ── ADVANCED / AI ────────────────────────────────────────────────────────
  resizing(
    "seam_carving",
    "seam_carving",
    [P.int("new_width", 0), P.int("new_height", 0)],
    "Content-aware scale (seam carving).",
  ),
  special(
    "content_aware_fill",
    "void bridge_content_aware_fill(uint8* pixels, int w, int h, int channels, uint8* mask, uint8* out)",
    [],
    "PatchMatch content-aware fill (needs a mask buffer).",
  ),

  // ── STYLIZE ──────────────────────────────────────────────────────────────
  filter(
    "oil_paint",
    "oil_paint",
    [P.int("stylization", 5), P.int("cleanliness", 5)],
    "Oil paint effect.",
  ),
  filter(
    "emboss",
    "emboss",
    [P.int("direction", 0), P.float("height", 3), P.float("amount", 100)],
    "3D relief emboss.",
  ),
  filter("find_edges", "find_edges", [], "Highlight edges."),
  filter("solarize", "solarize", [P.float("threshold", 128)], "Partial tone inversion."),
  filter("posterize", "posterize", [P.int("levels", 4)], "Reduce color levels."),
  filter(
    "threshold_filter",
    "threshold_filter",
    [P.float("threshold_value", 128)],
    "Binary threshold.",
  ),
  filter("diffuse", "diffuse", [P.int("mode", 0)], "Scatter pixels."),
  filter(
    "wind_effect",
    "wind_effect",
    [P.int("direction", 1), P.int("strength", 10)],
    "Wind streaks.",
  ),
  filter(
    "glowing_edges",
    "glowing_edges",
    [P.int("edge_width", 4), P.int("edge_brightness", 10), P.int("smoothness", 5)],
    "Neon-glow edges.",
  ),
  filter("mosaic", "mosaic", [P.int("cell_size", 10)], "Pixelate into square blocks."),
  filter("crystallize", "crystallize", [P.int("cell_size", 15)], "Crystal polygon pattern."),
  filter("pointillize", "pointillize", [P.int("cell_size", 5)], "Dot pattern."),
  filter("fragment", "fragment", [P.int("fragments", 4), P.int("distance", 10)], "Shattered look."),
  filter("mezzotint", "mezzotint", [P.int("mtype", 1)], "Engraving effect."),

  // ── DISTORT ──────────────────────────────────────────────────────────────
  filter(
    "twirl",
    "twirl",
    [P.float("angle_degrees", 90), P.int("center_x", -1), P.int("center_y", -1)],
    "Spiral distortion.",
  ),
  filter(
    "pinch",
    "pinch",
    [P.float("amount", 50), P.int("center_x", -1), P.int("center_y", -1)],
    "Squeeze/bulge.",
  ),
  filter("spherize", "spherize", [P.float("amount", 100), P.int("mode", 0)], "Map onto sphere."),
  filter("ripple", "ripple", [P.int("amount", 100), P.int("size", 1)], "Water ripple."),
  filter(
    "zigzag",
    "zigzag",
    [P.int("amount", 10), P.int("ridges", 5), P.int("center_x", -1), P.int("center_y", -1)],
    "Concentric waves.",
  ),
  filter(
    "ocean_ripple",
    "ocean_ripple",
    [P.int("ripple_size", 5), P.int("ripple_magnitude", 7)],
    "Underwater ripple.",
  ),
  special(
    "displace",
    "void bridge_displace(uint8* pixels, int w, int h, int channels, uint8* disp_map, float h_scale, float v_scale, int wrap, uint8* out)",
    [P.float("h_scale", 10), P.float("v_scale", 10), P.bool("wrap", false)],
    "Displacement map warp (needs a map buffer).",
  ),
  filter("polar_to_rectangular", "polar_to_rectangular", [], "Polar → rectangular."),
  filter("rectangular_to_polar", "rectangular_to_polar", [], "Rectangular → polar."),

  // ── HEALING ──────────────────────────────────────────────────────────────
  special(
    "healing_brush",
    "void bridge_healing_brush(uint8* pixels, int w, int h, int channels, uint8* mask, int sample_x, int sample_y, uint8* out)",
    [P.int("sample_x", 0), P.int("sample_y", 0)],
    "Healing brush (needs a mask buffer).",
  ),
  filter(
    "spot_healing",
    "spot_healing_brush",
    [P.int("center_x", 0), P.int("center_y", 0), P.int("radius", 10)],
    "Auto-heal a spot.",
  ),
  special(
    "patch_tool",
    "void bridge_patch_tool(uint8* pixels, int w, int h, int channels, uint8* source_mask, int dest_x, int dest_y, int blend, uint8* out)",
    [P.int("dest_x", 0), P.int("dest_y", 0), P.bool("blend", true)],
    "Patch tool (needs a source mask buffer).",
  ),

  // ── NEURAL / AI ──────────────────────────────────────────────────────────
  //
  // TWO FAMILIES, AND THE DIFFERENCE IS NOT COSMETIC (traced in
  // `omni_image_processing/src/omni_image_bridge.cpp`):
  //
  //   * `bridge_neural_smooth_skin` / `_depth_blur` / `_colorize` /
  //     `_remove_compression_artifacts` / `_generate_depth_map` validate their
  //     arguments, wrap the work in `try/catch`, sentinel-fill the output and
  //     return a `BridgeOpStatus` int. They are bound with their real `int`
  //     return below so the dispatcher can report the failure honestly.
  //
  //   * `bridge_remove_background` / `bridge_get_foreground_mask` /
  //     `bridge_blur_background` are `extern "C" void` with NO try/catch. Any
  //     throw from the segment path (missing/corrupt model, ONNX session-create
  //     failure, `std::bad_alloc` from the CPU arena, inference failure) crosses
  //     the C ABI into koffi's frame, where there is no handler, so
  //     `std::terminate` -> `__fastfail` KILLS THE PROCESS with
  //     STATUS_STACK_BUFFER_OVERRUN (0xC0000409 / exit -1073740791).
  //     Reproduced deterministically by pointing `OMNI_SEG_MODEL` at a file that
  //     is not an ONNX graph: `remove_background` never returned and the process
  //     died with -1073740791, while the same trick on `OMNI_COLORIZE_MODEL`
  //     returned through the guarded export. There is nothing TypeScript can
  //     catch here and no session-release/reset export to fall back to (the DLL
  //     exports 156 symbols; none of them frees a session). The real fix belongs
  //     in the C++ front door; until then these three ops are the reason the
  //     extension test lane serializes its native files instead of building an
  //     ONNX session while five other test files hold their peak footprint.
  guardedNeuralFilter(
    "neural_smooth_skin",
    "neural_smooth_skin",
    [P.float("amount", 50), P.bool("preserve_texture", true)],
    "AI skin smoothing.",
  ),
  guardedNeuralFilter(
    "neural_depth_blur",
    "neural_depth_blur",
    [P.float("amount", 10), P.float("focal_distance", 0.5)],
    "AI depth/bokeh blur.",
  ),
  guardedNeuralFilter(
    "neural_colorize",
    "neural_colorize",
    [P.float("strength", 1)],
    "AI colorize B&W.",
  ),
  filter("neural_smart_denoise", "neural_smart_denoise", [P.float("strength", 0.5)], "AI denoise."),
  filter("neural_smart_sharpen", "neural_smart_sharpen", [P.float("amount", 1)], "AI sharpen."),
  guardedNeuralFilter(
    "neural_remove_compression_artifacts",
    "neural_remove_compression_artifacts",
    [],
    "Remove JPEG artifacts.",
  ),
  guardedNeuralFilter(
    "neural_generate_depth_map",
    "neural_generate_depth_map",
    [],
    "Generate a depth map.",
  ),
  filter("remove_background", "remove_background", [], "U2Net background removal (RGBA out)."),
  // Real U2Net; returns int status. Single-channel w*h mask out.
  {
    name: "segment_foreground",
    signature:
      "int bridge_segment_foreground(uint8* pixels, int w, int h, int channels, uint8* out)",
    params: [],
    kind: "mask",
    chainable: false,
    description: "Real U2Net foreground mask (int status).",
    status: "bridgeOpStatus",
  },
  filter("get_foreground_mask", "get_foreground_mask", [], "Foreground/subject mask."),
  filter(
    "blur_background",
    "blur_background",
    [P.float("amount", 10)],
    "Blur background, keep subject sharp.",
  ),
  filter(
    "restore_photo",
    "restore_photo",
    [
      P.bool("remove_scratches", true),
      P.bool("reduce_noise", true),
      P.bool("enhance_colors", true),
    ],
    "AI photo restoration.",
  ),
  filter("ai_deblur", "ai_deblur", [P.float("strength", 0.5)], "AI deblur."),
  filter("ai_denoise", "ai_denoise", [P.float("strength", 0.5)], "Deep-learning denoise."),

  // ── RENDER GENERATORS ────────────────────────────────────────────────────
  generator(
    "render_clouds",
    "render_clouds",
    [
      P.u8("fg_r", 255),
      P.u8("fg_g", 255),
      P.u8("fg_b", 255),
      P.u8("bg_r", 0),
      P.u8("bg_g", 0),
      P.u8("bg_b", 0),
    ],
    "Generate cloud pattern (RGBA).",
  ),
  filter(
    "render_difference_clouds",
    "render_difference_clouds",
    [
      P.u8("fg_r", 255),
      P.u8("fg_g", 255),
      P.u8("fg_b", 255),
      P.u8("bg_r", 0),
      P.u8("bg_g", 0),
      P.u8("bg_b", 0),
    ],
    "Difference clouds blended with the image.",
    false,
  ),
  {
    name: "render_fibers",
    signature:
      "void bridge_render_fibers(int w, int h, float variance, float strength, uint8 c1r, uint8 c1g, uint8 c1b, uint8 c2r, uint8 c2g, uint8 c2b, uint8* out)",
    params: [
      P.float("variance", 16),
      P.float("strength", 4),
      P.u8("c1r", 128),
      P.u8("c1g", 100),
      P.u8("c1b", 50),
      P.u8("c2r", 200),
      P.u8("c2g", 180),
      P.u8("c2b", 120),
    ],
    kind: "generator",
    chainable: false,
    description: "Generate fiber texture (RGBA).",
  },
  filter(
    "add_lens_flare",
    "add_lens_flare",
    [P.int("center_x", 0), P.int("center_y", 0), P.int("brightness", 100), P.int("lens_type", 0)],
    "Add lens flare.",
  ),
  filter(
    "add_picture_frame",
    "add_picture_frame",
    [P.int("style", 0), P.int("size_pixels", 50)],
    "Add a decorative frame.",
  ),

  // ── AUTO CORRECT ─────────────────────────────────────────────────────────
  filter("auto_levels", "auto_levels", [P.float("clip_percent", 0.1)], "Auto levels."),
  filter("auto_contrast", "auto_contrast", [], "Auto contrast."),
  filter("auto_color", "auto_color", [], "Auto color."),
  filter(
    "channel_mixer",
    "channel_mixer",
    [
      P.float("rr", 1),
      P.float("rg", 0),
      P.float("rb", 0),
      P.float("gr", 0),
      P.float("gg", 1),
      P.float("gb", 0),
      P.float("br", 0),
      P.float("bg", 0),
      P.float("bb", 1),
    ],
    "3x3 channel mixer matrix.",
  ),
  filter(
    "white_balance",
    "white_balance",
    [P.float("temperature", 6500), P.float("tint", 0)],
    "White balance.",
  ),
  filter(
    "shadow_highlight",
    "shadow_highlight",
    [P.float("shadow_amount", 50), P.float("highlight_amount", 0), P.int("radius", 30)],
    "Shadow/highlight recovery.",
  ),

  // ── ADVANCED ADJUSTMENTS ─────────────────────────────────────────────────
  filter("equalize_image", "equalize_image", [], "Equalize histogram."),
  filter("equalize_per_channel", "equalize_per_channel", [], "Equalize per channel."),
  filter("auto_tone", "auto_tone", [], "Auto tone."),

  // ── NOISE REDUCTION ──────────────────────────────────────────────────────
  filter(
    "surface_blur",
    "surface_blur",
    [P.int("radius", 5), P.int("threshold", 15)],
    "Edge-preserving surface blur.",
  ),
  filter("despeckle", "despeckle", [P.int("strength", 1)], "Remove speckle noise."),
  filter(
    "dust_and_scratches",
    "dust_and_scratches",
    [P.int("radius", 2), P.int("threshold", 20)],
    "Remove dust and scratches.",
  ),
  filter(
    "reduce_noise",
    "reduce_noise",
    [P.int("strength", 6), P.int("preserve_details", 50), P.int("sharpen_details", 25)],
    "Advanced noise reduction.",
  ),

  // ── ARTISTIC (~30) ───────────────────────────────────────────────────────
  filter(
    "conte_crayon",
    "conte_crayon",
    [
      P.int("foreground_level", 5),
      P.int("background_level", 9),
      P.int("texture", 1),
      P.float("scaling", 100),
      P.float("relief", 4),
    ],
    "Conte crayon.",
  ),
  filter(
    "reticulation",
    "reticulation",
    [P.int("density", 40), P.int("foreground_level", 0), P.int("background_level", 40)],
    "Film reticulation.",
  ),
  filter(
    "stamp",
    "stamp",
    [P.int("light_dark_balance", 25), P.int("smoothness", 5)],
    "Rubber stamp.",
  ),
  filter(
    "torn_edges",
    "torn_edges",
    [P.int("image_balance", 25), P.int("smoothness", 11), P.int("contrast", 17)],
    "Torn paper edges.",
  ),
  filter(
    "water_paper",
    "water_paper",
    [P.int("fiber_length", 5), P.int("brightness", 60), P.int("contrast", 80)],
    "Wet paper texture.",
  ),
  filter(
    "cutout",
    "cutout",
    [P.int("levels", 4), P.float("edge_simplicity", 4), P.float("edge_fidelity", 2)],
    "Poster cutout.",
  ),
  filter(
    "dry_brush",
    "dry_brush",
    [P.int("brush_size", 2), P.int("brush_detail", 8), P.int("texture", 1)],
    "Dry brush.",
  ),
  filter(
    "film_grain",
    "film_grain",
    [P.int("grain", 4), P.float("highlight_area", 0), P.float("intensity", 10)],
    "Film grain.",
  ),
  filter(
    "fresco",
    "fresco",
    [P.int("brush_size", 2), P.int("brush_detail", 8), P.int("texture", 1)],
    "Fresco.",
  ),
  filter(
    "neon_glow_filter",
    "neon_glow",
    [P.int("glow_size", 5), P.int("glow_brightness", 15)],
    "Neon glow artistic.",
  ),
  filter(
    "paint_daubs",
    "paint_daubs",
    [P.int("brush_type", 0), P.int("brush_size", 4)],
    "Paint daubs.",
  ),
  filter(
    "palette_knife",
    "palette_knife",
    [P.int("stroke_size", 10), P.int("stroke_detail", 3), P.int("softness", 5)],
    "Palette knife.",
  ),
  filter(
    "plastic_wrap",
    "plastic_wrap",
    [P.int("highlight_strength", 15), P.int("detail", 9), P.int("smoothness", 7)],
    "Plastic wrap.",
  ),
  filter(
    "poster_edges",
    "poster_edges",
    [P.int("edge_thickness", 2), P.int("edge_intensity", 1), P.int("posterization", 2)],
    "Poster edges.",
  ),
  filter(
    "rough_pastels",
    "rough_pastels",
    [
      P.int("stroke_length", 6),
      P.int("stroke_detail", 4),
      P.int("texture", 1),
      P.float("scaling", 100),
      P.float("relief", 4),
    ],
    "Rough pastels.",
  ),
  filter(
    "smudge_stick",
    "smudge_stick",
    [P.int("stroke_length", 2), P.int("highlight_area", 12), P.int("intensity", 10)],
    "Smudge stick.",
  ),
  filter(
    "sponge_filter",
    "sponge",
    [P.int("brush_size", 2), P.int("definition", 12), P.int("smoothness", 5)],
    "Sponge texture.",
  ),
  filter(
    "underpainting",
    "underpainting",
    [P.int("stroke_length", 8), P.int("texture_coverage", 1)],
    "Underpainting.",
  ),
  filter(
    "watercolor",
    "watercolor",
    [P.int("brush_detail", 8), P.int("shadow_intensity", 0), P.int("texture", 1)],
    "Watercolor.",
  ),
  filter(
    "colored_pencil",
    "colored_pencil",
    [P.int("pencil_width", 4), P.int("stroke_pressure", 8), P.int("paper_brightness", 25)],
    "Colored pencil.",
  ),
  filter(
    "charcoal",
    "charcoal",
    [P.int("charcoal_thickness", 1), P.int("detail", 5), P.int("light_dark_balance", 50)],
    "Charcoal.",
  ),
  filter("chrome", "chrome", [P.int("detail", 4), P.int("smoothness", 7)], "Chrome metallic."),
  filter(
    "graphic_pen",
    "graphic_pen",
    [P.int("stroke_length", 15), P.int("light_dark_balance", 50), P.int("stroke_direction", 0)],
    "Graphic pen sketch.",
  ),
  filter(
    "halftone_pattern",
    "halftone_pattern",
    [P.int("size", 5), P.int("contrast", 5)],
    "Halftone dots.",
  ),
  filter(
    "note_paper",
    "note_paper",
    [P.int("image_balance", 25), P.int("graininess", 10), P.int("relief", 11)],
    "Note paper texture.",
  ),
  filter("photocopy", "photocopy", [P.int("detail", 7), P.int("darkness", 8)], "Photocopy effect."),
  filter(
    "plaster",
    "plaster",
    [P.int("image_balance", 20), P.int("smoothness", 2), P.int("light", 0)],
    "Plaster relief.",
  ),

  // ── LAYER EFFECTS (inline RGB params, single input) ──────────────────────
  filter(
    "inner_glow",
    "inner_glow",
    [P.u8("r", 255), P.u8("g", 200), P.u8("b", 0), P.int("size", 10), P.float("opacity", 0.75)],
    "Inner glow.",
  ),
  filter(
    "outer_glow",
    "outer_glow",
    [P.u8("r", 255), P.u8("g", 200), P.u8("b", 0), P.int("size", 10), P.float("opacity", 0.75)],
    "Outer glow.",
  ),
  filter(
    "bevel_emboss",
    "bevel_emboss",
    [P.int("depth", 3), P.int("size", 5), P.float("angle", 120), P.float("altitude", 30)],
    "Bevel & emboss.",
  ),
  filter(
    "stroke_effect",
    "stroke_effect",
    [P.u8("r", 0), P.u8("g", 0), P.u8("b", 0), P.int("size", 3), P.int("position", 0)],
    "Stroke border.",
  ),
  filter(
    "color_overlay",
    "color_overlay",
    [P.u8("r", 255), P.u8("g", 0), P.u8("b", 0), P.float("opacity", 0.5), P.int("blend_mode", 0)],
    "Color overlay.",
  ),

  // ── LAYER MASK / COMPOSITE / BLEND / COMPOSITOR (multi-buffer) ────────────
  special(
    "apply_layer_mask",
    "void bridge_apply_layer_mask(uint8* pixels, int w, int h, int channels, uint8* mask, int mask_channels, uint8* out)",
    [P.int("mask_channels", 1)],
    "Apply a layer mask (needs mask buffer).",
  ),
  special(
    "composite_layer",
    "void bridge_composite_layer(uint8* dest, int w, int h, int channels, uint8* src, float opacity, uint8* out)",
    [P.float("opacity", 1)],
    "Composite src over dest (needs 2 buffers).",
  ),
  special(
    "blend_normal",
    "void bridge_blend_normal(uint8* base, uint8* blend, int w, int h, int channels, float opacity, uint8* out)",
    [P.float("opacity", 1)],
    "Normal blend (2 buffers).",
  ),
  special(
    "blend_multiply",
    "void bridge_blend_multiply(uint8* base, uint8* blend, int w, int h, int channels, float opacity, uint8* out)",
    [P.float("opacity", 1)],
    "Multiply blend (2 buffers).",
  ),
  special(
    "blend_screen",
    "void bridge_blend_screen(uint8* base, uint8* blend, int w, int h, int channels, float opacity, uint8* out)",
    [P.float("opacity", 1)],
    "Screen blend (2 buffers).",
  ),
  special(
    "blend_overlay",
    "void bridge_blend_overlay(uint8* base, uint8* blend, int w, int h, int channels, float opacity, uint8* out)",
    [P.float("opacity", 1)],
    "Overlay blend (2 buffers).",
  ),
  special(
    "blend_add",
    "void bridge_blend_add(uint8* base, uint8* blend, int w, int h, int channels, float opacity, uint8* out)",
    [P.float("opacity", 1)],
    "Add blend (2 buffers).",
  ),
  special(
    "blend_subtract",
    "void bridge_blend_subtract(uint8* base, uint8* blend, int w, int h, int channels, float opacity, uint8* out)",
    [P.float("opacity", 1)],
    "Subtract blend (2 buffers).",
  ),
  special(
    "blend_darken",
    "void bridge_blend_darken(uint8* base, uint8* blend, int w, int h, int channels, float opacity, uint8* out)",
    [P.float("opacity", 1)],
    "Darken blend (2 buffers).",
  ),
  special(
    "blend_lighten",
    "void bridge_blend_lighten(uint8* base, uint8* blend, int w, int h, int channels, float opacity, uint8* out)",
    [P.float("opacity", 1)],
    "Lighten blend (2 buffers).",
  ),
  special(
    "composite",
    "void bridge_composite(uint8* dst, int dst_w, int dst_h, int channels, uint8* src, int src_w, int src_h, int x, int y, uint8* out)",
    [P.int("x", 0), P.int("y", 0)],
    "Alpha-composite src over dst (2 buffers).",
  ),

  // ── RETOUCH (single input, scalar params) ────────────────────────────────
  filter(
    "clone_stamp",
    "clone_stamp",
    [
      P.int("x", 0),
      P.int("y", 0),
      P.int("source_x", 0),
      P.int("source_y", 0),
      P.int("radius", 10),
      P.float("hardness", 0.8),
      P.float("opacity", 1),
    ],
    "Clone stamp.",
  ),
  filter(
    "smudge_tool",
    "smudge",
    [
      P.int("x", 0),
      P.int("y", 0),
      P.int("prev_x", 0),
      P.int("prev_y", 0),
      P.int("radius", 10),
      P.float("hardness", 0.5),
      P.float("strength", 0.5),
    ],
    "Smudge tool.",
  ),

  // ── LIQUIFY (mesh array) ─────────────────────────────────────────────────
  special(
    "liquify",
    "void bridge_liquify(uint8* pixels, int w, int h, int channels, float* mesh, int mesh_w, int mesh_h, uint8* out)",
    [],
    "Liquify warp (needs a mesh array).",
  ),

  // ── LENS CORRECTION ──────────────────────────────────────────────────────
  filter(
    "lens_correction",
    "lens_correction",
    [
      P.float("distortion_amount", 0),
      P.float("ca_red", 0),
      P.float("ca_blue", 0),
      P.float("vignette_amount", 0),
      P.float("vignette_midpoint", 50),
    ],
    "Full lens correction.",
  ),
  filter(
    "lens_distortion_only",
    "lens_distortion_only",
    [P.float("distortion_amount", 0)],
    "Barrel/pincushion correction.",
  ),
  filter(
    "chromatic_aberration_correction",
    "chromatic_aberration_correction",
    [P.float("ca_red", 0), P.float("ca_blue", 0)],
    "Chromatic aberration correction.",
  ),
  filter(
    "vignette_correction",
    "vignette_correction",
    [P.float("vignette_amount", 0), P.float("vignette_midpoint", 50)],
    "Vignette correction.",
  ),

  // ── CROP & STRAIGHTEN ────────────────────────────────────────────────────
  resizing(
    "crop",
    "crop",
    [P.int("crop_x", 0), P.int("crop_y", 0), P.int("crop_width", 0), P.int("crop_height", 0)],
    "Crop to a rectangle.",
  ),
  filter(
    "straighten",
    "straighten",
    [P.float("angle", 0), P.bool("expand_canvas", false)],
    "Straighten by rotating.",
  ),
];

/** Ops whose C++ path is currently known broken. Empty today (parity with source). */
export const KNOWN_BROKEN = new Set<string>();

/**
 * Ops that emit a CONTIGUOUS single-channel `w*h` buffer, not `w*h*channels`.
 *
 * `get_foreground_mask` and `neural_generate_depth_map` belong here even though
 * their bindings are declared as `filter`s: the C++ exports document and write
 * exactly `w*h` bytes (`bridge_get_foreground_mask` returns a 1-channel Image
 * through `copy_out`, and `bridge_neural_generate_depth_map` documents "out:
 * exactly w*h bytes (single-channel depth map)"). Treating them as ordinary
 * filters allocated `w*h*4` and encoded the result as RGBA, so C++ filled only
 * the first quarter of the buffer and the op reported `ok: true` while writing a
 * garbage image with data in the top ~1/4 of the rows and zeros below. Measured
 * on a 64x64 input before this fix: 16/64 rows carried any non-zero RGB for the
 * depth map and 12/64 for the mask.
 */
export const MASK_FILTERS = new Set<string>([
  "magic_wand",
  "quick_select",
  "select_color_range",
  "segment_foreground",
  "get_foreground_mask",
  "neural_generate_depth_map",
]);

/** Filters whose output dimensions differ from the input. */
export const RESIZING_FILTERS = new Set<string>(["scale", "crop", "seam_carving"]);

/** Transforms that swap width/height without changing the pixel count. */
export const DIMENSION_SWAP = new Set<string>(["rotate_90", "rotate_270"]);

/** Ops that are not image→image filters (analysis, generators, multi-buffer). */
export const NON_FILTER = new Set<string>(
  ops
    .filter((o) => o.kind === "analysis" || o.kind === "generator" || o.kind === "special")
    .map((o) => o.name),
);

// ── ONNX-backed ops ─────────────────────────────────────────────────────────
//
// DERIVED FROM THE C++ SOURCE, NOT FROM THE OP NAMES. The names lie in both
// directions: several `neural_*` / `ai_*` ops are plain CPU loops, and
// `remove_background` / `blur_background` (no "neural" in the name) do run a
// learned model. Each entry below was traced from the `bridge_*` export in
// `omni_image_processing/src/omni_image_bridge.cpp` through
// `src/ai/neural_filters.cpp` to an `OnnxModelHost` model id:
//
//   remove_background                    -> BackgroundRemoval::get_foreground_mask -> OnnxSegmenter        -> "segment"
//   get_foreground_mask                  -> BackgroundRemoval::get_foreground_mask -> OnnxSegmenter        -> "segment"
//   blur_background                      -> BackgroundRemoval::get_foreground_mask -> OnnxSegmenter        -> "segment"
//   segment_foreground                   -> OnnxSegmenter                                                 -> "segment"
//   neural_generate_depth_map            -> NeuralFilters::generate_depth_map      -> DepthAdapter         -> "depth"
//   neural_depth_blur                    -> NeuralFilters::depth_blur              -> DepthAdapter         -> "depth"
//   neural_colorize                      -> NeuralFilters::colorize                -> ColorizeAdapter      -> "colorize"
//   neural_remove_compression_artifacts  -> NeuralFilters::remove_compression_artifacts -> RestorationAdapter -> "restore"
//   neural_smooth_skin                   -> NeuralFilters::smooth_skin             -> FaceAdapter          -> "face"
//
// NOT in this map, verified CPU-only in `neural_filters.cpp` despite their
// names — they must NOT be gated and must NOT take a GPU claim:
//   neural_smart_denoise  (bilateral loop)      neural_smart_sharpen (unsharp kernel)
//   restore_photo         (median + smart_denoise + auto-levels)
//   ai_deblur             (sharpening kernel)   ai_denoise (-> smart_denoise)
//
// The model file names and env-var overrides mirror the `ModelSpec` table in
// `omni_image_processing/src/ai/onnx_model_host.cpp`, which resolves each model
// as `<env var>` when set and non-empty, else `models/<file>` relative to the
// LOADED MODULE's own directory (not the CWD).
export const ONNX_OPS: ReadonlyMap<string, OnnxOpSpec> = new Map<string, OnnxOpSpec>([
  [
    "remove_background",
    { modelId: "segment", modelFile: "u2net.onnx", modelEnvVar: "OMNI_SEG_MODEL" },
  ],
  [
    "get_foreground_mask",
    { modelId: "segment", modelFile: "u2net.onnx", modelEnvVar: "OMNI_SEG_MODEL" },
  ],
  [
    "blur_background",
    { modelId: "segment", modelFile: "u2net.onnx", modelEnvVar: "OMNI_SEG_MODEL" },
  ],
  [
    "segment_foreground",
    { modelId: "segment", modelFile: "u2net.onnx", modelEnvVar: "OMNI_SEG_MODEL" },
  ],
  [
    "neural_generate_depth_map",
    {
      modelId: "depth",
      modelFile: "depth_anything_v2_small.onnx",
      modelEnvVar: "OMNI_DEPTH_MODEL",
    },
  ],
  [
    "neural_depth_blur",
    {
      modelId: "depth",
      modelFile: "depth_anything_v2_small.onnx",
      modelEnvVar: "OMNI_DEPTH_MODEL",
    },
  ],
  [
    "neural_colorize",
    { modelId: "colorize", modelFile: "colorization.onnx", modelEnvVar: "OMNI_COLORIZE_MODEL" },
  ],
  [
    "neural_remove_compression_artifacts",
    { modelId: "restore", modelFile: "fbcnn.onnx", modelEnvVar: "OMNI_RESTORE_MODEL" },
  ],
  [
    "neural_smooth_skin",
    { modelId: "face", modelFile: "face_parsing.onnx", modelEnvVar: "OMNI_FACE_MODEL" },
  ],
]);

export const imageBindings: EngineBindingModule = {
  engine: "image",
  libraryStem: "omni_image_bridge",
  ops,
  knownBroken: KNOWN_BROKEN,
  onnxOps: ONNX_OPS,
};
