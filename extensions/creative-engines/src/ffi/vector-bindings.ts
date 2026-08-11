/**
 * Vector engine koffi bindings (`omni_vector_bridge` / `libomni_vector_bridge`).
 *
 * Contract: float32 point arrays `[x0,y0,x1,y1,...]`. Many ops write into an
 * output array and report the produced count through an `int* out_count`
 * (byref) — these are `special` because the file apply path (SVG in → SVG out)
 * needs bespoke marshalling.
 *
 * SVG dispatch (ported from the reference):
 *   - AFFINE_OPS   : single-path affine transforms (transform_2d /
 *                    vector_transform_points) — the main SVG-in → SVG-out path.
 *   - BOOLEAN_OPS  : two-path union/subtract/intersect.
 *   - RASTER_ONLY  : ops that rasterize to a mask/RGBA image (fill_scanline,
 *                    rasterize_polygon/stroke, gradient_linear).
 *   - KNOWN_BROKEN : empty today (parity with source).
 *
 * Scalar-return geometry helpers (distances, areas, bezier eval) are `analysis`.
 */

import { P, type EngineBindingModule, type FfiParam, type OpBinding } from "./binding-types.js";

/** Point-array op with a byref out-count — needs bespoke marshalling. */
function pathOp(name: string, signature: string, params: FfiParam[], description: string): OpBinding {
  return { name, signature, params, kind: "special", chainable: false, description };
}

/** Scalar-return geometry helper (returns data, not media). */
function analysis(name: string, signature: string, params: FfiParam[], description: string): OpBinding {
  return { name, signature, params, kind: "analysis", chainable: false, description };
}

/** Rasterizer: writes a mask/RGBA image buffer (file output). */
function raster(name: string, signature: string, params: FfiParam[], description: string): OpBinding {
  return { name, signature, params, kind: "generator", chainable: false, description };
}

const ops: OpBinding[] = [
  // ── BOOLEAN PATH OPS (two paths) ─────────────────────────────────────────
  pathOp("path_union", "void bridge_path_union(float* path_a, int count_a, float* path_b, int count_b, float* out, int* out_count)", [], "Boolean union of two paths."),
  pathOp("path_subtract", "void bridge_path_subtract(float* path_a, int count_a, float* path_b, int count_b, float* out, int* out_count)", [], "Boolean subtract."),
  pathOp("path_intersect", "void bridge_path_intersect(float* path_a, int count_a, float* path_b, int count_b, float* out, int* out_count)", [], "Boolean intersect."),

  // ── AFFINE / SINGLE-PATH TRANSFORMS ──────────────────────────────────────
  pathOp("transform_2d", "void bridge_transform_2d(float* points, int count, float a, float b, float c, float d, float tx, float ty, float* out)", [P.float("a", 1.0), P.float("b", 0.0), P.float("c", 0.0), P.float("d", 1.0), P.float("tx", 0.0), P.float("ty", 0.0)], "Affine transform of a point array."),
  pathOp("vector_transform_points", "void bridge_vector_transform_points(float* points, int count, float a, float b, float c, float d, float tx, float ty, float* out)", [P.float("a", 1.0), P.float("b", 0.0), P.float("c", 0.0), P.float("d", 1.0), P.float("tx", 0.0), P.float("ty", 0.0)], "Affine transform (new API)."),
  pathOp("path_offset", "void bridge_path_offset(float* points, int count, float offset, float* out)", [P.float("offset", 1.0)], "Offset/inset a path."),
  pathOp("path_simplify", "void bridge_path_simplify(float* points, int count, float tolerance, float* out, int* out_count)", [P.float("tolerance", 1.0)], "Simplify a path."),
  pathOp("path_smooth", "void bridge_path_smooth(float* points, int count, float factor, float* out)", [P.float("factor", 0.25)], "Smooth a path."),
  pathOp("stroke_dash", "void bridge_stroke_dash(float* points, int count, float dash_len, float gap_len, float* out, int* out_count)", [P.float("dash_len", 5.0), P.float("gap_len", 5.0)], "Dash a stroked path."),
  pathOp("vector_stroke_expand", "void bridge_vector_stroke_expand(float* points, int count, float width, int cap, int join, float* out, int max_out, int* out_count)", [P.float("width", 2.0), P.int("cap", 0), P.int("join", 0)], "Expand a stroke to an outline."),
  pathOp("vector_stroke_dash", "void bridge_vector_stroke_dash(float* points, int count, float dash, float gap, float offset, float* out, int max_out, int* out_count)", [P.float("dash", 5.0), P.float("gap", 5.0), P.float("offset", 0.0)], "Dash a stroke (new API)."),
  pathOp("vector_path_resample", "void bridge_vector_path_resample(float* points, int count, float spacing, float* out, int max_out, int* out_count)", [P.float("spacing", 5.0)], "Resample a path at fixed spacing."),
  pathOp("vector_path_rdp_simplify", "void bridge_vector_path_rdp_simplify(float* points, int count, float tolerance, float* out, int* out_count)", [P.float("tolerance", 1.0)], "RDP simplification."),
  pathOp("vector_path_chaikin_smooth", "void bridge_vector_path_chaikin_smooth(float* points, int count, int iterations, float* out, int* out_count)", [P.int("iterations", 2)], "Chaikin smoothing."),
  pathOp("vector_polygon_convex_hull", "void bridge_vector_polygon_convex_hull(float* points, int count, float* hull, int* hull_count)", [], "Convex hull of a point set."),
  pathOp("svg_path_to_points", "void bridge_svg_path_to_points(const char* svg_d, float* out, int max_points, int* out_count)", [P.str("svg_d", ""), P.int("max_points", 4096)], "Flatten an SVG path 'd' to points."),
  pathOp("vector_svg_path_parse", "void bridge_vector_svg_path_parse(const char* svg_d, float* out, int max_pts, int* out_count)", [P.str("svg_d", ""), P.int("max_pts", 4096)], "Parse an SVG path 'd' (new API)."),

  // ── RASTERIZERS (file image output) ──────────────────────────────────────
  raster("fill_scanline", "void bridge_fill_scanline(float* polygon, int count, int w, int h, uint8* mask)", [P.int("w", 0), P.int("h", 0)], "Scanline-fill a polygon to a mask."),
  raster("vector_rasterize_polygon", "void bridge_vector_rasterize_polygon(float* points, int count, int w, int h, uint8* mask)", [P.int("w", 0), P.int("h", 0)], "Rasterize a polygon to a mask."),
  raster("vector_rasterize_stroke", "void bridge_vector_rasterize_stroke(float* points, int count, float width, int w, int h, uint8* mask)", [P.float("width", 2.0), P.int("w", 0), P.int("h", 0)], "Rasterize a stroke to a mask."),
  raster("gradient_linear", "void bridge_gradient_linear(uint8* pixels, int w, int h, int channels, uint8 r0, uint8 g0, uint8 b0, uint8 r1, uint8 g1, uint8 b1, float angle_deg)", [P.int("w", 0), P.int("h", 0), P.u8("r0", 0), P.u8("g0", 0), P.u8("b0", 0), P.u8("r1", 255), P.u8("g1", 255), P.u8("b1", 255), P.float("angle_deg", 0.0)], "Render a linear gradient (RGB)."),
  pathOp("pattern_grid", "void bridge_pattern_grid(float x0, float y0, float w, float h, int cols, int rows, float* out)", [P.float("x0", 0.0), P.float("y0", 0.0), P.float("w", 100.0), P.float("h", 100.0), P.int("cols", 4), P.int("rows", 4)], "Generate a grid of points."),

  // ── SCALAR GEOMETRY HELPERS (analysis) ───────────────────────────────────
  analysis("bezier_eval", "void bridge_bezier_eval(float x0, float y0, float cx1, float cy1, float cx2, float cy2, float x1, float y1, float t, float* out_x, float* out_y)", [P.float("t", 0.5)], "Evaluate a cubic bezier at t."),
  analysis("bezier_length", "void bridge_bezier_length(float x0, float y0, float cx1, float cy1, float cx2, float cy2, float x1, float y1, int segments, float* out)", [P.int("segments", 32)], "Cubic bezier arc length."),
  analysis("vector_point_distance", "void bridge_vector_point_distance(float ax, float ay, float bx, float by, float* out)", [P.float("ax", 0), P.float("ay", 0), P.float("bx", 0), P.float("by", 0)], "Distance between two points."),
  analysis("vector_point_dot", "void bridge_vector_point_dot(float ax, float ay, float bx, float by, float* out)", [P.float("ax", 0), P.float("ay", 0), P.float("bx", 0), P.float("by", 0)], "Dot product."),
  analysis("vector_point_cross", "void bridge_vector_point_cross(float ax, float ay, float bx, float by, float* out)", [P.float("ax", 0), P.float("ay", 0), P.float("bx", 0), P.float("by", 0)], "Cross product (z)."),
  analysis("vector_rect_contains", "void bridge_vector_rect_contains(float rx, float ry, float rw, float rh, float px, float py, int* out)", [P.float("rx", 0), P.float("ry", 0), P.float("rw", 0), P.float("rh", 0), P.float("px", 0), P.float("py", 0)], "Point-in-rect test."),
  analysis("vector_polygon_area", "void bridge_vector_polygon_area(float* points, int count, float* out)", [], "Polygon area."),
  analysis("vector_polygon_centroid", "void bridge_vector_polygon_centroid(float* points, int count, float* cx, float* cy)", [], "Polygon centroid."),
  analysis("vector_polygon_contains_point", "void bridge_vector_polygon_contains_point(float* points, int count, float px, float py, int* out)", [P.float("px", 0), P.float("py", 0)], "Point-in-polygon test."),
  analysis("vector_polygon_is_convex", "void bridge_vector_polygon_is_convex(float* points, int count, int* out)", [], "Convexity test."),
  analysis("vector_path_bbox", "void bridge_vector_path_bbox(float* points, int count, float* min_x, float* min_y, float* max_x, float* max_y)", [], "Path bounding box."),
  analysis("vector_path_length", "void bridge_vector_path_length(float* points, int count, float* out)", [], "Polyline length."),
];

export const KNOWN_BROKEN = new Set<string>();

/** Single-path affine transform ops (SVG-in → SVG-out). */
export const AFFINE_OPS = new Set<string>(["transform_2d", "vector_transform_points"]);

/** Two-path boolean ops. */
export const BOOLEAN_OPS = new Set<string>(["path_union", "path_subtract", "path_intersect"]);

/** Ops that rasterize to an image/mask file. */
export const RASTER_ONLY = new Set<string>(["fill_scanline", "vector_rasterize_polygon", "vector_rasterize_stroke", "gradient_linear"]);

export const vectorBindings: EngineBindingModule = {
  engine: "vector",
  libraryStem: "omni_vector_bridge",
  ops,
  knownBroken: KNOWN_BROKEN,
};
