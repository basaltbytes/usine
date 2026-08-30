import {
  Attempt,
  AttemptChannel,
  Event,
  Instance,
  Item,
  Loop,
  Repository,
  Run,
  Step,
} from "@usine/core";
import { Schema } from "effect";

/** Whether a loop parks new runs until an approval Event arrives. */
export const APPROVAL_REQUIREMENTS = Loop.APPROVAL_REQUIREMENTS;
export const ApprovalRequirement = Loop.ApprovalRequirement;
export type ApprovalRequirement = Loop.ApprovalRequirement;

/** Absolute or caller-resolved path to the instance folder. */
export const InstanceDirectory = Instance.Directory;
export type InstanceDirectory = Instance.Directory;

/** The complete routing context needed to turn one Event into a Run. */
export class Submission extends Schema.Class<Submission>("@usine/engine/Submission")({
  event: Event.Event,
  itemKey: Item.ItemKey,
  loop: Loop.LoopName,
  step: Step.StepName,
  approval: ApprovalRequirement,
  repository: Repository.Name,
  revision: Repository.Revision,
  task: AttemptChannel.Task,
}) {}

/** The Event owns a Run and repeated submissions return the same identity. */
export class Claimed extends Schema.TaggedClass<Claimed>("@usine/engine/Claimed")("Claimed", {
  eventId: Event.EventId,
  runId: Run.RunId,
}) {}

/** A running Attempt on the same Item must finish before this Event is reconsidered. */
export class Queued extends Schema.TaggedClass<Queued>("@usine/engine/Queued")("Queued", {
  eventId: Event.EventId,
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
  eventId: Event.EventId,
  reason: IgnoreReason,
}) {}

export const SubmissionResult = Schema.Union([Claimed, Queued, Ignored]);
export type SubmissionResult = typeof SubmissionResult.Type;

/** Observable durable projection for one Run. */
export class RunSnapshot extends Schema.Class<RunSnapshot>("@usine/engine/RunSnapshot")({
  event: Event.Event,
  run: Run.Run,
  step: Step.Step,
  attempts: Schema.Array(Attempt.Attempt),
  repository: Repository.Name,
  revision: Repository.Revision,
  task: AttemptChannel.Task,
}) {}

/** Input passed to the attempt-execution port. */
export class StepExecution extends Schema.Class<StepExecution>("@usine/engine/StepExecution")({
  attempt: Attempt.Attempt,
  event: Event.Event,
  run: Run.Run,
  step: Step.Step,
  repository: Repository.Name,
  revision: Repository.Revision,
  task: AttemptChannel.Task,
}) {}

export const TRANSCRIPT_DIRECTIONS = AttemptChannel.DIRECTIONS;
export const TranscriptDirection = AttemptChannel.Direction;
export type TranscriptDirection = AttemptChannel.Direction;

export const TranscriptSequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("TranscriptSequence"),
);
export type TranscriptSequence = typeof TranscriptSequence.Type;

/** One append-only row in an Attempt transcript. */
export class TranscriptEntry extends Schema.Class<TranscriptEntry>("@usine/engine/TranscriptEntry")(
  {
    sequence: TranscriptSequence,
    attemptId: Attempt.AttemptId,
    direction: TranscriptDirection,
    envelope: AttemptChannel.Envelope,
    receivedAt: Schema.DateTimeUtc,
  },
) {}

/** Cursor query used to tail the append-only transcript. */
export class TranscriptQuery extends Schema.Class<TranscriptQuery>("@usine/engine/TranscriptQuery")(
  {
    attemptId: Attempt.AttemptId,
    after: Schema.Option(TranscriptSequence),
  },
) {}

export class RunNotFoundError extends Schema.TaggedError<RunNotFoundError>(
  "@usine/engine/RunNotFoundError",
)("RunNotFoundError", {
  runId: Run.RunId,
}) {}

export class RunOperationRejectedError extends Schema.TaggedError<RunOperationRejectedError>(
  "@usine/engine/RunOperationRejectedError",
)("RunOperationRejectedError", {
  runId: Run.RunId,
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
  attemptId: Attempt.AttemptId,
  cause: Schema.Defect(),
}) {}

export const RunEngineError = Schema.Union([
  AttemptCancellationError,
  RunNotFoundError,
  RunOperationRejectedError,
  EnginePersistenceError,
]);
export type RunEngineError = typeof RunEngineError.Type;
