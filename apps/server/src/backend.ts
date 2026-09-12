import type { LoadedInstance } from "@usine/config/instance";
import { LoopName } from "@usine/core/loop";
import { CycleBudgetAskId } from "@usine/core/cycle-budget";
import { RunId } from "@usine/core/run";
import { AgentName } from "@usine/core/agent";
import {
  type BoardMove,
  type FactoryOverview,
  NeedsSetupOverview,
  type RunDetailView,
  type TranscriptRequest,
  type Operator,
  type OperatorError,
  type OperatorObservation,
  type EditAndRetry,
  type SessionIntervention,
} from "@usine/orchestrator/operator";
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
    readonly resetCycleBudget: (askId: CycleBudgetAskId) => Effect.Effect<void, BackendError>;
    readonly retry: (runId: RunId) => Effect.Effect<void, BackendError>;
    readonly agents: Effect.Effect<ReadonlyArray<AgentName>, BackendError>;
    readonly editAndRetry: (runId: RunId, edit: EditAndRetry) => Effect.Effect<void, BackendError>;
    readonly intervene: (
      runId: RunId,
      input: SessionIntervention,
    ) => Effect.Effect<void, BackendError>;
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
    resetCycleBudget: operator.resetCycleBudget,
    retry: operator.retry,
    agents: Effect.succeed(instance.agents.map(({ name }) => name)),
    editAndRetry: (runId, edit) => operator.editAndRetry(instance, runId, edit),
    intervene: (runId, input) => operator.intervene(instance, runId, input),
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
    resetCycleBudget: fail,
    retry: fail,
    agents: Effect.succeed(instance.agents.map(({ name }) => name)),
    editAndRetry: fail,
    intervene: fail,
    cancel: fail,
    moveBoardItem: fail,
    pause: fail,
    unpause: fail,
  });
};
