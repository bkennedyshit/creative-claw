import type { CreativeCapabilityDescriptor } from "@openclaw/creative-contracts";

export const AI_CAPABILITIES: CreativeCapabilityDescriptor[] = ["image", "video"].flatMap((kind) =>
  ["background_blur", "background_color", "matte", ...(kind === "image" ? ["cutout"] : [])].map(
    (operation) => ({
      id: `ai.${kind}_${operation}`,
      version: "1.0.0",
      family: kind === "image" ? "image" : "video-vfx",
      label: `${kind === "image" ? "Image" : "Video"} AI ${operation.replaceAll("_", " ")}`,
      description: `Real local U2Net foreground segmentation through the guarded native C++ bridge. ${kind === "video" ? "Per-frame segmentation with optional mask smoothing, not recurrent video matting." : "PNG outputs preserve alpha for cutouts."}`,
      inputs: { source: { dataType: kind, required: true } },
      outputs: { result: { dataType: kind, required: true } },
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ...(operation === "background_blur"
            ? {
                blur_sigma: {
                  type: "number",
                  default: 12,
                  minimum: 0.3,
                  maximum: 50,
                  description: "Background Gaussian blur radius",
                },
              }
            : {}),
          ...(operation === "background_color"
            ? Object.fromEntries(
                ["red", "green", "blue"].map((channel) => [
                  channel,
                  {
                    type: "integer",
                    default: channel === "green" ? 180 : 30,
                    minimum: 0,
                    maximum: 255,
                  },
                ]),
              )
            : {}),
          ...(kind === "video"
            ? {
                temporal_smoothing: {
                  type: "number",
                  default: 0.25,
                  minimum: 0,
                  maximum: 0.95,
                  description:
                    "Previous-mask blend; 0 disables smoothing. Higher settings may trail fast motion.",
                },
              }
            : {}),
        },
      },
      execution: {
        runtime: "native",
        supportsProgress: true,
        supportsCancellation: true,
        deterministic: true,
        cacheable: true,
      },
      requirements: {
        gpu: "optional",
        models: ["u2net.onnx"],
        binaries:
          kind === "video"
            ? ["ffmpeg", "ffprobe", "guarded image bridge", "onnxruntime"]
            : ["guarded image bridge", "onnxruntime"],
      },
      risk: { writesFiles: true, mayOverwrite: false, externalUpload: false, publishes: false },
    }),
  ),
);
