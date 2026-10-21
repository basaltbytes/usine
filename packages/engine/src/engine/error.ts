import { AttemptId } from "@usine/core/attempt";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import { Schema } from "effect";

/** No Run with the requested identity exists in this instance's records. */
export class RunNotFoundError extends Schema.TaggedError<RunNotFoundError>(
  "@usine/engine/RunNotFoundError",
)("RunNotFoundError", {
  runId: RunId,
}) {}

/** The Run's current state does not allow the requested operator action. */
export class RunOperationRejectedError extends Schema.TaggedError<RunOperationRejectedError>(
  "@usine/engine/RunOperationRejectedError",
)("RunOperationRejectedError", {
  runId: RunId,
  operation: Schema.Literals(["approve", "retry", "resolveFailure", "runAgain"]),
  state: Schema.String,
}) {}

/**
 * An operator retry would reopen a failed Run, or running a closed Run again
 * would open a new one, while `openRunId`, another Run of the same Loop and
 * Item, is open. Try again once that Run closes.
 */
export class RunRetryBlockedError extends Schema.TaggedError<RunRetryBlockedError>(
  "@usine/engine/RunRetryBlockedError",
)("RunRetryBlockedError", {
  runId: RunId,
  openRunId: RunId,
  message: Schema.NonEmptyString,
}) {}

/** An operation could not read or update the instance's durable records. */
export class EnginePersistenceError extends Schema.TaggedError<EnginePersistenceError>(
  "@usine/engine/EnginePersistenceError",
)("EnginePersistenceError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

/** The Run is canceled, but interrupting its active Attempt failed. */
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
  RunRetryBlockedError,
  EnginePersistenceError,
]);

export type RunStoreError = typeof RunStoreError.Type;

/** The requested Attempt is no longer live, or its channel could not accept operator input. */
export class RunInterventionRejectedError extends Schema.TaggedError<RunInterventionRejectedError>(
  "@usine/engine/RunInterventionRejectedError",
)("RunInterventionRejectedError", {
  runId: RunId,
  attemptId: AttemptId,
  message: Schema.NonEmptyString,
}) {}

/**
 * The operator asked to discard the leftovers of `worker`, a Worker the engine
 * still runs Attempts on: `usine.yaml` declares it, or a reload removed it and
 * `running` of its Attempts are still open. Nothing was discarded; once the
 * Worker is removed and its last Attempt ended, the same request discards them.
 */
export class LeftoversDiscardRejectedError extends Schema.TaggedError<LeftoversDiscardRejectedError>(
  "@usine/engine/LeftoversDiscardRejectedError",
)("LeftoversDiscardRejectedError", {
  worker: WorkerName,
  /** How many Attempts recorded on `worker` are still open. */
  running: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}) {}

/** The store's failures plus the cancellation handshake failure only the engine raises. */
export const RunEngineError = Schema.Union([
  RunNotFoundError,
  RunOperationRejectedError,
  RunRetryBlockedError,
  EnginePersistenceError,
  AttemptCancellationError,
  RunInterventionRejectedError,
]);

export type RunEngineError = typeof RunEngineError.Type;
