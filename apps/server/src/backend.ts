import type { WorkerPreflightView } from "@usine/orchestrator/operator";
import { resolveLoopName } from "@usine/config/project";
import { requestActor } from "@usine/core/operator";
import {
  AttentionAcknowledgement,
  type AttentionAcknowledgements,
  type AttentionKey,
} from "@usine/engine/attention";
import { LoopName } from "@usine/core/loop";
import { CycleBudgetAskId } from "@usine/core/cycle-budget";
import { AttemptId } from "@usine/core/attempt";
import { RunId } from "@usine/core/run";
import { AgentName } from "@usine/core/agent";
import type { RunAgainResult } from "@usine/engine/engine";
import type { CurrentInstance } from "@usine/orchestrator/current-instance";
import type { WorkerName } from "@usine/core/worker";
import {
  type BoardMove,
  type ConfigurationView,
  type DeskView,
  type FactoryOverview,
  NeedsSetupOverview,
  type RunDetailView,
  type RunGitHubChangesView,
  type TranscriptRequest,
  type Operator,
  type OperatorConfiguration,
  type OperatorError,
  LoopNotFoundError,
  type OperatorObservation,
  type EditAndRetry,
  type SessionIntervention,
  type RunStatisticsView,
  type StatisticsView,
  type StatisticsWindow,
  type TaskView,
} from "@usine/orchestrator/operator";
import type { ItemNumber } from "@usine/core/item";
import type { RepositoryName } from "@usine/core/repository";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";

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
    readonly githubChanges: (runId: RunId) => Effect.Effect<RunGitHubChangesView, BackendError>;
    readonly approve: (runId: RunId) => Effect.Effect<void, BackendError>;
    readonly dismissNeed: (key: AttentionKey) => Effect.Effect<void, BackendError>;
    readonly undoDismissNeed: (key: AttentionKey) => Effect.Effect<void, BackendError>;
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
    readonly runWorkerPreflight: (
      worker: WorkerName,
    ) => Effect.Effect<WorkerPreflightView, BackendError>;
    readonly discardLeftovers: (worker: WorkerName) => Effect.Effect<void, BackendError>;
    readonly moveBoardItem: (move: BoardMove) => Effect.Effect<void, BackendError>;
    readonly pause: (loop: LoopName) => Effect.Effect<void, BackendError>;
    readonly unpause: (loop: LoopName) => Effect.Effect<void, BackendError>;

    readonly task: (
      repository: RepositoryName,
      item: ItemNumber,
    ) => Effect.Effect<TaskView, BackendError>;
    readonly configuration: Effect.Effect<ConfigurationView, BackendError>;
    readonly desk: Effect.Effect<DeskView, BackendError>;
    readonly statistics: (window: StatisticsWindow) => Effect.Effect<StatisticsView, BackendError>;
    readonly runStatistics: (
      window: StatisticsWindow,
    ) => Effect.Effect<RunStatisticsView, BackendError>;
  }
>()("@usine/server/FactoryBackend") {}

type BackendInstance = Pick<CurrentInstance["Service"], "get">;

const rosterOf = (instances: BackendInstance) =>
  Effect.map(instances.get, ({ agents }) => agents.map(({ name }) => name));

const loopOf = Effect.fn("FactoryBackend.resolveLoop")(function* (
  instances: BackendInstance,
  loop: LoopName,
) {
  yield* Effect.annotateCurrentSpan({ loop });
  const instance = yield* instances.get;
  const name = resolveLoopName(instance.loops, loop);
  if (Option.isNone(name))
    return yield* new LoopNotFoundError({
      loop,
      message: "Loop is missing or ambiguous. Use project/loop.",
    });
  return name.value;
});

/** Provides the backend of a running factory, which reads the current instance on each request. */
export const liveBackendLayer = (
  instances: BackendInstance,
  operator: Operator["Service"],
  configuration: OperatorConfiguration["Service"],
): Layer.Layer<FactoryBackend> =>
  Layer.succeed(FactoryBackend)({
    overview: Effect.flatMap(instances.get, operator.overview),
    detail: (runId, request) =>
      Effect.flatMap(instances.get, (instance) => operator.detail(instance, runId, request)),
    githubChanges: (runId) =>
      Effect.flatMap(instances.get, (instance) => operator.githubChanges(instance, runId)),
    approve: (runId) =>
      Effect.flatMap(instances.get, (instance) => operator.approve(instance, runId)),
    dismissNeed: (key) =>
      Effect.flatMap(instances.get, (instance) => operator.dismissNeed(instance, key)),
    undoDismissNeed: operator.undoDismissNeed,
    resetCycleBudget: operator.resetCycleBudget,
    retry: (runId) => Effect.flatMap(instances.get, (instance) => operator.retry(instance, runId)),
    resolveFailure: (runId, attemptId) =>
      Effect.flatMap(instances.get, (instance) =>
        operator.resolveFailure(instance, runId, attemptId),
      ),
    agents: rosterOf(instances),
    editAndRetry: (runId, edit) =>
      Effect.flatMap(instances.get, (instance) => operator.editAndRetry(instance, runId, edit)),
    runAgain: (runId, edit) =>
      Effect.flatMap(instances.get, (instance) => operator.runAgain(instance, runId, edit)),
    intervene: (runId, input) =>
      Effect.flatMap(instances.get, (instance) => operator.intervene(instance, runId, input)),
    cancel: operator.cancel,
    runWorkerPreflight: operator.runWorkerPreflight,
    discardLeftovers: operator.discardLeftovers,
    moveBoardItem: (move) =>
      Effect.flatMap(instances.get, (instance) => operator.moveBoardItem(instance, move)),
    pause: (loop) => loopOf(instances, loop).pipe(Effect.flatMap(operator.pause), Effect.asVoid),
    unpause: (loop) =>
      loopOf(instances, loop).pipe(Effect.flatMap(operator.unpause), Effect.asVoid),

    task: (repository, item) =>
      Effect.flatMap(instances.get, (instance) => operator.task(instance, repository, item)),
    configuration: Effect.flatMap(instances.get, configuration.view),
    desk: Effect.flatMap(instances.get, operator.desk),
    statistics: (window) =>
      Effect.flatMap(instances.get, (instance) => operator.statistics(instance, window)),
    runStatistics: (window) =>
      Effect.flatMap(instances.get, (instance) => operator.runStatistics(instance, window)),
  });

/**
 * Provides observation, configuration, and attention acknowledgements during setup. Run
 * actions fail with `BackendUnavailableError`.
 */
export const needsSetupBackendLayer = (
  instances: BackendInstance,
  errorTag: string,
  observation: OperatorObservation["Service"],
  configuration: OperatorConfiguration["Service"],
  acknowledgements: AttentionAcknowledgements["Service"],
): Layer.Layer<FactoryBackend> => {
  const unavailable = new BackendUnavailableError({
    message: "The GitHub App is not set up. Set it up to use operator actions.",
  });
  const overview = Effect.flatMap(instances.get, observation.overview).pipe(
    Effect.map(
      ({ projects, loops, needsYou, dismissedNeeds }) =>
        new NeedsSetupOverview({ errorTag, projects, loops, needsYou, dismissedNeeds }),
    ),
  );
  const fail = () => Effect.fail(unavailable);
  return Layer.succeed(FactoryBackend)({
    overview,
    detail: (runId, request) =>
      Effect.flatMap(instances.get, (instance) => observation.detail(instance, runId, request)),
    githubChanges: fail,
    approve: fail,
    resetCycleBudget: fail,
    dismissNeed: Effect.fn("FactoryBackend.dismissNeed")(function* (key) {
      yield* Effect.annotateCurrentSpan({ needId: key.id });
      const instance = yield* instances.get;
      yield* acknowledgements.dismiss(
        new AttentionAcknowledgement({
          ...key,
          dismissedBy: yield* requestActor(instance.config.operator),
          dismissedAt: yield* DateTime.now,
        }),
      );
    }),
    undoDismissNeed: acknowledgements.undo,
    retry: fail,
    resolveFailure: fail,
    agents: rosterOf(instances),
    editAndRetry: fail,
    runAgain: fail,
    intervene: fail,
    cancel: fail,
    runWorkerPreflight: fail,
    discardLeftovers: fail,
    moveBoardItem: fail,
    pause: fail,
    unpause: fail,

    task: (repository, item) =>
      Effect.flatMap(instances.get, (instance) => observation.task(instance, repository, item)),
    configuration: Effect.flatMap(instances.get, configuration.view),
    desk: Effect.flatMap(instances.get, observation.desk),
    statistics: (window) =>
      Effect.flatMap(instances.get, (instance) => observation.statistics(instance, window)),
    runStatistics: (window) =>
      Effect.flatMap(instances.get, (instance) => observation.runStatistics(instance, window)),
  });
};
