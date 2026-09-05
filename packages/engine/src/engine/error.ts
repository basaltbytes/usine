import { AttemptId } from "@usine/core/attempt";
import { RunId } from "@usine/core/run";
import { Schema } from "effect";

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
