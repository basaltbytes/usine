import { Attempt, Event, Item, Loop, Run, Step } from "@usine/core";
import { Schema } from "effect";

/** Whether a loop parks new runs until an approval Event arrives. */
export const APPROVAL_REQUIREMENTS = ["none", "required"] as const;
export const ApprovalRequirement = Schema.Literals(APPROVAL_REQUIREMENTS);
export type ApprovalRequirement = typeof ApprovalRequirement.Type;

/** Absolute or caller-resolved path to the instance folder. */
export const InstanceDirectory = Schema.NonEmptyString.pipe(Schema.brand("InstanceDirectory"));
export type InstanceDirectory = typeof InstanceDirectory.Type;

/** The complete routing context needed to turn one Event into a Run. */
export class Submission extends Schema.Class<Submission>("@usine/engine/Submission")({
  event: Event.Event,
  itemKey: Item.ItemKey,
  loop: Loop.LoopName,
  step: Step.StepName,
  approval: ApprovalRequirement,
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
}) {}

/** Input passed to the attempt-execution port. */
export class StepExecution extends Schema.Class<StepExecution>("@usine/engine/StepExecution")({
  attempt: Attempt.Attempt,
  event: Event.Event,
  run: Run.Run,
  step: Step.Step,
}) {}

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
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export const RunEngineError = Schema.Union([
  RunNotFoundError,
  RunOperationRejectedError,
  EnginePersistenceError,
]);
export type RunEngineError = typeof RunEngineError.Type;
