import { randomUUID } from "node:crypto";
import type { CreativeGraph } from "@openclaw/creative-contracts";
import { getCreativeCapability } from "./capabilities.js";
import { prepareStudioGraph, type StudioFileType } from "./studio-graph.js";

type Step = [capability: string, parameters?: Record<string, unknown>];
export type StudioRecipe = {
  id: string;
  name: string;
  category: string;
  description: string;
  sourceType: StudioFileType;
  steps: Step[];
  note?: string;
};
const trim: Step = ["video.cut_clip", { start_sec: 0, end_sec: 0, stream_copy: false }];
const grade = (params: Record<string, unknown>): Step => ["vfx.video_color_grade", params];
const recipe = (
  id: string,
  name: string,
  category: string,
  description: string,
  steps: Step[],
  sourceType: StudioFileType = "video",
  note?: string,
): StudioRecipe => ({
  id,
  name,
  category,
  description,
  sourceType,
  steps,
  ...(note ? { note } : {}),
});

/** Curated starting points over the existing capability registry, not a second executor. */
export const STUDIO_RECIPES: StudioRecipe[] = [
  recipe(
    "clean-cut",
    "Clean cut",
    "Editing",
    "Trim a clip with editable start/end times and accurate re-encoding.",
    [trim],
  ),
  recipe(
    "cinematic",
    "Cinematic warm film",
    "Looks",
    "Warm grade, widescreen letterbox, subtle grain and vignette.",
    [
      trim,
      grade({ temperature: 0.12, contrast: 1.12, saturation: 0.9 }),
      ["video.letterbox", { aspect_ratio: 2.35 }],
      ["video.film_grain", { intensity: 0.025 }],
      ["video.vignette", { strength: 0.25 }],
    ],
  ),
  recipe(
    "mono",
    "Black & white drama",
    "Looks",
    "Native grayscale grade and contrast with soft vignette.",
    [trim, grade({ saturation: 0, contrast: 1.2 }), ["video.vignette", { strength: 0.3 }]],
  ),
  recipe(
    "warm",
    "Golden-hour warmth",
    "Looks",
    "Warm color temperature and gentle saturation lift.",
    [trim, grade({ temperature: 0.22, saturation: 1.15, exposure: 0.15 })],
  ),
  recipe(
    "cool",
    "Cool commercial",
    "Looks",
    "Cooler color grade, contrast and native sharpening.",
    [trim, grade({ temperature: -0.15, contrast: 1.12 }), ["video.sharpen", { strength: 0.35 }]],
  ),
  recipe("dream", "Dreamy motion", "Looks", "Directional motion blur and a soft vignette.", [
    trim,
    ["video.motion_blur", { angle_deg: 20, strength: 3 }],
    ["video.vignette", { strength: 0.2 }],
  ]),
  recipe(
    "retro",
    "Retro chromatic film",
    "Looks",
    "Chromatic fringing, repeatable film grain and vignette.",
    [
      trim,
      ["video.chromatic_aberration", { offset_px: 2 }],
      ["video.film_grain", { intensity: 0.06, seed: 42 }],
      ["video.vignette", { strength: 0.35 }],
    ],
  ),
  recipe(
    "aces",
    "ACES filmic tone map",
    "Looks",
    "Native ACES tone mapping with editable white point.",
    [trim, ["vfx.video_tonemap", { mode: 1, white_point: 1 }]],
  ),
  recipe(
    "reinhard",
    "Reinhard tone map",
    "Looks",
    "Alternative native tone mapping for a different highlight rolloff.",
    [trim, ["vfx.video_tonemap", { mode: 0, white_point: 1 }]],
  ),
  recipe("mirror", "Mirror / flip video", "Editing", "Trim and mirror a clip horizontally.", [
    trim,
    ["video.video_transform_flip_h"],
  ]),
  recipe(
    "upside-down",
    "Upside-down video",
    "Editing",
    "Vertical flip for a quick transformation demo.",
    [trim, ["video.video_transform_flip_v"]],
  ),
  recipe(
    "speed-up",
    "2× speed-up",
    "Editing",
    "Double playback speed while keeping audio duration synchronized.",
    [trim, ["video.speed_ramp", { factor: 2 }]],
  ),
  recipe(
    "slow-down",
    "Half-speed slow motion",
    "Editing",
    "Half-speed playback with matched audio tempo; no AI frame interpolation.",
    [trim, ["video.speed_ramp", { factor: 0.5 }]],
  ),
  recipe("sharpen", "Detail / sharpen", "Looks", "Adjust native per-frame sharpening strength.", [
    trim,
    ["video.sharpen", { strength: 0.45 }],
  ]),
  recipe(
    "tiktok",
    "TikTok / Shorts portrait",
    "Social",
    "Fit video inside a padded 1080×1920 canvas; does not stretch or auto-reframe.",
    [trim, ["video.export_for_platform", { platform: "tiktok" }]],
  ),
  recipe(
    "reels",
    "Instagram Reels portrait",
    "Social",
    "1080×1920 padded export with web-playable H.264/AAC.",
    [trim, ["video.export_for_platform", { platform: "instagram" }]],
  ),
  recipe(
    "youtube",
    "YouTube landscape",
    "Social",
    "Padded 1920×1080 landscape export with fast-start playback.",
    [trim, ["video.export_for_platform", { platform: "youtube" }]],
  ),
  recipe("twitter", "X / Twitter landscape", "Social", "Padded 1280×720 export.", [
    trim,
    ["video.export_for_platform", { platform: "twitter" }],
  ]),
  recipe(
    "linkedin",
    "LinkedIn landscape",
    "Social",
    "Padded 1920×1080 professional landscape export.",
    [trim, ["video.export_for_platform", { platform: "linkedin" }]],
  ),
  recipe(
    "thumbnail",
    "Extract thumbnail",
    "Thumbnails",
    "Pick a frame at an editable timestamp; the result is an image.",
    [["video.thumbnail", { time_sec: 0 }]],
  ),
  recipe(
    "graded-thumbnail",
    "Graded thumbnail",
    "Thumbnails",
    "Extract a frame, warm-grade it and resize to 1280×720.",
    [
      ["video.thumbnail", { time_sec: 0 }],
      ["vfx.image_color_grade", { saturation: 1.15, contrast: 1.1, temperature: 0.1 }],
      ["image.scale", { new_width: 1280, new_height: 720 }],
    ],
  ),
  recipe(
    "mono-thumbnail",
    "Monochrome thumbnail",
    "Thumbnails",
    "Extract a frame and apply native image grayscale.",
    [["video.thumbnail", { time_sec: 0 }], ["image.desaturate"]],
  ),
  recipe(
    "audio-extract",
    "Extract video soundtrack",
    "Audio",
    "Save the video's audio track as WAV.",
    [["video.extract_audio"]],
    "video",
    "Requires a source video with audio.",
  ),
  recipe(
    "audio-clean",
    "Soundtrack gate + limiter",
    "Audio",
    "Extract audio, gate quiet noise and limit peaks. Native audio processing is mono.",
    [
      ["video.extract_audio"],
      ["audio.noise_gate", { threshold_db: -40 }],
      ["audio.limiter", { ceiling_db: -1 }],
    ],
    "video",
    "Requires a source video with audio; this exports WAV, not a remuxed video.",
  ),
  recipe(
    "image-invert",
    "Image negative",
    "Images",
    "Invert source pixels through the C++ image engine.",
    [["image.invert"]],
    "image",
  ),
  recipe(
    "image-sepia",
    "Vintage image",
    "Images",
    "Native sepia tone followed by image resizing.",
    [["image.sepia"], ["image.scale", { new_width: 1280, new_height: 720 }]],
    "image",
  ),
  recipe(
    "image-mono",
    "Black & white image",
    "Images",
    "Native grayscale with preserved image alpha.",
    [["image.desaturate"]],
    "image",
  ),
  recipe(
    "image-grade",
    "Image color grade",
    "Images",
    "Editable native exposure, contrast, saturation, temperature and tint.",
    [["vfx.image_color_grade", { contrast: 1.1, saturation: 1.1 }]],
    "image",
  ),
];

export function buildStudioRecipe(id: string): CreativeGraph {
  const selected = STUDIO_RECIPES.find((entry) => entry.id === id);
  if (!selected) {
    throw new Error("Unknown workflow recipe");
  }
  const now = new Date().toISOString();
  const graph: CreativeGraph = {
    schemaVersion: 1,
    id: `workflow-${randomUUID()}`,
    projectId: "studio",
    name: selected.name,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    inputs: [{ name: "source", dataType: selected.sourceType, required: true }],
    outputs: [],
    nodes: [],
    edges: [],
    metadata: { recipeId: id },
  };
  let upstream = graph.id;
  let upstreamPort = "source";
  for (const [index, [capability, parameters]] of selected.steps.entries()) {
    const descriptor = getCreativeCapability(capability);
    if (!descriptor) {
      throw new Error(`Recipe capability unavailable: ${capability}`);
    }
    const nodeId = `step-${index + 1}`;
    graph.nodes.push({
      id: nodeId,
      capability,
      parameters: parameters ?? {},
      position: { x: 30 + index * 230, y: 55 },
    });
    graph.edges.push({
      id: `edge-${index + 1}`,
      sourceNodeId: upstream,
      sourcePort: upstreamPort,
      targetNodeId: nodeId,
      targetPort: Object.keys(descriptor.inputs)[0],
    });
    upstream = nodeId;
    upstreamPort = Object.keys(descriptor.outputs)[0];
    graph.outputs = [
      { name: "result", dataType: Object.values(descriptor.outputs)[0].dataType, required: true },
    ];
  }
  graph.edges.push({
    id: "result",
    sourceNodeId: upstream,
    sourcePort: upstreamPort,
    targetNodeId: graph.id,
    targetPort: "result",
  });
  return prepareStudioGraph(graph).graph;
}
