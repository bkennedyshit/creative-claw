// Creative Claw contract tests cover canonical schema shapes.
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { CreativeCapabilityDescriptorSchema } from "./capability.js";
import { CREATIVE_DATA_TYPES, isCreativeDataType } from "./data-types.js";
import { CreativeGraphSchema } from "./graph.js";
import {
  CREATIVE_TERMINAL_JOB_STATUSES,
  CreativeProgressEventSchema,
  isTerminalJobStatus,
} from "./job.js";
import { CREATIVE_SCHEMA_VERSION } from "./primitives.js";
import { CreativeArtifactSchema, CreativeAssetSchema, CreativeProjectSchema } from "./project.js";

/**
 * Contract tests for the persisted Creative Claw record shapes (spec 26.1).
 *
 * These assert the boundaries the rest of the product relies on: closed unions,
 * rejected extra properties, and identity fields that cannot hold a
 * machine-specific path.
 */

const HASH = `sha256:${"a".repeat(64)}`;
const NOW = "2026-09-01T12:00:00.000Z";

describe("CreativeCapabilityDescriptorSchema", () => {
  const validate = Compile(CreativeCapabilityDescriptorSchema);

  const descriptor = {
    id: "video.cut_clip",
    version: "1.2.0",
    family: "video-edit",
    label: "Cut clip",
    description: "Cut a time range out of a video.",
    inputs: { source: { dataType: "video", required: true } },
    outputs: { clip: { dataType: "video", required: true } },
    parametersSchema: { type: "object", required: ["startSeconds"] },
    execution: {
      runtime: "native",
      supportsProgress: true,
      supportsCancellation: true,
      deterministic: true,
      cacheable: true,
    },
    requirements: { binaries: ["ffmpeg"], gpu: "none" },
    risk: { writesFiles: true, mayOverwrite: false, externalUpload: false, publishes: false },
  };

  it("accepts a fully specified descriptor", () => {
    expect(validate.Check(descriptor)).toBe(true);
  });

  it("rejects an unknown capability family", () => {
    expect(validate.Check({ ...descriptor, family: "video" })).toBe(false);
  });

  it("rejects a non-dotted capability id", () => {
    expect(validate.Check({ ...descriptor, id: "cutclip" })).toBe(false);
  });

  it("rejects a non-semver capability version", () => {
    expect(validate.Check({ ...descriptor, version: "1.2" })).toBe(false);
  });

  it("rejects an unknown port data type", () => {
    expect(
      validate.Check({
        ...descriptor,
        outputs: { clip: { dataType: "movie", required: true } },
      }),
    ).toBe(false);
  });

  it("rejects undeclared descriptor properties so stale fields cannot ride along", () => {
    expect(validate.Check({ ...descriptor, deprecated: true })).toBe(false);
  });
});

describe("CreativeGraphSchema", () => {
  const validate = Compile(CreativeGraphSchema);

  const graph = {
    schemaVersion: CREATIVE_SCHEMA_VERSION,
    id: "graph_1",
    projectId: "project_1",
    name: "BMX selects",
    revision: 3,
    createdAt: NOW,
    updatedAt: NOW,
    nodes: [
      {
        id: "cut",
        capability: "video.cut_clip",
        parameters: { startSeconds: 0 },
        position: { x: 10, y: 20 },
      },
    ],
    edges: [
      {
        id: "edge_1",
        sourceNodeId: "graph_1",
        sourcePort: "footage",
        targetNodeId: "cut",
        targetPort: "source",
      },
    ],
    inputs: [{ name: "footage", dataType: "video", required: true }],
    outputs: [{ name: "selects", dataType: "video", required: true }],
    metadata: {},
  };

  it("accepts a graph with interface ports and a boundary edge", () => {
    expect(validate.Check(graph)).toBe(true);
  });

  it("rejects a mismatched schema version so migrations cannot be skipped", () => {
    expect(validate.Check({ ...graph, schemaVersion: 2 })).toBe(false);
  });

  it("rejects a negative revision", () => {
    expect(validate.Check({ ...graph, revision: -1 })).toBe(false);
  });

  it("rejects a hyphenated port name", () => {
    expect(
      validate.Check({
        ...graph,
        inputs: [{ name: "raw-footage", dataType: "video", required: true }],
      }),
    ).toBe(false);
  });

  it("rejects an unknown cache policy", () => {
    expect(
      validate.Check({
        ...graph,
        nodes: [{ ...graph.nodes[0], cachePolicy: "sometimes" }],
      }),
    ).toBe(false);
  });
});

describe("CreativeProjectSchema", () => {
  const validate = Compile(CreativeProjectSchema);

  const project = {
    schemaVersion: CREATIVE_SCHEMA_VERSION,
    id: "project_1",
    name: "Summer BMX",
    createdAt: NOW,
    updatedAt: NOW,
    rootDirectory: "projects/summer-bmx",
    assetIds: ["asset_1"],
    graphIds: ["graph_1"],
    artifactIds: [],
    tags: ["bmx"],
  };

  it("accepts a minimal project", () => {
    expect(validate.Check(project)).toBe(true);
  });

  it("rejects a project id containing a path separator", () => {
    // Spec 8 requires ids to survive a directory move, so a path-shaped id is
    // a contract violation rather than a cosmetic problem.
    expect(validate.Check({ ...project, id: "projects/summer" })).toBe(false);
  });

  it("accepts a progressively filled brief", () => {
    expect(validate.Check({ ...project, brief: { prompt: "Make riding selects" } })).toBe(true);
  });
});

describe("CreativeAssetSchema", () => {
  const validate = Compile(CreativeAssetSchema);

  const asset = {
    schemaVersion: CREATIVE_SCHEMA_VERSION,
    id: "asset_1",
    kind: "video",
    uri: "sources/ride.mp4",
    contentHash: HASH,
    byteLength: 1024,
    mediaType: "video/mp4",
    importedAt: NOW,
    metadata: {},
    source: "user",
  };

  it("accepts an imported asset", () => {
    expect(validate.Check(asset)).toBe(true);
  });

  it("rejects a content hash without an algorithm prefix", () => {
    expect(validate.Check({ ...asset, contentHash: "a".repeat(64) })).toBe(false);
  });

  it("rejects an unknown asset source", () => {
    expect(validate.Check({ ...asset, source: "scraped" })).toBe(false);
  });

  it("rejects a negative byte length", () => {
    expect(validate.Check({ ...asset, byteLength: -1 })).toBe(false);
  });
});

describe("CreativeArtifactSchema", () => {
  const validate = Compile(CreativeArtifactSchema);

  const artifact = {
    schemaVersion: CREATIVE_SCHEMA_VERSION,
    id: "artifact_1",
    projectId: "project_1",
    kind: "video",
    role: "final",
    uri: "artifacts/select-01.mp4",
    mediaType: "video/mp4",
    contentHash: HASH,
    byteLength: 2048,
    createdAt: NOW,
    createdBy: "engine",
    graphId: "graph_1",
    graphRunId: "run_1",
    nodeId: "cut",
    parentArtifactIds: ["artifact_0"],
    sourceAssetIds: ["asset_1"],
    operation: {
      capability: "video.cut_clip",
      version: "1.2.0",
      parameters: { startSeconds: 12 },
    },
    metadata: {},
  };

  it("accepts an artifact carrying full lineage", () => {
    expect(validate.Check(artifact)).toBe(true);
  });

  it("accepts empty lineage arrays for a root artifact", () => {
    expect(validate.Check({ ...artifact, parentArtifactIds: [], sourceAssetIds: [] })).toBe(true);
  });

  it("requires lineage arrays to be present rather than implied", () => {
    const { parentArtifactIds: _omitted, ...withoutLineage } = artifact;
    expect(validate.Check(withoutLineage)).toBe(false);
  });

  it("rejects an unknown artifact role", () => {
    expect(validate.Check({ ...artifact, role: "draft" })).toBe(false);
  });
});

describe("CreativeProgressEventSchema", () => {
  const validate = Compile(CreativeProgressEventSchema);

  const event = {
    jobId: "job_1",
    sequence: 4,
    timestamp: NOW,
    phase: "encoding",
  };

  it("accepts an event without a progress fraction", () => {
    // Spec 11 forbids a synthetic percentage, so unknown progress is an absent
    // field rather than a placeholder number.
    expect(validate.Check(event)).toBe(true);
  });

  it("accepts a bounded progress fraction", () => {
    expect(validate.Check({ ...event, progress: 0.5 })).toBe(true);
  });

  it("rejects a progress fraction above one", () => {
    expect(validate.Check({ ...event, progress: 1.5 })).toBe(false);
  });

  it("rejects a negative sequence", () => {
    expect(validate.Check({ ...event, sequence: -1 })).toBe(false);
  });

  it("rejects a zero retry attempt", () => {
    expect(validate.Check({ ...event, attempt: 0 })).toBe(false);
  });
});

describe("closed value sets", () => {
  it("recognizes every declared data type and nothing else", () => {
    for (const value of CREATIVE_DATA_TYPES) {
      expect(isCreativeDataType(value)).toBe(true);
    }
    expect(isCreativeDataType("movie")).toBe(false);
    expect(isCreativeDataType(undefined)).toBe(false);
  });

  it("treats cancelling as non-terminal while cleanup continues", () => {
    for (const status of CREATIVE_TERMINAL_JOB_STATUSES) {
      expect(isTerminalJobStatus(status)).toBe(true);
    }
    expect(isTerminalJobStatus("cancelling")).toBe(false);
    expect(isTerminalJobStatus("awaiting-approval")).toBe(false);
  });
});
