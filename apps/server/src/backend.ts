import { LoopName } from "@usine/core/loop";
import { CycleBudgetAskId } from "@usine/core/cycle-budget";
import { AttemptId } from "@usine/core/attempt";
import { RunId } from "@usine/core/run";
import { AgentName } from "@usine/core/agent";
import type { RunAgainResult } from "@usine/engine/engine";
import type {
  CurrentInstance,
  InstanceReload,
  InstanceReloadError,
} from "@usine/orchestrator/current-instance";
import type { WorkerName } from "@usine/core/worker";
import {
  type BoardMove,
  type FactoryOverview,
  NeedsSetupOverview,
  type RunDetailView,
  type RunGitHubChangesView,
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

export type BackendError = OperatorError | BackendUnavailableError | InstanceReloadError;

export class FactoryBackend extends Context.Service<
  FactoryBackend,
  {
    readonly overview: Effect.Effect<FactoryOverview, BackendError>;
    readonly detail: (
      runId: RunId,
      request: TranscriptRequest,
    ) => Effect.Effect<RunDetailView, BackendError>;
    readonly githubChanges: (runId: RunId) => Effect.Effect<RunGitHubChangesView, BackendError>;
    readonly approve: (runId: RunId) => Effect.Effect<void, BackendError>;
    readonly resetCycleBudget: (askId: CycleBudgetAskId) => Effect.Effect<void, BackendError>;
    readonly resolveFailure: (
      runId: RunId,
      attemptId: AttemptId,
    ) => Effect.Effect<void, BackendError>;
    readonly retry: (runId: RunId) => Effect.Effect<void, BackendError>;
    readonly agents: Effect.Effect<ReadonlyArray<AgentName>, BackendError>;
    readonly editAndRetry: (runId: RunId, edit: EditAndRetry) => Effect.Effect<void, BackendError>;
    readonly runAgain: (
      runId: RunId,
      edit: EditAndRetry,
    ) => Effect.Effect<RunAgainResult, BackendError>;
    readonly intervene: (
      runId: RunId,
      input: SessionIntervention,
    ) => Effect.Effect<void, BackendError>;
    readonly cancel: (runId: RunId) => Effect.Effect<void, BackendError>;
    readonly discardLeftovers: (worker: WorkerName) => Effect.Effect<void, BackendError>;
    readonly moveBoardItem: (move: BoardMove) => Effect.Effect<void, BackendError>;
    readonly pause: (loop: LoopName) => Effect.Effect<void, BackendError>;
    readonly unpause: (loop: LoopName) => Effect.Effect<void, BackendError>;
    readonly reload: Effect.Effect<InstanceReload, BackendError>;
  }
>()("@usine/server/FactoryBackend") {}

/** The parts of `CurrentInstance` the operator backend reads. */
type BackendInstance = Pick<CurrentInstance["Service"], "get" | "reload">;

const rosterOf = (instances: BackendInstance) =>
  Effect.map(instances.get, ({ agents }) => agents.map(({ name }) => name));

/** The backend of a running factory; every request reads the current instance. */
export const liveBackendLayer = (
  instances: BackendInstance,
  operator: Operator["Service"],
): Layer.Layer<FactoryBackend> =>
  Layer.succeed(FactoryBackend)({
    overview: Effect.flatMap(instances.get, operator.overview),
    detail: operator.detail,
    githubChanges: operator.githubChanges,
    approve: (runId) =>
      Effect.flatMap(instances.get, (instance) => operator.approve(instance, runId)),
    resetCycleBudget: operator.resetCycleBudget,
    retry: operator.retry,
    resolveFailure: operator.resolveFailure,
    agents: rosterOf(instances),
    editAndRetry: (runId, edit) =>
      Effect.flatMap(instances.get, (instance) => operator.editAndRetry(instance, runId, edit)),
    runAgain: (runId, edit) =>
      Effect.flatMap(instances.get, (instance) => operator.runAgain(instance, runId, edit)),
    intervene: (runId, input) =>
      Effect.flatMap(instances.get, (instance) => operator.intervene(instance, runId, input)),
    cancel: operator.cancel,
    discardLeftovers: operator.discardLeftovers,
    moveBoardItem: (move) =>
      Effect.flatMap(instances.get, (instance) => operator.moveBoardItem(instance, move)),
    pause: (loop) => operator.pause(loop).pipe(Effect.asVoid),
    unpause: (loop) => operator.unpause(loop).pipe(Effect.asVoid),
    reload: instances.reload,
  });

/** The read-only backend of setup mode; reading the overview and reloading the instance folder still work. */
export const needsSetupBackendLayer = (
  instances: BackendInstance,
  errorTag: string,
  observation: OperatorObservation["Service"],
): Layer.Layer<FactoryBackend> => {
  const unavailable = new BackendUnavailableError({
    message: "GitHub App setup is required before operator actions are available.",
  });
  const overview = Effect.flatMap(instances.get, observation.overview).pipe(
    Effect.map(
      ({ projects, loops, needsYou }) =>
        new NeedsSetupOverview({ errorTag, projects, loops, needsYou }),
    ),
  );
  const fail = () => Effect.fail(unavailable);
  return Layer.succeed(FactoryBackend)({
    overview,
    detail: observation.detail,
    githubChanges: fail,
    approve: fail,
    resetCycleBudget: fail,
    retry: fail,
    resolveFailure: fail,
    agents: rosterOf(instances),
    editAndRetry: fail,
    runAgain: fail,
    intervene: fail,
    cancel: fail,
    discardLeftovers: fail,
    moveBoardItem: fail,
    pause: fail,
    unpause: fail,
    reload: instances.reload,
  });
};
