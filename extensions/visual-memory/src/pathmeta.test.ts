import { describe, it, expect } from "vitest";
import { inferBrand, classifyIntent, shouldWarnOnEdit, buildPathMetadata } from "./pathmeta.js";

describe("pathmeta", () => {
  describe("inferBrand", () => {
    it("infers brand from segment after workspace root", () => {
      expect(inferBrand("/workspace/content/acme/posts/image.png")).toBe("acme");
      expect(inferBrand("/workspace/input/brandx/footage/clip.mp4")).toBe("brandx");
      expect(inferBrand("/workspace/output/myclient/reels/reel1.mp4")).toBe("myclient");
      expect(inferBrand("/workspace/archive/oldbrand/audio/track.mp3")).toBe("oldbrand");
    });

    it("infers brand with explicit workspace root", () => {
      expect(inferBrand("/home/user/work/content/acme/posts/img.png", "/home/user/work")).toBe("acme");
      expect(inferBrand("/home/user/work/output/clienta/file.txt", "/home/user/work")).toBe("clienta");
    });

    it("returns undefined when no workspace root marker found", () => {
      expect(inferBrand("/random/path/to/file.png")).toBeUndefined();
      expect(inferBrand("/tmp/test.jpg")).toBeUndefined();
    });

    it("handles Windows-style paths", () => {
      expect(inferBrand("C:\\workspace\\content\\acme\\posts\\img.png")).toBe("acme");
    });

    it("returns undefined when brand segment is the file itself", () => {
      // /workspace/content/file.png — file is at workspace root level, no brand
      expect(inferBrand("/workspace/content/file.png")).toBeUndefined();
    });
  });

  describe("classifyIntent", () => {
    it("classifies from folder hints", () => {
      expect(classifyIntent("/workspace/content/acme/posts/img.png")).toBe("post");
      expect(classifyIntent("/workspace/content/acme/reels/video.mp4")).toBe("reel");
      expect(classifyIntent("/workspace/content/acme/stories/story.jpg")).toBe("story");
      expect(classifyIntent("/workspace/content/acme/audio/track.mp3")).toBe("audio");
      expect(classifyIntent("/workspace/content/acme/footage/clip.mov")).toBe("video");
    });

    it("returns undefined for unknown folder names", () => {
      expect(classifyIntent("/workspace/content/acme/misc/file.png")).toBeUndefined();
      expect(classifyIntent("/random/path/file.txt")).toBeUndefined();
    });

    it("is case-insensitive", () => {
      expect(classifyIntent("/workspace/content/acme/POSTS/img.png")).toBe("post");
      expect(classifyIntent("/workspace/content/acme/Reels/vid.mp4")).toBe("reel");
    });
  });

  describe("shouldWarnOnEdit", () => {
    it("returns true for paths containing /content/", () => {
      expect(shouldWarnOnEdit("/workspace/content/acme/posts/img.png")).toBe(true);
      expect(shouldWarnOnEdit("/any/path/content/file.txt")).toBe(true);
    });

    it("returns false for non-content paths", () => {
      expect(shouldWarnOnEdit("/workspace/input/acme/file.png")).toBe(false);
      expect(shouldWarnOnEdit("/workspace/output/acme/file.png")).toBe(false);
      expect(shouldWarnOnEdit("/tmp/test.jpg")).toBe(false);
    });

    it("is case-insensitive", () => {
      expect(shouldWarnOnEdit("/workspace/Content/acme/file.png")).toBe(true);
      expect(shouldWarnOnEdit("/workspace/CONTENT/acme/file.png")).toBe(true);
    });

    it("handles Windows paths", () => {
      expect(shouldWarnOnEdit("C:\\workspace\\content\\acme\\file.png")).toBe(true);
    });
  });

  describe("buildPathMetadata", () => {
    it("assembles brand, intent, and warnOnEdit", () => {
      const meta = buildPathMetadata("/workspace/content/acme/posts/img.png");
      expect(meta.brand).toBe("acme");
      expect(meta.intent).toBe("post");
      expect(meta.warnOnEdit).toBe(true);
    });

    it("handles input paths (no warn)", () => {
      const meta = buildPathMetadata("/workspace/input/client/reels/vid.mp4");
      expect(meta.brand).toBe("client");
      expect(meta.intent).toBe("reel");
      expect(meta.warnOnEdit).toBe(false);
    });

    it("handles unknown paths gracefully", () => {
      const meta = buildPathMetadata("/tmp/random/file.png");
      expect(meta.brand).toBeUndefined();
      expect(meta.intent).toBeUndefined();
      expect(meta.warnOnEdit).toBe(false);
    });
  });
});
