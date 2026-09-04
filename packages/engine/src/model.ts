import { Agent } from "@usine/core/agent";
import { ModelId } from "@usine/core/agent/brain";
import { Attempt, AttemptTask } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { Event } from "@usine/core/event";
import {
  AttemptId,
  EventId,
  ItemKey,
  LoopName,
  RepositoryName,
  RunId,
  StepName,
} from "@usine/core/ids";
import { ApprovalRequirement } from "@usine/core/loop";
import { RepositoryRevision } from "@usine/core/repository";
import { Run } from "@usine/core/run";
import { Step } from "@usine/core/step";
import { Schema } from "effect";

/** Durable runtime state for one Loop. Authored loop files never carry this toggle. */
export class LoopRuntimeState extends Schema.Class<LoopRuntimeState>(
  "@usine/engine/LoopRuntimeState",
)({
  loop: LoopName,
  paused: Schema.Boolean,
}) {}

/** The complete routing context needed to turn one Event into a Run. */
export class Submission extends Schema.Class<Submission>("@usine/engine/Submission")({
  event: Event,
  itemKey: ItemKey,
  loop: LoopName,
  step: StepName,
  approval: ApprovalRequirement,
  repository: RepositoryName,
  revision: RepositoryRevision,
  task: AttemptTask,
  agent: Agent,
  parentModel: Schema.Option(ModelId),
}) {}

/** The Event owns a Run and repeated submissions return the same identity. */
export class Claimed extends Schema.TaggedClass<Claimed>("@usine/engine/Claimed")("Claimed", {
  eventId: EventId,
  runId: RunId,
}) {}

/** A running Attempt on the same Item must finish before this Event is reconsidered. */
export class Queued extends Schema.TaggedClass<Queued>("@usine/engine/Queued")("Queued", {
  eventId: EventId,
}) {}

export const IGNORED_REASONS = ["superseded", "revoked"] as const;
export const IgnoreReason = Schema.Literals(IGNORED_REASONS);
export type IgnoreReason = typeof IgnoreReason.Type;

/** Durable one-shot requests from the store to the workflow runtime. */
export const WORKFLOW_COMMANDS = ["Approve", "Continue", "Interrupt", "Resume"] as const;
export const WorkflowCommand = Schema.Literals(WORKFLOW_COMMANDS);
export type WorkflowCommand = typeof WorkflowCommand.Type;

/**
 * Replay order after a restart, first delivered first. Interrupt must precede
 * Continue: on a cancel replay the canceled workflow stops before the next
 * queued Event opens, preserving one open Run per Item. The length constraint
 * forces this list to name every command exactly once.
 */
export const WORKFLOW_COMMAND_PRIORITY = [
  "Resume",
  "Interrupt",
  "Continue",
  "Approve",
] as const satisfies ReadonlyArray<WorkflowCommand> & {
  length: (typeof WORKFLOW_COMMANDS)["length"];
};

/** The Event remains in the permanent ledger but can no longer open a Run. */
export class Ignored extends Schema.TaggedClass<Ignored>("@usine/engine/Ignored")("Ignored", {
  eventId: EventId,
  reason: IgnoreReason,
}) {}

export const SubmissionResult = Schema.Union([Claimed, Queued, Ignored]);
export type SubmissionResult = typeof SubmissionResult.Type;

/** Observable durable projection for one Run. */
export class RunSnapshot extends Schema.Class<RunSnapshot>("@usine/engine/RunSnapshot")({
  event: Event,
  itemKey: ItemKey,
  run: Run,
  step: Step,
  attempts: Schema.Array(Attempt),
  repository: RepositoryName,
  revision: RepositoryRevision,
  task: AttemptTask,
  agent: Agent,
  parentModel: Schema.Option(ModelId),
}) {}

/** Lightweight durable projection used when listing Runs for operators. */
export class RunSummary extends Schema.Class<RunSummary>("@usine/engine/RunSummary")({
  itemKey: ItemKey,
  run: Run,
  step: Step,
  attempts: Schema.Array(Attempt),
  repository: RepositoryName,
  task: AttemptTask,
  agent: Agent,
}) {}

/** Monotonic version of the durable operator projection. */
export const ProjectionRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand("ProjectionRevision"),
);
export type ProjectionRevision = typeof ProjectionRevision.Type;

/** Input passed to the attempt-execution port. */
export class StepExecution extends Schema.Class<StepExecution>("@usine/engine/StepExecution")({
  attempt: Attempt,
  event: Event,
  run: Run,
  step: Step,
  repository: RepositoryName,
  revision: RepositoryRevision,
  task: AttemptTask,
  agent: Agent,
  parentModel: Schema.Option(ModelId),
}) {}

/**
 * Value object: global append order of the persisted transcript — the tail
 * cursor. Distinct from `AttemptChannel.Sequence`, which orders messages
 * within one Attempt's channel direction.
 */
export const TranscriptSequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("TranscriptSequence"),
);
export type TranscriptSequence = typeof TranscriptSequence.Type;

const LEGACY_TRANSCRIPT_PROTOCOL_VERSION = 3 as const;
const LegacyTranscriptEnvelope = Schema.Union([
  Schema.Struct({
    ...AttemptChannel.OutboundEnvelope.fields,
    version: Schema.Literal(LEGACY_TRANSCRIPT_PROTOCOL_VERSION),
  }),
  Schema.Struct({
    ...AttemptChannel.InboundEnvelope.fields,
    version: Schema.Literal(LEGACY_TRANSCRIPT_PROTOCOL_VERSION),
  }),
]);

/** Durable v3 envelopes remain readable; the live Attempt channel stays v4-only. */
const TranscriptEnvelope = Schema.Union([AttemptChannel.Envelope, LegacyTranscriptEnvelope]);

/** One append-only row in an Attempt transcript. */
export class TranscriptEntry extends Schema.Class<TranscriptEntry>("@usine/engine/TranscriptEntry")(
  {
    sequence: TranscriptSequence,
    attemptId: AttemptId,
    direction: AttemptChannel.Direction,
    envelope: TranscriptEnvelope,
    receivedAt: Schema.DateTimeUtc,
  },
) {}

/** Read every row for one Attempt. Intended for execution and diagnostic consumers. */
export class TranscriptAllQuery extends Schema.TaggedClass<TranscriptAllQuery>(
  "@usine/engine/TranscriptAllQuery",
)("TranscriptAllQuery", { attemptId: AttemptId }) {}

/** Read rows appended after a cursor while tailing a live Attempt. */
export class TranscriptTailQuery extends Schema.TaggedClass<TranscriptTailQuery>(
  "@usine/engine/TranscriptTailQuery",
)("TranscriptTailQuery", {
  attemptId: AttemptId,
  after: TranscriptSequence,
  limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
}) {}

/** Read the newest bounded page before a cursor, or from the current tail. */
export class TranscriptPageQuery extends Schema.TaggedClass<TranscriptPageQuery>(
  "@usine/engine/TranscriptPageQuery",
)("TranscriptPageQuery", {
  attemptId: AttemptId,
  before: Schema.Option(TranscriptSequence),
  limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
}) {}

/** Illegal combinations of full, tail, and backward-page reads are unrepresentable. */
export const TranscriptQuery = Schema.Union([
  TranscriptAllQuery,
  TranscriptTailQuery,
  TranscriptPageQuery,
]);
export type TranscriptQuery = typeof TranscriptQuery.Type;

export class RunNotFoundError extends Schema.TaggedError<RunNotFoundError>(
  "@usine/engine/RunNotFoundError",
)("RunNotFoundError", {
  runId: RunId,
}) {}

export class RunOperationRejectedError extends Schema.TaggedError<RunOperationRejectedError>(
  "@usine/engine/RunOperationRejectedError",
)("RunOperationRejectedError", {
  runId: RunId,
  operation: Schema.Literals(["approve", "retry"]),
  state: Schema.String,
}) {}

export class EnginePersistenceError extends Schema.TaggedError<EnginePersistenceError>(
  "@usine/engine/EnginePersistenceError",
)("EnginePersistenceError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

export class AttemptCancellationError extends Schema.TaggedError<AttemptCancellationError>(
  "@usine/engine/AttemptCancellationError",
)("AttemptCancellationError", {
  attemptId: AttemptId,
  cause: Schema.Defect(),
}) {}

/** Everything the store itself can fail with. */
export const RunStoreError = Schema.Union([
  RunNotFoundError,
  RunOperationRejectedError,
  EnginePersistenceError,
]);
export type RunStoreError = typeof RunStoreError.Type;

/** The store's failures plus the engine-only cancellation handshake failure. */
export const RunEngineError = Schema.Union([
  RunNotFoundError,
  RunOperationRejectedError,
  EnginePersistenceError,
  AttemptCancellationError,
]);
export type RunEngineError = typeof RunEngineError.Type;
