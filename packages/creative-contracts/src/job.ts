// Creative Claw contract module defines canonical product schema shapes.
import { type Static, Type } from "typebox";
import { CreativeIdSchema, IsoTimestampSchema, NonEmptyString } from "./primitives.js";

/**
 * Shared job lifecycle and progress contract, spec 11.
 *
 * Every long operation — native render, model pass, provider call — reports
 * through these shapes so the Studio has one progress path across process
 * boundaries.
 */

/** Job lifecycle states, spec 11. */
export const CREATIVE_JOB_STATUSES = [
  "queued",
  "running",
  "awaiting-approval",
  "completed",
  "failed",
  "cancelling",
  "cancelled",
] as const;

/** Closed job status schema. */
export const CreativeJobStatusSchema = Type.String({ enum: [...CREATIVE_JOB_STATUSES] });

/** Job status union. */
export type CreativeJobStatus = (typeof CREATIVE_JOB_STATUSES)[number];

/**
 * Job states after which no further progress event may arrive.
 *
 * `cancelling` is deliberately absent: spec 11 requires cancellation
 * acknowledgement to be immediate while cleanup continues, so a cancelling job
 * still emits events until it settles on `cancelled`.
 */
export const CREATIVE_TERMINAL_JOB_STATUSES = [
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly CreativeJobStatus[];

/** True when `status` admits no further progress events. */
export function isTerminalJobStatus(status: CreativeJobStatus): boolean {
  return (CREATIVE_TERMINAL_JOB_STATUSES as readonly string[]).includes(status);
}

/** Per-node terminal states, spec 10.4. A node settles on exactly one. */
export const CREATIVE_NODE_STATES = [
  "completed",
  "failed",
  "cancelled",
  "skipped",
  "cached",
] as const;

/** Closed node state schema. */
export const CreativeNodeStateSchema = Type.String({ enum: [...CREATIVE_NODE_STATES] });

/** Node terminal state union. */
export type CreativeNodeState = (typeof CREATIVE_NODE_STATES)[number];

/**
 * One progress event, spec 11.
 *
 * `sequence` is monotonic per job and is what lets a reconnecting Studio
 * discard replayed events; it is not a global counter. `progress` is omitted
 * rather than faked when the work is unmeasurable — spec 11 forbids reporting a
 * synthetic percentage. `attempt` identifies a retry, which is the only case
 * where `progress` may legitimately move backward.
 */
export const CreativeProgressEventSchema = Type.Object(
  {
    jobId: CreativeIdSchema,
    graphRunId: Type.Optional(CreativeIdSchema),
    nodeId: Type.Optional(CreativeIdSchema),
    sequence: Type.Integer({ minimum: 0 }),
    timestamp: IsoTimestampSchema,
    phase: NonEmptyString,
    progress: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    attempt: Type.Optional(Type.Integer({ minimum: 1 })),
    message: Type.Optional(NonEmptyString),
    artifactId: Type.Optional(CreativeIdSchema),
  },
  { additionalProperties: false },
);

/** One progress event. */
export type CreativeProgressEvent = Static<typeof CreativeProgressEventSchema>;

/**
 * Job record surviving Studio reconnects, spec 11.
 *
 * `lastSequence` lets a reconnecting client resume without replaying the whole
 * event history, and pairs with `CreativeProgressEvent.sequence`.
 */
export const CreativeJobSchema = Type.Object(
  {
    id: CreativeIdSchema,
    projectId: CreativeIdSchema,
    status: CreativeJobStatusSchema,
    graphId: Type.Optional(CreativeIdSchema),
    graphRunId: Type.Optional(CreativeIdSchema),
    createdAt: IsoTimestampSchema,
    startedAt: Type.Optional(IsoTimestampSchema),
    endedAt: Type.Optional(IsoTimestampSchema),
    lastSequence: Type.Integer({ minimum: 0 }),
    failureReason: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Job record. */
export type CreativeJob = Static<typeof CreativeJobSchema>;
