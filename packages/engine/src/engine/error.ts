import { AttemptId } from "@usine/core/attempt";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import { Schema } from "effect";

/** An error for a Run ID that doesn't exist. */
export class RunNotFoundError extends Schema.TaggedError<RunNotFoundError>(
  "@usine/engine/RunNotFoundError",
)("RunNotFoundError", {
  runId: RunId,
}) {}

/** An error for an operator action that the Run's state doesn't allow. */
export class RunOperationRejectedError extends Schema.TaggedError<RunOperationRejectedError>(
  "@usine/engine/RunOperationRejectedError",
)("RunOperationRejectedError", {
  runId: RunId,
  operation: Schema.Literals(["approve", "retry", "resolveFailure", "runAgain", "cancel"]),
  state: Schema.String,
}) {}

/** An error for a retry or run again while `openRunId`, another Run of the same Loop and Item, is open. */
export class RunRetryBlockedError extends Schema.TaggedError<RunRetryBlockedError>(
  "@usine/engine/RunRetryBlockedError",
)("RunRetryBlockedError", {
  runId: RunId,
  openRunId: RunId,
  message: Schema.NonEmptyString,
}) {}

/** An error reading or writing the instance's durable records. */
export class EnginePersistenceError extends Schema.TaggedError<EnginePersistenceError>(
  "@usine/engine/EnginePersistenceError",
)("EnginePersistenceError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

/** An error for a canceled Run whose active Attempt couldn't be interrupted. */
export class AttemptCancellationError extends Schema.TaggedError<AttemptCancellationError>(
  "@usine/engine/AttemptCancellationError",
)("AttemptCancellationError", {
  attemptId: AttemptId,
  cause: Schema.Defect(),
}) {}

/** The errors that the Run store can fail with. */
export const RunStoreError = Schema.Union([
  RunNotFoundError,
  RunOperationRejectedError,
  RunRetryBlockedError,
  EnginePersistenceError,
]);

export type RunStoreError = typeof RunStoreError.Type;

/** An error for an Attempt that is no longer live or whose channel rejected operator input. */
export class RunInterventionRejectedError extends Schema.TaggedError<RunInterventionRejectedError>(
  "@usine/engine/RunInterventionRejectedError",
)("RunInterventionRejectedError", {
  runId: RunId,
  attemptId: AttemptId,
  message: Schema.NonEmptyString,
}) {}

/**
 * An error for discarding the leftovers of a Worker that is still in `usine.yaml` or still has
 * open Attempts. Nothing is discarded.
 */
export class LeftoversDiscardRejectedError extends Schema.TaggedError<LeftoversDiscardRejectedError>(
  "@usine/engine/LeftoversDiscardRejectedError",
)("LeftoversDiscardRejectedError", {
  worker: WorkerName,
  /** The number of open Attempts on `worker`. */
  running: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}) {}

/** The Run store errors plus `AttemptCancellationError`. */
export const RunEngineError = Schema.Union([
  RunNotFoundError,
  RunOperationRejectedError,
  RunRetryBlockedError,
  EnginePersistenceError,
  AttemptCancellationError,
  RunInterventionRejectedError,
]);

export type RunEngineError = typeof RunEngineError.Type;
