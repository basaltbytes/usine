import { AttemptId } from "@usine/core/attempt";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import { Schema } from "effect";

/** An error for a Run ID that doesn't exist. */
export class RunNotFoundError extends Schema.TaggedError<RunNotFoundError>(
  "@usine/engine/RunNotFoundError",
)("RunNotFoundError", {
  /** The requested run ID that has no stored record. */
  runId: RunId,
}) {}

/** An error for an operator action that the Run's state doesn't allow. */
export class RunOperationRejectedError extends Schema.TaggedError<RunOperationRejectedError>(
  "@usine/engine/RunOperationRejectedError",
)("RunOperationRejectedError", {
  /** The run on which the operator requested the action. */
  runId: RunId,
  /** The requested operator action. */
  operation: Schema.Literals(["approve", "retry", "resolveFailure", "runAgain", "cancel"]),
  /** The stored run state that does not allow the action. */
  state: Schema.String,
}) {}

/** An error for a retry or run again while `openRunId`, another Run of the same Loop and Item, is open. */
export class RunRetryBlockedError extends Schema.TaggedError<RunRetryBlockedError>(
  "@usine/engine/RunRetryBlockedError",
)("RunRetryBlockedError", {
  /** The closed run for which a retry or run-again request was rejected. */
  runId: RunId,
  /** The other open run of the same loop and item that prevents admission. */
  openRunId: RunId,
  /** An operator-facing explanation; its wording is not a stable error code. */
  message: Schema.NonEmptyString,
}) {}

/** An error reading or writing the instance's durable records. */
export class EnginePersistenceError extends Schema.TaggedError<EnginePersistenceError>(
  "@usine/engine/EnginePersistenceError",
)("EnginePersistenceError", {
  /** The read, write, or initialization operation that failed. */
  operation: Schema.String,
  /** The original storage or decoding failure, retained for diagnostics. */
  cause: Schema.Defect(),
}) {}

/** An error for a canceled Run whose active Attempt couldn't be interrupted. */
export class AttemptCancellationError extends Schema.TaggedError<AttemptCancellationError>(
  "@usine/engine/AttemptCancellationError",
)("AttemptCancellationError", {
  /** The active attempt whose stop could not be confirmed after its run was canceled. */
  attemptId: AttemptId,
  /** The executor failure that prevented confirmation of the parent task stop. */
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
  /** The run targeted by the operator input. */
  runId: RunId,
  /** The attempt that is inactive or rejected the input. */
  attemptId: AttemptId,
  /** The reason input could not be delivered, for display to the operator. */
  message: Schema.NonEmptyString,
}) {}

/**
 * An error for discarding the leftovers of a Worker that is still in `usine.yaml` or still has
 * open Attempts. Nothing is discarded.
 */
export class LeftoversDiscardRejectedError extends Schema.TaggedError<LeftoversDiscardRejectedError>(
  "@usine/engine/LeftoversDiscardRejectedError",
)("LeftoversDiscardRejectedError", {
  /** The configured worker or worker with open attempts whose leftovers cannot be discarded. */
  worker: WorkerName,
  /** The number of open Attempts on `worker`. */
  running: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}) {}

/** Run store failures plus failures to confirm cancellation or deliver operator input. */
export const RunEngineError = Schema.Union([
  RunNotFoundError,
  RunOperationRejectedError,
  RunRetryBlockedError,
  EnginePersistenceError,
  AttemptCancellationError,
  RunInterventionRejectedError,
]);

export type RunEngineError = typeof RunEngineError.Type;
