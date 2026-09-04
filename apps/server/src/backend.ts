import type { LoadedInstance } from "@usine/config/model";
import { LoopName, RunId } from "@usine/core/ids";
import {
  type BoardMove,
  type FactoryOverview,
  NeedsSetupOverview,
  type RunDetailView,
  type TranscriptRequest,
} from "@usine/orchestrator/operator/model";
import type {
  Operator,
  OperatorError,
  OperatorObservation,
} from "@usine/orchestrator/operator/service";
import { Context, Effect, Layer, Schema } from "effect";

export class BackendUnavailableError extends Schema.TaggedError<BackendUnavailableError>(
  "@usine/server/BackendUnavailableError",
)("BackendUnavailableError", {
  message: Schema.String,
}) {}

export type BackendError = OperatorError | BackendUnavailableError;

export class FactoryBackend extends Context.Service<
  FactoryBackend,
  {
    readonly overview: Effect.Effect<FactoryOverview, BackendError>;
    readonly detail: (
      runId: RunId,
      request: TranscriptRequest,
    ) => Effect.Effect<RunDetailView, BackendError>;
    readonly approve: (runId: RunId) => Effect.Effect<void, BackendError>;
    readonly retry: (runId: RunId) => Effect.Effect<void, BackendError>;
    readonly cancel: (runId: RunId) => Effect.Effect<void, BackendError>;
    readonly moveBoardItem: (move: BoardMove) => Effect.Effect<void, BackendError>;
    readonly pause: (loop: LoopName) => Effect.Effect<void, BackendError>;
    readonly unpause: (loop: LoopName) => Effect.Effect<void, BackendError>;
  }
>()("@usine/server/FactoryBackend") {}

export const liveBackendLayer = (
  instance: LoadedInstance,
  operator: Operator["Service"],
): Layer.Layer<FactoryBackend> =>
  Layer.succeed(FactoryBackend)({
    overview: operator.overview(instance),
    detail: operator.detail,
    approve: operator.approve,
    retry: operator.retry,
    cancel: operator.cancel,
    moveBoardItem: (move) => operator.moveBoardItem(instance, move),
    pause: (loop) => operator.pause(loop).pipe(Effect.asVoid),
    unpause: (loop) => operator.unpause(loop).pipe(Effect.asVoid),
  });

export const needsSetupBackendLayer = (
  instance: LoadedInstance,
  errorTag: string,
  observation: OperatorObservation["Service"],
): Layer.Layer<FactoryBackend> => {
  const unavailable = new BackendUnavailableError({
    message: "GitHub App setup is required before operator actions are available.",
  });
  const overview = observation
    .overview(instance)
    .pipe(
      Effect.map(
        ({ projects, loops, needsYou }) =>
          new NeedsSetupOverview({ errorTag, projects, loops, needsYou }),
      ),
    );
  const fail = () => Effect.fail(unavailable);
  return Layer.succeed(FactoryBackend)({
    overview,
    detail: observation.detail,
    approve: fail,
    retry: fail,
    cancel: fail,
    moveBoardItem: fail,
    pause: fail,
    unpause: fail,
  });
};
