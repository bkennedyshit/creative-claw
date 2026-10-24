// Creative Claw contract module defines canonical product schema shapes.
import { type Static, Type } from "typebox";
import {
  ContentHashSchema,
  CreativeIdSchema,
  CreativeUriSchema,
  IsoTimestampSchema,
  MediaTypeSchema,
  MetadataSchema,
  NonEmptyString,
  SchemaVersionSchema,
} from "./primitives.js";

/**
 * Project, asset, and artifact records, spec 8 and spec 9.
 *
 * A project is the durable unit of creator work; assets are immutable inputs;
 * artifacts are versioned outputs carrying lineage back to both.
 */

/** Asset kinds a creator can supply, spec 9.1. */
export const CREATIVE_ASSET_KINDS = [
  "text",
  "image",
  "audio",
  "video",
  "vector",
  "project-file",
] as const;

/** Closed asset kind schema. */
export const CreativeAssetKindSchema = Type.String({ enum: [...CREATIVE_ASSET_KINDS] });

/** Asset kind union. */
export type CreativeAssetKind = (typeof CREATIVE_ASSET_KINDS)[number];

/** How an asset entered the project, spec 9.1. */
export const CREATIVE_ASSET_SOURCES = ["user", "capture", "download", "generated"] as const;

/** Closed asset source schema. */
export const CreativeAssetSourceSchema = Type.String({ enum: [...CREATIVE_ASSET_SOURCES] });

/** Asset source union. */
export type CreativeAssetSource = (typeof CREATIVE_ASSET_SOURCES)[number];

/** Artifact kinds, spec 9.2. Superset of asset kinds: results may be manifests or graphs. */
export const CREATIVE_ARTIFACT_KINDS = [
  "text",
  "image",
  "audio",
  "video",
  "vector",
  "manifest",
  "graph",
] as const;

/** Closed artifact kind schema. */
export const CreativeArtifactKindSchema = Type.String({ enum: [...CREATIVE_ARTIFACT_KINDS] });

/** Artifact kind union. */
export type CreativeArtifactKind = (typeof CREATIVE_ARTIFACT_KINDS)[number];

/**
 * Artifact roles, spec 9.2.
 *
 * Role drives retention: spec 9.2 allows previews a shorter lifetime than
 * finals, so a retention sweep keys off this field rather than guessing from
 * media type or directory.
 */
export const CREATIVE_ARTIFACT_ROLES = [
  "intermediate",
  "preview",
  "candidate",
  "final",
  "diagnostic",
] as const;

/** Closed artifact role schema. */
export const CreativeArtifactRoleSchema = Type.String({ enum: [...CREATIVE_ARTIFACT_ROLES] });

/** Artifact role union. */
export type CreativeArtifactRole = (typeof CREATIVE_ARTIFACT_ROLES)[number];

/** Actor classes that can produce an artifact, spec 9.2. */
export const CREATIVE_ARTIFACT_PRODUCERS = ["user", "agent", "engine", "provider"] as const;

/** Closed artifact producer schema. */
export const CreativeArtifactProducerSchema = Type.String({
  enum: [...CREATIVE_ARTIFACT_PRODUCERS],
});

/** Artifact producer union. */
export type CreativeArtifactProducer = (typeof CREATIVE_ARTIFACT_PRODUCERS)[number];

/**
 * Creator brief captured from the conversation, spec 6.1.
 *
 * Every field is optional because a brief is progressively refined: the agent
 * may hold only a raw prompt on the first turn and fill in audience, platform,
 * and objective as it clarifies.
 */
export const CreativeBriefSchema = Type.Object(
  {
    prompt: Type.Optional(NonEmptyString),
    audience: Type.Optional(NonEmptyString),
    objective: Type.Optional(NonEmptyString),
    tone: Type.Optional(NonEmptyString),
    platforms: Type.Optional(Type.Array(NonEmptyString)),
    constraints: Type.Optional(Type.Array(NonEmptyString)),
  },
  { additionalProperties: false },
);

/** Creator brief. */
export type CreativeBrief = Static<typeof CreativeBriefSchema>;

/**
 * Durable project record, spec 8.
 *
 * `rootDirectory` is the only path-shaped field and is resolved relative to the
 * configured project root at load time; spec 8 requires a directory move to
 * leave the graph intact, so nothing else here may hold an absolute path.
 */
export const CreativeProjectSchema = Type.Object(
  {
    schemaVersion: SchemaVersionSchema,
    id: CreativeIdSchema,
    name: NonEmptyString,
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    rootDirectory: NonEmptyString,
    brief: Type.Optional(CreativeBriefSchema),
    brandProfileId: Type.Optional(CreativeIdSchema),
    assetIds: Type.Array(CreativeIdSchema),
    graphIds: Type.Array(CreativeIdSchema),
    artifactIds: Type.Array(CreativeIdSchema),
    activeGraphId: Type.Optional(CreativeIdSchema),
    tags: Type.Array(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Durable project record. */
export type CreativeProject = Static<typeof CreativeProjectSchema>;

/**
 * Creator-supplied or externally acquired source material, spec 9.1.
 *
 * Importing an asset computes identity and metadata without modifying the
 * source; spec 20 keeps sources immutable by default, so there is deliberately
 * no `updatedAt` here — a changed source is a new asset.
 */
export const CreativeAssetSchema = Type.Object(
  {
    schemaVersion: SchemaVersionSchema,
    id: CreativeIdSchema,
    kind: CreativeAssetKindSchema,
    uri: CreativeUriSchema,
    contentHash: ContentHashSchema,
    byteLength: Type.Integer({ minimum: 0 }),
    mediaType: MediaTypeSchema,
    importedAt: IsoTimestampSchema,
    metadata: MetadataSchema,
    source: CreativeAssetSourceSchema,
  },
  { additionalProperties: false },
);

/** Source asset record. */
export type CreativeAsset = Static<typeof CreativeAssetSchema>;

/**
 * The operation that produced an artifact.
 *
 * Recorded per artifact rather than looked up from the graph so lineage
 * survives graph edits: spec 9.2 requires a final artifact to stay reproducible
 * from its own declared capability, version, and parameters.
 */
export const CreativeArtifactOperationSchema = Type.Object(
  {
    capability: NonEmptyString,
    version: Type.Optional(NonEmptyString),
    parameters: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);

/** Producing operation record. */
export type CreativeArtifactOperation = Static<typeof CreativeArtifactOperationSchema>;

/**
 * Versioned result or intermediate output, spec 9.2.
 *
 * `contentHash` is computed only after the file is finalized and a partial file
 * is never registered, so the presence of an artifact row is itself the signal
 * that the bytes are complete. `parentArtifactIds` plus `sourceAssetIds` form
 * the lineage chain the artifact browser walks.
 */
export const CreativeArtifactSchema = Type.Object(
  {
    schemaVersion: SchemaVersionSchema,
    id: CreativeIdSchema,
    projectId: CreativeIdSchema,
    kind: CreativeArtifactKindSchema,
    role: CreativeArtifactRoleSchema,
    uri: CreativeUriSchema,
    mediaType: MediaTypeSchema,
    contentHash: ContentHashSchema,
    byteLength: Type.Integer({ minimum: 0 }),
    createdAt: IsoTimestampSchema,
    createdBy: CreativeArtifactProducerSchema,
    graphId: Type.Optional(CreativeIdSchema),
    graphRunId: Type.Optional(CreativeIdSchema),
    nodeId: Type.Optional(CreativeIdSchema),
    parentArtifactIds: Type.Array(CreativeIdSchema),
    sourceAssetIds: Type.Array(CreativeIdSchema),
    operation: Type.Optional(CreativeArtifactOperationSchema),
    metadata: MetadataSchema,
  },
  { additionalProperties: false },
);

/** Versioned artifact record. */
export type CreativeArtifact = Static<typeof CreativeArtifactSchema>;
