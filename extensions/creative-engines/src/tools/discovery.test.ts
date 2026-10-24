import type { AnyAgentTool } from "openclaw/plugin-sdk/core";
import { describe, expect, it } from "vitest";
import { registerDiscoveryTools } from "./discovery.js";

describe("Creative Discovery Tools", () => {
  const tools: Record<string, AnyAgentTool> = {};
  const registerTool = (tool: AnyAgentTool) => {
    tools[tool.name] = tool;
  };

  registerDiscoveryTools(registerTool);

  it("registers 3 compact discovery tools", () => {
    expect(tools["creative.capabilities.search"]).toBeDefined();
    expect(tools["creative.capabilities.get"]).toBeDefined();
    expect(tools["creative.graph.validate"]).toBeDefined();
  });

  describe("creative.capabilities.search", () => {
    it("searches operations and returns compact summaries", async () => {
      const tool = tools["creative.capabilities.search"]!;
      const result = (await tool.execute("call-1", { query: "cut" })) as {
        details: {
          count: number;
          capabilities: Array<{ id: string; label: string; family: string }>;
        };
      };

      expect(result.details.count).toBeGreaterThan(0);
      expect(result.details.capabilities.some((c) => c.id === "video.cut_clip")).toBe(true);
    });

    it("filters by family", async () => {
      const tool = tools["creative.capabilities.search"]!;
      const result = (await tool.execute("call-2", { query: "", family: "video-edit" })) as {
        details: { count: number; capabilities: Array<{ id: string; family: string }> };
      };

      expect(result.details.count).toBeGreaterThan(0);
      expect(result.details.count).toBeLessThanOrEqual(10);
      expect(result.details.capabilities.every((c) => c.family === "video-edit")).toBe(true);
    });
  });

  describe("creative.capabilities.get", () => {
    it("returns full capability descriptor and parametersSchema for video.cut_clip", async () => {
      const tool = tools["creative.capabilities.get"]!;
      const result = (await tool.execute("call-3", { id: "video.cut_clip" })) as {
        details: {
          found: boolean;
          capability: { id: string; parametersSchema: Record<string, unknown> };
        };
      };

      expect(result.details.found).toBe(true);
      expect(result.details.capability.id).toBe("video.cut_clip");
      expect(result.details.capability.parametersSchema).toBeDefined();
    });

    it("returns found: false for unknown capability", async () => {
      const tool = tools["creative.capabilities.get"]!;
      const result = (await tool.execute("call-4", { id: "nonexistent.op" })) as {
        details: { found: boolean; error: string };
      };

      expect(result.details.found).toBe(false);
      expect(result.details.error).toContain("not found");
    });
  });

  describe("creative.graph.validate", () => {
    it("validates a graph with valid connections", async () => {
      const tool = tools["creative.graph.validate"]!;
      const validGraph = {
        schemaVersion: 1,
        createdAt: "2026-10-24T12:00:00.000Z",
        updatedAt: "2026-10-24T12:00:00.000Z",
        metadata: {},
        id: "graph_1",
        projectId: "project_1",
        name: "Test graph",
        revision: 1,
        nodes: [
          {
            id: "cut_node",
            capability: "video.cut_clip",
            parameters: { start_sec: 0, end_sec: 5 },
          },
        ],
        inputs: [{ name: "footage", dataType: "video", required: true }],
        outputs: [{ name: "selects", dataType: "video", required: true }],
        edges: [
          {
            id: "e1",
            sourceNodeId: "graph_1",
            sourcePort: "footage",
            targetNodeId: "cut_node",
            targetPort: "source",
          },
          {
            id: "e2",
            sourceNodeId: "cut_node",
            sourcePort: "clip",
            targetNodeId: "graph_1",
            targetPort: "selects",
          },
        ],
      };

      const result = (await tool.execute("call-5", { graph: validGraph })) as {
        details: { valid: boolean; ok: boolean; issues: unknown[] };
      };

      expect(result.details.valid).toBe(true);
      expect(result.details.ok).toBe(true);
      expect(result.details.issues).toEqual([]);
    });

    it("reports issues for invalid node capability", async () => {
      const tool = tools["creative.graph.validate"]!;
      const invalidGraph = {
        schemaVersion: 1,
        createdAt: "2026-10-24T12:00:00.000Z",
        updatedAt: "2026-10-24T12:00:00.000Z",
        projectId: "project_1",
        name: "Invalid graph",
        revision: 0,
        inputs: [],
        outputs: [],
        metadata: {},
        id: "g2",
        nodes: [
          {
            id: "n1",
            capability: "video.fake_op",
            capabilityVersion: "1.0.0",
            parameters: {},
          },
        ],
        edges: [],
      };

      const result = (await tool.execute("call-6", { graph: invalidGraph })) as {
        details: { valid: boolean; ok: boolean; issues: Array<{ code: string }> };
      };

      expect(result.details.valid).toBe(false);
      expect(result.details.ok).toBe(false);
      expect(result.details.issues.some((i) => i.code === "unknown-capability")).toBe(true);
    });
  });
});
