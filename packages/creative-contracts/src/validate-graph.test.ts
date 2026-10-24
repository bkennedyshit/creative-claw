// Creative Claw contract tests cover validate-graph behavior.
import { describe, expect, it } from "vitest";
import type { CreativeCapabilityDescriptor } from "./capability.js";
import { findConstraintConflict, isDataTypeCompatible } from "./data-type-compatibility.js";
import type { CreativeGraph, CreativeGraphEdge, CreativeGraphNode } from "./graph.js";
import { CREATIVE_SCHEMA_VERSION } from "./primitives.js";
import { validateGraph } from "./validate-graph.js";
import type { CreativeValidationCode } from "./validation.js";

/**
 * Contract tests for port compatibility and structured validation errors
 * (spec 26.1). Each case asserts the finding code rather than message text,
 * because codes are the contract the Studio and agent branch on.
 */

const NOW = "2026-09-01T12:00:00.000Z";

function capability(
  overrides: Partial<CreativeCapabilityDescriptor> & Pick<CreativeCapabilityDescriptor, "id">,
): CreativeCapabilityDescriptor {
  return {
    version: "1.0.0",
    family: "video-edit",
    label: overrides.id,
    description: overrides.id,
    inputs: {},
    outputs: {},
    parametersSchema: { type: "object" },
    execution: {
      runtime: "native",
      supportsProgress: false,
      supportsCancellation: false,
      deterministic: true,
      cacheable: true,
    },
    requirements: {},
    risk: { writesFiles: false, mayOverwrite: false, externalUpload: false, publishes: false },
    ...overrides,
  };
}

const CUT = capability({
  id: "video.cut_clip",
  inputs: { source: { dataType: "video", required: true } },
  outputs: { clip: { dataType: "video", required: true } },
  parametersSchema: { type: "object", required: ["startSeconds"] },
});

const THUMBNAIL = capability({
  id: "video.thumbnail",
  inputs: { source: { dataType: "video", required: true } },
  outputs: { frame: { dataType: "image", required: true } },
});

const RELIGHT = capability({
  id: "vfx.relight",
  family: "video-vfx",
  inputs: {
    source: { dataType: "video", required: true },
    mask: { dataType: "image-mask", required: false },
  },
  outputs: { relit: { dataType: "video", required: true } },
  requirements: { models: ["relight-v2"], gpu: "required" },
});

function node(
  id: string,
  capabilityId: string,
  overrides: Partial<CreativeGraphNode> = {},
): CreativeGraphNode {
  return { id, capability: capabilityId, parameters: {}, ...overrides };
}

function edge(
  id: string,
  sourceNodeId: string,
  sourcePort: string,
  targetNodeId: string,
  targetPort: string,
): CreativeGraphEdge {
  return { id, sourceNodeId, sourcePort, targetNodeId, targetPort };
}

function graph(overrides: Partial<CreativeGraph> = {}): CreativeGraph {
  return {
    schemaVersion: CREATIVE_SCHEMA_VERSION,
    id: "graph_1",
    projectId: "project_1",
    name: "test graph",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    nodes: [],
    edges: [],
    inputs: [],
    outputs: [],
    metadata: {},
    ...overrides,
  };
}

function codesFor(subject: CreativeGraph, capabilities = [CUT, THUMBNAIL, RELIGHT]) {
  return validateGraph({ graph: subject, capabilities }).issues.map((issue) => issue.code);
}

/** A graph that validates cleanly: one graph input, one node, one graph output. */
function soundGraph(): CreativeGraph {
  return graph({
    nodes: [node("cut", "video.cut_clip", { parameters: { startSeconds: 0 } })],
    edges: [
      edge("e1", "graph_1", "footage", "cut", "source"),
      edge("e2", "cut", "clip", "graph_1", "selects"),
    ],
    inputs: [{ name: "footage", dataType: "video", required: true }],
    outputs: [{ name: "selects", dataType: "video", required: true }],
  });
}

describe("isDataTypeCompatible", () => {
  it("accepts identical types", () => {
    expect(isDataTypeCompatible("video", "video")).toBe(true);
  });

  it("widens a mask to a generic image but not the reverse", () => {
    // A mask is a raster buffer so it can feed an image input; a plain image
    // never promised the single-channel meaning a mask input relies on.
    expect(isDataTypeCompatible("image-mask", "image")).toBe(true);
    expect(isDataTypeCompatible("image", "image-mask")).toBe(false);
  });

  it("widens depth and normal passes to images", () => {
    expect(isDataTypeCompatible("depth-map", "image")).toBe(true);
    expect(isDataTypeCompatible("normal-map", "image")).toBe(true);
  });

  it("bridges file-backed media through artifact-ref in both directions", () => {
    expect(isDataTypeCompatible("video", "artifact-ref")).toBe(true);
    expect(isDataTypeCompatible("artifact-ref", "video")).toBe(true);
  });

  it("does not treat inline scalars as artifacts", () => {
    expect(isDataTypeCompatible("number", "artifact-ref")).toBe(false);
    expect(isDataTypeCompatible("artifact-ref", "number")).toBe(false);
  });

  it("keeps unrelated types disconnected", () => {
    expect(isDataTypeCompatible("audio", "video")).toBe(false);
    expect(isDataTypeCompatible("timecode", "number")).toBe(false);
    expect(isDataTypeCompatible("artifact-list", "artifact-ref")).toBe(false);
  });
});

describe("findConstraintConflict", () => {
  it("treats an absent constraint as unconstrained", () => {
    expect(findConstraintConflict(undefined, { codecs: ["h264"] })).toBeUndefined();
    expect(findConstraintConflict({ codecs: ["prores"] }, undefined)).toBeUndefined();
    expect(findConstraintConflict({}, {})).toBeUndefined();
  });

  it("reports a codec set with no overlap", () => {
    expect(findConstraintConflict({ codecs: ["prores"] }, { codecs: ["h264"] })).toEqual({
      field: "codecs",
      source: "prores",
      target: "h264",
    });
  });

  it("accepts a partial codec overlap", () => {
    expect(
      findConstraintConflict({ codecs: ["prores", "h264"] }, { codecs: ["h264"] }),
    ).toBeUndefined();
  });

  it("reports an alpha requirement the source cannot satisfy", () => {
    expect(findConstraintConflict({ requiresAlpha: false }, { requiresAlpha: true })?.field).toBe(
      "requiresAlpha",
    );
  });

  it("reports a source minimum that exceeds the target maximum", () => {
    expect(
      findConstraintConflict(
        { minDimensions: { width: 3840, height: 2160 } },
        { maxDimensions: { width: 1920, height: 1080 } },
      )?.field,
    ).toBe("maxDimensions");
  });

  it("reports a channel count mismatch", () => {
    expect(findConstraintConflict({ channels: 2 }, { channels: 1 })?.field).toBe("channels");
  });
});

describe("validateGraph", () => {
  it("accepts a sound graph", () => {
    const result = validateGraph({
      graph: soundGraph(),
      capabilities: [CUT, THUMBNAIL, RELIGHT],
    });
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("reports an unknown capability", () => {
    expect(codesFor(graph({ nodes: [node("x", "video.nope")] }))).toContain("unknown-capability");
  });

  it("reports a pinned version that crosses a major boundary", () => {
    const subject = graph({
      nodes: [node("cut", "video.cut_clip", { capabilityVersion: "2.0.0" })],
    });
    expect(codesFor(subject)).toContain("unsupported-capability-version");
  });

  it("resolves a pinned version satisfied by a newer patch", () => {
    const subject = graph({
      nodes: [
        node("cut", "video.cut_clip", {
          capabilityVersion: "1.0.0",
          parameters: { startSeconds: 0 },
        }),
      ],
      edges: [edge("e1", "graph_1", "footage", "cut", "source")],
      inputs: [{ name: "footage", dataType: "video", required: true }],
    });
    const codes = codesFor(subject, [capability({ ...CUT, version: "1.4.2" })]);
    expect(codes).not.toContain("unsupported-capability-version");
  });

  it("reports a missing required parameter", () => {
    const subject = graph({
      nodes: [node("cut", "video.cut_clip")],
      edges: [edge("e1", "graph_1", "footage", "cut", "source")],
      inputs: [{ name: "footage", dataType: "video", required: true }],
    });
    expect(codesFor(subject)).toContain("missing-required-parameter");
  });

  it("reports an unconnected required input", () => {
    const subject = graph({
      nodes: [node("cut", "video.cut_clip", { parameters: { startSeconds: 0 } })],
    });
    expect(codesFor(subject)).toContain("missing-required-port");
  });

  it("does not require inputs on a disabled node", () => {
    const subject = graph({
      nodes: [node("cut", "video.cut_clip", { disabled: true, parameters: { startSeconds: 0 } })],
    });
    expect(codesFor(subject)).not.toContain("missing-required-port");
  });

  it("reports an enabled node depending on a disabled upstream node", () => {
    const subject = graph({
      nodes: [
        node("cut", "video.cut_clip", { disabled: true, parameters: { startSeconds: 0 } }),
        node("thumb", "video.thumbnail"),
      ],
      edges: [edge("e1", "cut", "clip", "thumb", "source")],
    });
    expect(codesFor(subject)).toContain("disabled-node-dependency");
  });

  it("reports a type-incompatible connection", () => {
    const subject = graph({
      nodes: [
        node("thumb", "video.thumbnail"),
        node("cut", "video.cut_clip", { parameters: { startSeconds: 0 } }),
      ],
      // thumbnail emits an image; cut_clip wants a video.
      edges: [edge("e1", "thumb", "frame", "cut", "source")],
    });
    expect(codesFor(subject)).toContain("incompatible-connection");
  });

  it("reports an edge naming a port the capability does not declare", () => {
    const subject = graph({
      nodes: [
        node("cut", "video.cut_clip", { parameters: { startSeconds: 0 } }),
        node("thumb", "video.thumbnail"),
      ],
      edges: [edge("e1", "cut", "missing", "thumb", "source")],
    });
    expect(codesFor(subject)).toContain("unknown-port");
  });

  it("reports an edge referencing a deleted node", () => {
    const subject = graph({
      nodes: [node("cut", "video.cut_clip", { parameters: { startSeconds: 0 } })],
      edges: [edge("e1", "ghost", "clip", "cut", "source")],
    });
    expect(codesFor(subject)).toContain("dangling-edge");
  });

  it("reports two edges landing on one input port", () => {
    const subject = graph({
      nodes: [
        node("a", "video.cut_clip", { parameters: { startSeconds: 0 } }),
        node("b", "video.cut_clip", { parameters: { startSeconds: 1 } }),
        node("thumb", "video.thumbnail"),
      ],
      edges: [
        edge("e1", "a", "clip", "thumb", "source"),
        edge("e2", "b", "clip", "thumb", "source"),
      ],
      inputs: [{ name: "footage", dataType: "video", required: true }],
    });
    expect(codesFor(subject)).toContain("duplicate-connection");
  });

  it("reports duplicate node and edge identifiers", () => {
    const subject = graph({
      nodes: [
        node("cut", "video.cut_clip", { parameters: { startSeconds: 0 } }),
        node("cut", "video.thumbnail"),
      ],
      edges: [
        edge("e1", "graph_1", "footage", "cut", "source"),
        edge("e1", "graph_1", "footage", "cut", "source"),
      ],
      inputs: [{ name: "footage", dataType: "video", required: true }],
    });
    const codes = codesFor(subject);
    expect(codes).toContain("duplicate-node-id");
    expect(codes).toContain("duplicate-edge-id");
  });

  it("rejects a node id that collides with the graph boundary id", () => {
    const subject = graph({
      nodes: [node("graph_1", "video.cut_clip", { parameters: { startSeconds: 0 } })],
    });
    expect(codesFor(subject)).toContain("duplicate-node-id");
  });

  it("reports a cycle and names its participants", () => {
    const subject = graph({
      nodes: [
        node("a", "video.cut_clip", { parameters: { startSeconds: 0 } }),
        node("b", "video.cut_clip", { parameters: { startSeconds: 1 } }),
      ],
      edges: [edge("e1", "a", "clip", "b", "source"), edge("e2", "b", "clip", "a", "source")],
    });
    const result = validateGraph({ graph: subject, capabilities: [CUT] });
    const cycle = result.issues.find((issue) => issue.code === "cycle");
    expect(cycle?.nodeIds).toEqual(["a", "b"]);
    expect(result.valid).toBe(false);
  });

  it("does not mistake a graph-boundary edge for a cycle", () => {
    expect(codesFor(soundGraph())).not.toContain("cycle");
  });

  it("reports a required graph output with no producer", () => {
    const subject = graph({
      nodes: [node("cut", "video.cut_clip", { parameters: { startSeconds: 0 } })],
      edges: [edge("e1", "graph_1", "footage", "cut", "source")],
      inputs: [{ name: "footage", dataType: "video", required: true }],
      outputs: [{ name: "selects", dataType: "video", required: true }],
    });
    expect(codesFor(subject)).toContain("unreachable-required-output");
  });

  it("reports a duplicated graph interface port", () => {
    const subject = graph({
      inputs: [
        { name: "footage", dataType: "video", required: true },
        { name: "footage", dataType: "audio", required: false },
      ],
    });
    expect(codesFor(subject)).toContain("invalid-subgraph-interface");
  });

  it("orders findings deterministically across repeated runs", () => {
    const subject = graph({
      nodes: [node("x", "video.nope"), node("cut", "video.cut_clip")],
      edges: [edge("e1", "ghost", "clip", "cut", "source")],
    });
    expect(codesFor(subject)).toEqual(codesFor(subject));
  });
});

describe("validateGraph environment hooks", () => {
  const gpuGraph = graph({
    nodes: [node("relight", "vfx.relight")],
    edges: [edge("e1", "graph_1", "footage", "relight", "source")],
    inputs: [{ name: "footage", dataType: "video", required: true }],
  });

  it("skips requirement checks when no probe is supplied", () => {
    // Without a probe the validator has no way to know what is installed, so
    // staying silent is the honest behavior rather than assuming absence.
    expect(codesFor(gpuGraph)).not.toContain("missing-requirement");
  });

  it("reports a requirement the probe says is unsatisfied", () => {
    const result = validateGraph({
      graph: gpuGraph,
      capabilities: [RELIGHT],
      hooks: {
        resolveRequirement: (query) =>
          query.kind === "model"
            ? { satisfied: false, reason: "weights not downloaded" }
            : { satisfied: true },
      },
    });
    const issue = result.issues.find((entry) => entry.code === "missing-requirement");
    expect(issue?.nodeId).toBe("relight");
    expect(issue?.message).toContain("weights not downloaded");
  });

  it("treats an undefined probe answer as unknown rather than missing", () => {
    const result = validateGraph({
      graph: gpuGraph,
      capabilities: [RELIGHT],
      hooks: { resolveRequirement: () => undefined },
    });
    expect(result.issues.map((entry) => entry.code)).not.toContain("missing-requirement");
  });

  it("merges caller findings that need machine facts", () => {
    const result = validateGraph({
      graph: gpuGraph,
      capabilities: [RELIGHT],
      hooks: {
        inspectNode: (target) => [
          {
            code: "invalid-source-asset" satisfies CreativeValidationCode,
            severity: "error",
            message: "Source asset is offline.",
            nodeId: target.id,
          },
        ],
      },
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain("invalid-source-asset");
  });
});

describe("validation result derivation", () => {
  it("stays valid when only warnings are present", () => {
    const result = validateGraph({
      graph: soundGraph(),
      capabilities: [CUT],
      hooks: {
        inspectNode: (target) => [
          {
            code: "unsafe-target" satisfies CreativeValidationCode,
            severity: "warning",
            message: "Output directory already contains a file with this name.",
            nodeId: target.id,
          },
        ],
      },
    });
    expect(result.issues).toHaveLength(1);
    expect(result.valid).toBe(true);
  });
});
