import { AttemptId } from "@usine/core/attempt";
import { RunId } from "@usine/core/run";
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
  operation: Schema.Literals(["approve", "retry", "resolveFailure"]),
  state: Schema.String,
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

/** The store's failures plus the cancellation handshake failure only the engine raises. */
export const RunEngineError = Schema.Union([
  RunNotFoundError,
  RunOperationRejectedError,
  EnginePersistenceError,
  AttemptCancellationError,
  RunInterventionRejectedError,
]);

export type RunEngineError = typeof RunEngineError.Type;
