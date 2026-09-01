import type { LoadedInstance } from "@usine/config";
import { Loop, Run } from "@usine/core";
import type {
  FactoryOverview,
  Operator,
  OperatorObservation,
  OperatorError,
  RunDetailView,
  TranscriptCursor,
} from "@usine/orchestrator";
import { NeedsSetupOverview } from "@usine/orchestrator";
import { Context, Effect, Layer, Option, Schema } from "effect";

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
      runId: Run.RunId,
      after: Option.Option<TranscriptCursor>,
    ) => Effect.Effect<RunDetailView, BackendError>;
    readonly approve: (runId: Run.RunId) => Effect.Effect<void, BackendError>;
    readonly retry: (runId: Run.RunId) => Effect.Effect<void, BackendError>;
    readonly cancel: (runId: Run.RunId) => Effect.Effect<void, BackendError>;
    readonly pause: (loop: Loop.LoopName) => Effect.Effect<void, BackendError>;
    readonly unpause: (loop: Loop.LoopName) => Effect.Effect<void, BackendError>;
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
    pause: (loop) => operator.pause(loop).pipe(Effect.asVoid),
    unpause: (loop) => operator.unpause(loop).pipe(Effect.asVoid),
  });

export const needsSetupBackendLayer = (
  instance: LoadedInstance,
  errorTag: string,
  message: string,
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
          new NeedsSetupOverview({ errorTag, message, projects, loops, needsYou }),
      ),
    );
  const fail = () => Effect.fail(unavailable);
  return Layer.succeed(FactoryBackend)({
    overview,
    detail: observation.detail,
    approve: fail,
    retry: fail,
    cancel: fail,
    pause: fail,
    unpause: fail,
  });
};
