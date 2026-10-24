import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../gateway.js";
import { renderCreativeStudio } from "../views/creative-studio.js";
import { CreativeStudioController } from "./creative-studio.js";

class MockHost {
  client: GatewayBrowserClient | null = null;
  connected = true;
  updates = 0;
  updateComplete = Promise.resolve(true);

  addController() {}
  removeController() {}
  requestUpdate() {
    this.updates++;
  }
}

describe("CreativeStudioController", () => {
  it("renders descriptor controls and commits fractional times without erasing partial input", () => {
    const controller = new CreativeStudioController(new MockHost());
    controller.activeMedia = "video";
    controller.engines.video = {
      available: true,
      ops: [
        {
          id: "cut_clip",
          label: "Cut Clip",
          parametersSchema: {
            properties: {
              start_sec: { type: "number", default: 0, minimum: 0 },
              stream_copy: { type: "boolean", default: true },
            },
          },
        },
      ],
    };
    controller.updateRunForm({ op: "cut_clip" });
    const container = document.createElement("div");
    render(
      renderCreativeStudio({
        activeMedia: "video",
        engines: controller.engines,
        gpu: controller.gpu,
        recentOutputs: [],
        library: [],
        runForm: controller.runForm,
        running: false,
        onMediaChange: () => {},
        onRunFormChange: (patch) => controller.updateRunForm(patch),
        onRunOp: () => {},
        onSearchMedia: () => {},
        onPreview: () => {},
      }),
      container,
    );
    const time = container.querySelector<HTMLInputElement>('input[type="number"]')!;
    time.value = "1.5";
    time.dispatchEvent(new Event("input"));
    expect(controller.runForm.params.start_sec).toBe(0);
    expect(time.value).toBe("1.5");
    time.dispatchEvent(new Event("change"));
    expect(controller.runForm.params.start_sec).toBe(1.5);
    const copy = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(copy.checked).toBe(true);
    copy.checked = false;
    copy.dispatchEvent(new Event("change"));
    expect(controller.runForm.params.stream_copy).toBe(false);
    render(null, container);
  });

  it("restores the last saved operation after reload and uses the versioned media adapter", async () => {
    const host = new MockHost();
    const request = vi.fn(async (method: string) => {
      if (method === "creative.studio.snapshot")
        return {
          runs: [
            {
              input: "source.mp4",
              graph: { nodes: [{ capability: "video.cut_clip", parameters: { start_sec: 1.5 } }] },
            },
          ],
          results: [],
        };
      return { available: true, ops: [], results: [] };
    });
    host.client = { request } as unknown as GatewayBrowserClient;
    const controller = new CreativeStudioController(host);
    await controller.refresh();
    expect(controller.activeMedia).toBe("video");
    expect(controller.runForm).toEqual({
      input: "source.mp4",
      op: "cut_clip",
      output: "",
      params: { start_sec: 1.5 },
    });
    expect(request).toHaveBeenCalledWith("visual-memory.search.v1", { query: "", limit: 12 });
  });
  it("initializes with default state", () => {
    const host = new MockHost();
    const controller = new CreativeStudioController(host);

    expect(controller.activeMedia).toBe("image");
    expect(controller.runForm).toEqual({ input: "", op: "", output: "", params: {} });
    expect(controller.running).toBe(false);
  });

  it("resets op and params when active media changes", () => {
    const host = new MockHost();
    const controller = new CreativeStudioController(host);

    controller.updateRunForm({ input: "test.mp4", op: "cut_clip", params: { start_sec: 10 } });
    expect(controller.runForm.op).toBe("cut_clip");

    controller.setActiveMedia("video");
    expect(controller.activeMedia).toBe("video");
    expect(controller.runForm.op).toBe("");
    expect(controller.runForm.params).toEqual({});
  });

  it("populates default parameters when operation selection changes", () => {
    const host = new MockHost();
    const controller = new CreativeStudioController(host);

    controller.activeMedia = "video";
    controller.engines.video = {
      available: true,
      ops: [
        {
          id: "cut_clip",
          label: "Cut Clip",
          parametersSchema: {
            type: "object",
            properties: {
              start_sec: { type: "number", default: 0 },
              end_sec: { type: "number", default: 10 },
              stream_copy: { type: "boolean", default: true },
            },
          },
        },
      ],
    };

    controller.updateRunForm({ op: "cut_clip" });
    expect(controller.runForm.op).toBe("cut_clip");
    expect(controller.runForm.params).toEqual({
      start_sec: 0,
      end_sec: 10,
      stream_copy: true,
    });

    // Updating a parameter field
    controller.updateRunForm({
      params: { ...controller.runForm.params, start_sec: 2.5 },
    });
    expect(controller.runForm.params.start_sec).toBe(2.5);
    expect(controller.runForm.params.end_sec).toBe(10);
  });

  it("passes params to gateway client when running operation", async () => {
    const host = new MockHost();
    const mockRequest = vi.fn().mockResolvedValue({
      ok: true,
      output_path: "out/clip.mp4",
      message: "Operation completed",
    });
    host.client = {
      request: mockRequest,
    } as unknown as GatewayBrowserClient;

    const controller = new CreativeStudioController(host);
    controller.activeMedia = "video";
    controller.engines.video = {
      available: true,
      ops: [{ id: "cut_clip", label: "Cut Clip" }],
    };

    controller.updateRunForm({
      input: "in/source.mp4",
      op: "cut_clip",
      output: "out/clip.mp4",
      params: { start_sec: 5, end_sec: 15, stream_copy: true },
    });

    await controller.runOp();

    expect(mockRequest).toHaveBeenCalledWith("creative.studio.run", {
      engine: "video",
      op: "cut_clip",
      input: "in/source.mp4",
      output: "out/clip.mp4",
      params: { start_sec: 5, end_sec: 15, stream_copy: true },
    });
    expect(controller.lastResult?.ok).toBe(true);
  });
});
