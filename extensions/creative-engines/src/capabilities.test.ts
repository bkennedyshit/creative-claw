import { CreativeCapabilityDescriptorSchema } from "@openclaw/creative-contracts";
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import {
  getAllCreativeCapabilities,
  getCreativeCapability,
  getEngineCapabilities,
  searchCreativeCapabilities,
  validateOperationParameters,
} from "./capabilities.js";

describe("Creative Capability Descriptors", () => {
  const validator = Compile(CreativeCapabilityDescriptorSchema);

  it("produces valid CreativeCapabilityDescriptors for all registered engine operations", () => {
    const all = getAllCreativeCapabilities();
    expect(all.length).toBeGreaterThan(270);

    const invalid: Array<{ id: string; errors: string[] }> = [];

    for (const desc of all) {
      if (!validator.Check(desc)) {
        const errors = [...validator.Errors(desc)].map(
          (err) => `${err.path}: ${err.message} (value=${JSON.stringify(err.value)})`,
        );
        invalid.push({ id: desc.id, errors });
      }
    }

    if (invalid.length > 0) {
      console.error("Invalid capability descriptors:", JSON.stringify(invalid, null, 2));
    }
    expect(invalid).toEqual([]);
  });

  it("verifies expected engine counts (155 image, 45 audio, 46 video, 34 vector = 280 total)", () => {
    const imageOps = getEngineCapabilities("image");
    const audioOps = getEngineCapabilities("audio");
    const videoOps = getEngineCapabilities("video");
    const vectorOps = getEngineCapabilities("vector");

    expect(imageOps.length).toBe(155);
    expect(audioOps.length).toBe(45);
    expect(videoOps.length).toBe(46);
    expect(vectorOps.length).toBe(34);
    expect(imageOps.length + audioOps.length + videoOps.length + vectorOps.length).toBe(280);
  });

  describe("video.cut_clip", () => {
    it("conforms to the canonical video-edit contract with parametersSchema", () => {
      const desc = getCreativeCapability("video.cut_clip");
      expect(desc).toBeDefined();
      if (!desc) return;

      expect(desc.id).toBe("video.cut_clip");
      expect(desc.family).toBe("video-edit");
      expect(desc.label).toBe("Cut Clip");
      expect(desc.inputs).toEqual({
        source: { dataType: "video", required: true, description: "Input video" },
      });
      expect(desc.outputs).toEqual({
        clip: { dataType: "video", required: true, description: "Output video" },
      });
      expect(desc.execution.runtime).toBe("native");
      expect(desc.execution.supportsProgress).toBe(false);
      expect(desc.requirements.binaries).toContain("ffmpeg");

      // Verify parametersSchema
      const params = desc.parametersSchema as {
        type: string;
        properties: Record<string, { type: string; default?: unknown; description?: string }>;
      };
      expect(params.type).toBe("object");
      expect(params.properties.start_sec).toBeDefined();
      expect(params.properties.start_sec.type).toBe("number");
      expect(params.properties.start_sec.default).toBe(0);
      expect(params.properties.end_sec).toBeDefined();
      expect(params.properties.end_sec.type).toBe("number");
      expect(params.properties.stream_copy).toBeDefined();
      expect(params.properties.stream_copy.type).toBe("boolean");
      expect(params.properties.stream_copy.default).toBe(true);
    });
  });

  describe("neural / ONNX operations", () => {
    it("correctly models image.remove_background with model requirements and optional GPU", () => {
      const desc = getCreativeCapability("image.remove_background");
      expect(desc).toBeDefined();
      if (!desc) return;

      expect(desc.id).toBe("image.remove_background");
      expect(desc.family).toBe("image");
      expect(desc.requirements.models).toEqual(["u2net.onnx"]);
      expect(desc.requirements.gpu).toBe("optional");
    });

    it("correctly models neural_generate_depth_map with depth-map output port", () => {
      const desc = getCreativeCapability("image.neural_generate_depth_map");
      expect(desc).toBeDefined();
      if (!desc) return;

      expect(desc.outputs.depth).toEqual({
        dataType: "depth-map",
        required: true,
        description: "Output depth map",
      });
      expect(desc.requirements.models).toEqual(["depth_anything_v2_small.onnx"]);
      expect(desc.requirements.gpu).toBe("optional");
    });
  });

  describe("searchCreativeCapabilities", () => {
    it("searches by keyword across id, label, and description", () => {
      const cutResults = searchCreativeCapabilities("cut");
      expect(cutResults.some((d) => d.id === "video.cut_clip")).toBe(true);

      const bgResults = searchCreativeCapabilities("background");
      expect(bgResults.some((d) => d.id === "image.remove_background")).toBe(true);
      expect(bgResults.some((d) => d.id === "image.blur_background")).toBe(true);
    });

    it("filters by capability family", () => {
      const videoOps = searchCreativeCapabilities("", { family: "video-edit" });
      expect(videoOps.length).toBe(10);
      expect(videoOps.every((d) => d.family === "video-edit")).toBe(true);

      const imageOps = searchCreativeCapabilities("", { family: "image" });
      expect(imageOps.length).toBe(10);
      expect(imageOps.every((d) => d.family === "image")).toBe(true);
    });

    it("respects limit parameter", () => {
      const limited = searchCreativeCapabilities("", { limit: 5 });
      expect(limited.length).toBe(5);
    });
  });

  describe("validateOperationParameters", () => {
    it("validates and coerces video.cut_clip parameters with default stream_copy", () => {
      const desc = getCreativeCapability("video.cut_clip")!;
      const result = validateOperationParameters(desc, {
        start_sec: 5.5,
        end_sec: "12.0",
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.resolvedParams).toEqual({
        start_sec: 5.5,
        end_sec: 12.0,
        stream_copy: true,
      });
    });

    it("rejects negative start_sec for video.cut_clip", () => {
      const desc = getCreativeCapability("video.cut_clip")!;
      const result = validateOperationParameters(desc, {
        start_sec: -1,
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Parameter 'start_sec' (-1) must be >= 0");
    });

    it("enforces required parameters and enums for video.export_for_platform", () => {
      const desc = getCreativeCapability("video.export_for_platform")!;
      const missing = validateOperationParameters(desc, {});
      expect(missing.valid).toBe(false);
      expect(missing.errors).toContain("Missing required parameter 'platform'");

      const invalidEnum = validateOperationParameters(desc, { platform: "betamax" });
      expect(invalidEnum.valid).toBe(false);
      expect(invalidEnum.errors[0]).toContain("must be one of: youtube, tiktok");

      const valid = validateOperationParameters(desc, { platform: "tiktok" });
      expect(valid.valid).toBe(true);
      expect(valid.resolvedParams.platform).toBe("tiktok");
    });

    it("validates and populates defaults for image.crop", () => {
      const desc = getCreativeCapability("image.crop")!;
      const missing = validateOperationParameters(desc, {});
      expect(missing.valid).toBe(false);
      expect(missing.errors).toContain("Missing required parameter 'crop_width'");
      expect(missing.errors).toContain("Missing required parameter 'crop_height'");

      const valid = validateOperationParameters(desc, {
        crop_width: 320,
        crop_height: 240,
      });
      expect(valid.valid).toBe(true);
      expect(valid.resolvedParams.crop_x).toBe(0);
      expect(valid.resolvedParams.crop_y).toBe(0);
      expect(valid.resolvedParams.crop_width).toBe(320);
      expect(valid.resolvedParams.crop_height).toBe(240);
    });
    it("rejects parameters that are not declared by parametersSchema", () => {
      const desc = getCreativeCapability("video.cut_clip")!;
      const result = validateOperationParameters(desc, { unsupported: true });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Unknown parameter 'unsupported'");
    });
  });
});
