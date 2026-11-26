import { jsonKey } from "@usine/core/json-key";
import { AccessDenied, InstanceScope, requirePermission } from "@usine/core/access";
import { filterOverview, loopScope, repositoryScope } from "./access.ts";
import { CallScopeTarget, type ResolvedCall } from "./call-scope.ts";
export { CallScopeTarget, type ResolvedCall } from "./call-scope.ts";
export { entityRequirement } from "./access.ts";
import { ExpressionEngine } from "@usine/expression/expression-engine";
import { approvalFor } from "../approval.ts";
import { WorkerPreflightView, workerPreflightView } from "./preflight.ts";
export { WorkerPreflightView } from "./preflight.ts";
import { WebhookHealth } from "../webhooks.ts";
import { CiMonitor, type CiLabelExpressionError, type CiNotPassedError } from "../ci.ts";
import type { ConfigurationStoreError } from "@usine/config/configuration";
import { boardRepositories, resolveLoopName } from "@usine/config/project";
import { requestActor } from "@usine/core/operator";
import {
  AttentionAcknowledgements,
  AttentionAcknowledgement,
  type AttentionKey,
} from "@usine/engine/attention";
import { attentionAudiences, taskNeedsAttention } from "./attention.ts";
import { TranscriptSequence } from "@usine/engine/transcript";
import { BillingPools } from "@usine/core/agent/pool";
import { AttemptContext, AttemptId } from "@usine/core/attempt";
import { Intervention } from "@usine/core/attempt/channel";
import type { LoadedInstance } from "@usine/config/instance";
import { loopCiPolicy } from "@usine/config/loop";
import { Event, DedupKey, EventId } from "@usine/core/event";
import { CycleBudgetAskId } from "@usine/core/cycle-budget";
import { BoardMoveRecord, BoardMoves } from "@usine/engine/board-moves";
import { CycleBudgets, CycleBudgetResetRejectedError } from "@usine/engine/cycle-budget";
import { LoopName } from "@usine/core/loop";
import { RunId } from "@usine/core/run";
import { ApprovalSource } from "@usine/core/run/approval";
import type { WorkerName } from "@usine/core/worker";
import { type ItemNumber } from "@usine/core/item";
import { canonicalRepositoryName, type RepositoryName } from "@usine/core/repository";
import {
  RetryRequest,
  RunAgainRequest,
  type RunAgainResult,
  RunEngine,
  type EnginePersistenceError,
  type LeftoversDiscardRejectedError,
  type RunEngineError,
  RunOperationRejectedError,
  type RunStoreError,
} from "@usine/engine/engine";
import { type ItemProjection, ItemProjectionReader } from "@usine/engine/item-projection";
import { LoopControl, type LoopRuntimeState } from "@usine/engine/loop-control";
import { RunReader } from "@usine/engine/run-reader";
import { RepositoryLabelProjectionReader } from "@usine/engine/repository-label-projection";
import { GitHubItemWriter } from "@usine/github/item-writer";
import type { GitHubAppError } from "@usine/github/github-app";
import { ChangedIssue, ChangedPullRequest } from "@usine/github/polling";
import { Context, DateTime, Effect, Exit, Layer, Match, Option, Result } from "effect";
import { readBoardItems } from "../board/selection.ts";
import { projectedItem } from "../board/items.ts";
import { type ItemEntryCursor, itemPage, type ItemView } from "./item.ts";
import { labelMutationForBoardMove, projectBoard } from "../board/projection.ts";
import { LoopMatches } from "../loop-matches.ts";
import { PollingTriggers } from "../polling-triggers.ts";
import { cycleLimitOf } from "../trigger-submission.ts";
import { CycleBudgetResetView } from "./need.ts";
import {
  type BoardItemNotFoundError,
  BoardItemNotFoundError as BoardItemNotFound,
  type BoardLaneNotFoundError,
  BoardLaneNotFoundError as BoardLaneNotFound,
  type BoardLaneReadOnlyError,
  BoardLaneReadOnlyError as BoardLaneReadOnly,
  type BoardMove,
  type BoardProjectNotFoundError,
  BoardProjectNotFoundError as BoardProjectNotFound,
} from "./board.ts";
import { TranscriptAttemptNotFoundError, type TranscriptRequest } from "./transcript.ts";
import {
  RunBriefView,
  type RunTextPart,
  RunTextPageView,
  RunTranscriptPageView,
} from "./run-pages/view.ts";
import { ReadyOverview } from "./overview/view.ts";
import {
  RunDetailView,
  EditAndRetry,
  LoopNotFoundError,
  SessionIntervention,
  RosterAgentNotFoundError,
} from "./run.ts";
import { readRunningEvents, runSummaryView, declaredWorkers } from "./projection.ts";
import { RunUsageReader } from "./usage.ts";
import {
  RunGitHubChanges,
  type RunGitHubChangesError,
  type RunGitHubChangesView,
} from "./github-changes.ts";
import { TaskReader, type TaskReadDepth, type TaskReadError, TaskView } from "./task.ts";
import { type DeskView, OperatorDesk } from "./desk.ts";
import { OperatorStatistics } from "./statistics/statistics.ts";
import type { RunStatisticsView, StatisticsView, StatisticsWindow } from "./statistics/view.ts";
import { WorkerStatus, type WorkerPreflightRejectedError } from "../worker-status.ts";

import { OverviewReader } from "./overview/overview.ts";
import { RunPages } from "./run-pages/run-pages.ts";
/** A refused board move, failed label write, or failure to read or record the move. */
export type BoardMoveError =
  | AccessDenied
  | BoardItemNotFoundError
  | BoardLaneNotFoundError
  | BoardLaneReadOnlyError
  | BoardProjectNotFoundError
  | EnginePersistenceError
  | RunStoreError
  | GitHubAppError;
/** A failure to observe or change runs, tasks, loop state, or operator acknowledgements. */
export type OperatorError =
  | AccessDenied
  | CiNotPassedError
  | CiLabelExpressionError
  | WorkerPreflightRejectedError
  | LoopNotFoundError
  | RosterAgentNotFoundError
  | RunEngineError
  | LeftoversDiscardRejectedError
  | TranscriptAttemptNotFoundError
  | BoardMoveError
  | CycleBudgetResetRejectedError
  | RunGitHubChangesError
  | ConfigurationStoreError;
/** A failure to read stored operator views or locate a requested transcript attempt. */
export type OperatorObservationError =
  | AccessDenied
  | RunStoreError
  | TranscriptAttemptNotFoundError
  | ConfigurationStoreError;

const makeOperatorObservation = Effect.gen(function* () {
  const itemReader = yield* ItemProjectionReader;
  const { read: overview } = yield* OverviewReader;
  const pages = yield* RunPages;

  const tasks = yield* TaskReader;
  const { desk } = yield* OperatorDesk;
  const { statistics, runStatistics } = yield* OperatorStatistics;

  const task = Effect.fn("Operator.task")(function* (
    instance: LoadedInstance,
    repository: RepositoryName,
    item: ItemNumber,
    depth: TaskReadDepth,
  ) {
    yield* Effect.annotateCurrentSpan({ repository, item, depth });
    yield* requirePermission("read", repositoryScope(instance, repository));
    const [view, current] = yield* Effect.all(
      [tasks.read(instance, repository, item, depth), overview(instance)],
      { concurrency: "unbounded" },
    );
    return TaskView.make({ ...view, needsYou: taskNeedsAttention(view, current.needsYou) });
  });
  const item = Effect.fn("Operator.item")(function* (
    instance: LoadedInstance,
    repository: RepositoryName,
    number: ItemNumber,
    cursor: ItemEntryCursor,
  ) {
    yield* Effect.annotateCurrentSpan({ repository, item: number, ...cursor });
    yield* requirePermission("read", repositoryScope(instance, repository));
    const current = yield* overview(instance);
    const canonical = canonicalRepositoryName(repository);
    const project = current.projects.find((project) =>
      [project.repository, ...project.repositories].some(
        (name) => canonicalRepositoryName(name) === canonical,
      ),
    );
    if (project === undefined) {
      yield* Effect.logInfo("Item read refused; the repository is not a registered Project", {
        repository,
        item: number,
      });
      return yield* BoardProjectNotFound.make({ repository });
    }
    const link = project.board.lanes
      .flatMap(({ items }) => items)
      .filter((task) => canonicalRepositoryName(task.repository) === canonical)
      .flatMap((task) => task.items)
      .find((link) => link.number === number);
    const stored =
      link === undefined ? Option.none<ItemProjection>() : yield* itemReader.get(link.itemKey);
    if (Option.isNone(stored)) {
      yield* Effect.logInfo("Item read found no stored Item on the Board", {
        repository,
        item: number,
        onBoard: link !== undefined,
      });
      return yield* BoardItemNotFound.make({ repository, item: number });
    }
    const projected = yield* Effect.result(projectedItem(stored.value));
    if (Result.isFailure(projected)) {
      yield* Effect.logError("Stored Item payload doesn't decode; the Item can't be read", {
        repository,
        item: number,
        message: projected.failure.message,
      });
      return yield* BoardItemNotFound.make({ repository, item: number });
    }
    const view = itemPage(stored.value, projected.success, cursor);
    yield* Effect.logDebug("Read an Item", {
      repository,
      item: number,
      entries: view.entries.length,
      entriesTotal: view.entriesTotal,
      omitted: view.omitted,
      next: view.next,
    });
    return view;
  });

  return {
    ...pages,
    overview: (instance: LoadedInstance) =>
      overview(instance).pipe(Effect.flatMap((view) => filterOverview(instance, view))),
    task,
    item,
    desk,
    statistics,
    runStatistics,
  } as const;
});

/** The read-only operator surface, which needs no trigger execution. */
export class OperatorObservation extends Context.Service<
  OperatorObservation,
  {
    /**
     * Builds the instance's Projects, Boards, Runs, and items needing operator attention. The
     * result is cached until the projection revision or instance changes, except for running
     * Attempts' token usage.
     */
    readonly overview: (
      instance: LoadedInstance,
    ) => Effect.Effect<ReadyOverview, OperatorObservationError>;
    /**
     * Reads one Run and a bounded transcript page, where `request` selects the latest, newer, or
     * earlier activity.
     */
    readonly detail: (
      instance: LoadedInstance,
      runId: RunId,
      request?: TranscriptRequest,
    ) => Effect.Effect<RunDetailView, OperatorObservationError>;

    /**
     * Reads the Task that contains Item `item` of `repository`, with its Items and saved Runs, and
     * at the `results` depth the comments and commit ranges of its Runs. Fails if the Item isn't
     * among the Board's newest Items.
     */
    readonly task: (
      instance: LoadedInstance,
      repository: RepositoryName,
      item: ItemNumber,
      depth: TaskReadDepth,
    ) => Effect.Effect<TaskView, TaskReadError | AccessDenied>;
    /**
     * Reads the Run without its event payload and transcript, with the beginnings of its task
     * prompt, result message, and newest kept report.
     */
    readonly brief: (
      instance: LoadedInstance,
      runId: RunId,
    ) => Effect.Effect<RunBriefView, OperatorObservationError>;
    /**
     * Reads the page of one of the Run's texts from `offset`. For `report`, reads the report of
     * `attempt`, or of the newest Attempt that kept one.
     */
    readonly runText: (
      instance: LoadedInstance,
      runId: RunId,
      part: RunTextPart,
      attempt: Option.Option<AttemptId>,
      offset: number,
    ) => Effect.Effect<RunTextPageView, OperatorObservationError>;
    /**
     * Reads a page of `attempt`'s transcript, or the newest Attempt's, newest entry first: from the
     * newest entry before `before`, starting `offset` into that entry's text.
     */
    readonly transcriptPage: (
      instance: LoadedInstance,
      runId: RunId,
      attempt: Option.Option<AttemptId>,
      before: Option.Option<TranscriptSequence>,
      offset: number,
    ) => Effect.Effect<RunTranscriptPageView, OperatorObservationError>;
    /**
     * Reads Item `item` of `repository` as polling last stored it, with the page of its body,
     * comments, and reviews from `cursor`. Fails if the Item isn't on its Project's Board.
     */
    readonly item: (
      instance: LoadedInstance,
      repository: RepositoryName,
      item: ItemNumber,
      cursor: ItemEntryCursor,
    ) => Effect.Effect<ItemView, OperatorObservationError | TaskReadError>;
    /**
     * Builds the instance's desk: running Attempts, matched Items with no running Attempt, recently
     * closed Runs, Worker slots and preflights, and poll times.
     */
    readonly desk: (instance: LoadedInstance) => Effect.Effect<DeskView, OperatorObservationError>;
    /**
     * Computes the tasks done in `window`: their count and duration from first Run to merge, the
     * split of that time and of their tokens by Loop, the first-time-right share, and the operator
     * actions per task.
     */
    readonly statistics: (
      instance: LoadedInstance,
      window: StatisticsWindow,
    ) => Effect.Effect<StatisticsView, OperatorObservationError>;
    /**
     * Computes how the Runs went in `window`: closed Runs by outcome, Loop, Agent, and brain, with
     * time, tokens, and cost, and the throughput, Worker, retry, and Needs attention measures.
     */
    readonly runStatistics: (
      instance: LoadedInstance,
      window: StatisticsWindow,
    ) => Effect.Effect<RunStatisticsView, OperatorObservationError>;
  }
>()("@usine/orchestrator/operator/operator/OperatorObservation") {
  /**
   * Provides read-only operator views from stored runs, configuration, trigger status, and worker
   * status.
   */
  static readonly layer = Layer.effect(OperatorObservation, makeOperatorObservation).pipe(
    Layer.provide(
      Layer.mergeAll(
        TaskReader.layer,
        OperatorDesk.layer,
        OverviewReader.layer.pipe(
          Layer.provide(
            Layer.mergeAll(RunUsageReader.layer, LoopMatches.layer, WebhookHealth.layer),
          ),
        ),
        // The Run pages and statistics share the overview's usage reader, so each ended Attempt's
        // reports are read once.
        RunPages.layer.pipe(Layer.provide(RunUsageReader.layer)),
        OperatorStatistics.layer.pipe(Layer.provide(RunUsageReader.layer)),
      ),
    ),
  );
}

const makeOperator = Effect.gen(function* () {
  const expressions = yield* ExpressionEngine;
  const workerStatus = yield* WorkerStatus;
  const acknowledgements = yield* AttentionAcknowledgements;
  const budgets = yield* CycleBudgets;
  const observation = yield* OperatorObservation;
  const runs = yield* RunEngine;
  const controls = yield* LoopControl;
  const items = yield* ItemProjectionReader;
  const repositoryLabels = yield* RepositoryLabelProjectionReader;
  const github = yield* GitHubItemWriter;
  const reader = yield* RunReader;
  const boardMoves = yield* BoardMoves;
  const polling = yield* PollingTriggers;
  const githubChanges = yield* RunGitHubChanges;
  const ci = yield* CiMonitor;
  const pools = yield* BillingPools;
  const scope = yield* Effect.scope;

  const dismissNeed = Effect.fn("Operator.dismissNeed")(function* (
    instance: LoadedInstance,
    key: AttentionKey,
  ) {
    yield* requirePermission("admin", InstanceScope.make());
    yield* Effect.annotateCurrentSpan({ needId: key.id });

    yield* acknowledgements.dismiss(
      AttentionAcknowledgement.make({
        ...key,
        dismissedBy: yield* requestActor(instance.config.operator),
        dismissedAt: yield* DateTime.now,
      }),
      attentionAudiences(key),
    );
  });
  const undoDismissNeed = Effect.fn("Operator.undoDismissNeed")(function* (key: AttentionKey) {
    yield* requirePermission("admin", InstanceScope.make());
    yield* Effect.annotateCurrentSpan({ needId: key.id });
    yield* acknowledgements.undo(key, attentionAudiences(key));
  });

  const requireRunOperation = Effect.fn("Operator.requireRunOperation")(function* (
    instance: LoadedInstance,
    runId: RunId,
  ) {
    const { repository } = yield* reader.inspect(runId);
    yield* Effect.annotateCurrentSpan({ runId, repository });
    yield* requirePermission("operate", repositoryScope(instance, repository));
  });

  const approve = Effect.fn("Operator.approve")(function* (instance: LoadedInstance, runId: RunId) {
    yield* requireRunOperation(instance, runId);
    yield* Effect.annotateCurrentSpan({ runId });
    const current = yield* runs.inspect(runId);
    if (current.run.state._tag !== "Waiting") {
      yield* Effect.logInfo("Operator approval rejected; the Run is past its gate", {
        runId,
        state: current.run.state._tag,
      });
      return yield* RunOperationRejectedError.make({
        runId,
        operation: "approve",
        state: current.run.state._tag,
      });
    }
    const receivedAt = yield* DateTime.now;
    const dedupKeyJson = jsonKey(["operator-approval", runId]);
    const dedupKey = DedupKey.make(dedupKeyJson);

    yield* runs.approve(
      runId,
      Event.make({
        id: EventId.make(dedupKey),
        dedupKey,
        payload: { runId, decision: "approved" },
        receivedAt,
      }),
      ApprovalSource.make({
        channel: "ui",
        approver: yield* requestActor(instance.config.operator),
      }),
    );
    yield* Effect.logInfo("Operator approved Run", { runId });
  });

  const resolveFailure = Effect.fn("Operator.resolveFailure")(function* (
    instance: LoadedInstance,
    runId: RunId,
    attemptId: AttemptId,
  ) {
    yield* requireRunOperation(instance, runId);
    yield* Effect.annotateCurrentSpan({ runId, attemptId });
    const actor = yield* requestActor(instance.config.operator);
    yield* runs.resolveFailure(runId, attemptId, actor);
  });

  const applyCiLabels = Effect.fn("Operator.applyCiLabels")(function* (
    instance: LoadedInstance,
    runId: RunId,
    attemptId: AttemptId,
  ) {
    yield* requireRunOperation(instance, runId);
    yield* Effect.annotateCurrentSpan({ runId, attemptId });
    const actor = yield* requestActor(instance.config.operator);
    yield* ci.applyLabelsAfterGreen(instance, runId, attemptId, actor);
  });

  const retry = Effect.fn("Operator.retry")(function* (instance: LoadedInstance, runId: RunId) {
    yield* requireRunOperation(instance, runId);
    yield* Effect.annotateCurrentSpan({ runId });

    yield* runs.retry(
      runId,
      RetryRequest.make({
        requestedBy: yield* requestActor(instance.config.operator),
        amendment: Option.none(),
      }),
    );
    yield* Effect.logInfo("Operator retried Run", { runId });
  });

  const editAndRetry = Effect.fn("Operator.editAndRetry")(function* (
    instance: LoadedInstance,
    runId: RunId,
    edit: EditAndRetry,
  ) {
    yield* requireRunOperation(instance, runId);
    yield* Effect.annotateCurrentSpan({ runId, agent: edit.agent });
    const file = instance.agents.find(({ name }) => name === edit.agent);
    if (file === undefined)
      return yield* RosterAgentNotFoundError.make({
        agent: edit.agent,
        message: `Agent "${edit.agent}" is not in the roster`,
      });
    const agent = file.agent;

    yield* runs.retry(
      runId,
      RetryRequest.make({
        requestedBy: yield* requestActor(instance.config.operator),
        amendment: Option.some(AttemptContext.make({ task: edit.task, agent })),
      }),
    );
    yield* Effect.logInfo("Operator amended and retried Run", { runId, agent: agent.name });
  });

  const runAgain = Effect.fn("Operator.runAgain")(function* (
    instance: LoadedInstance,
    runId: RunId,
    edit: EditAndRetry,
  ) {
    yield* requireRunOperation(instance, runId);
    yield* Effect.annotateCurrentSpan({ runId, agent: edit.agent });
    const current = yield* runs.inspect(runId);
    const loop = instance.loops.find(({ name }) => name === current.run.loop);
    if (loop === undefined) {
      yield* Effect.logInfo("Run again rejected; the Run's Loop is not loaded", {
        runId,
        loop: current.run.loop,
      });
      return yield* LoopNotFoundError.make({
        loop: current.run.loop,
        message: `Run ${runId} cannot run again: loop "${current.run.loop}" is not loaded.`,
      });
    }
    const file = instance.agents.find(({ name }) => name === edit.agent);
    if (file === undefined) {
      yield* Effect.logInfo("Run again rejected; the Agent is not in the roster", {
        runId,
        agent: edit.agent,
      });
      return yield* RosterAgentNotFoundError.make({
        agent: edit.agent,
        message: `Agent "${edit.agent}" is not in the roster`,
      });
    }
    const agent = file.agent;

    const result = yield* runs.runAgain(
      runId,
      RunAgainRequest.make({
        step: loop.step,
        ...(yield* approvalFor(
          expressions,
          loop,
          { name: current.repository },
          current.event.payload,
        )),
        cycleLimit: cycleLimitOf(loop),
        permissions: loop.permissions,
        ciPolicy: loopCiPolicy(loop),
        outcomeLabels: loop.outcomeLabels,
        context: AttemptContext.make({ task: edit.task, agent }),
        requestedBy: yield* requestActor(instance.config.operator),
      }),
    );
    yield* Effect.logInfo(
      "Operator ran a Run again",
      Match.valueTags(result, {
        Claimed: ({ runId: openedRunId }) => ({ runId, agent: agent.name, openedRunId }),
        CycleBlocked: ({ ask }) => ({ runId, agent: agent.name, askId: ask.id }),
      }),
    );
    return result;
  });

  const intervene = Effect.fn("Operator.intervene")(function* (
    instance: LoadedInstance,
    runId: RunId,
    input: SessionIntervention,
  ) {
    yield* requireRunOperation(instance, runId);
    yield* Effect.annotateCurrentSpan({
      runId,
      attemptId: input.attemptId,
      action: input.action._tag,
    });
    const actor = yield* requestActor(instance.config.operator);
    yield* runs.intervene(
      runId,
      input.attemptId,
      Intervention.make({
        operator: Option.getOrElse(actor, () => "local operator"),
        target: input.target,
        action: input.action,
      }),
    );
  });

  const cancel = Effect.fn("Operator.cancel")(function* (instance: LoadedInstance, runId: RunId) {
    yield* requireRunOperation(instance, runId);
    yield* Effect.annotateCurrentSpan({ runId });
    yield* runs.cancel(runId);
    yield* Effect.logInfo("Operator canceled Run", { runId });
  });

  const pause = Effect.fn("Operator.pause")(function* (loop: LoopName) {
    yield* requirePermission("operate", loopScope(loop));
    yield* Effect.annotateCurrentSpan({ loop });
    return yield* controls.pause(loop);
  });
  const unpause = Effect.fn("Operator.unpause")(function* (loop: LoopName) {
    yield* requirePermission("operate", loopScope(loop));
    yield* Effect.annotateCurrentSpan({ loop });
    const state = yield* controls.unpause(loop);
    // A paused Loop holds its queued CI fixes; admit them now instead of at the next reconcile.
    // The request doesn't wait for their GitHub rechecks.
    yield* runs.admitCiFixes.pipe(
      Effect.tapError((error) =>
        Effect.logWarning(
          "Could not admit the queued CI fixes after unpausing the Loop; the periodic reconcile retries them",
          { loop, errorTag: error._tag },
        ),
      ),
      Effect.ignore,
      Effect.forkIn(scope),
    );
    return state;
  });

  const moveBoardItem = Effect.fn("Operator.moveBoardItem")(
    function* (instance: LoadedInstance, move: BoardMove) {
      yield* requirePermission("operate", repositoryScope(instance, move.repository));
      yield* Effect.annotateCurrentSpan({
        repository: move.repository,
        item: move.item,
        lane: move.toLane,
      });
      const repository = boardRepositories(instance.config).find(
        ({ name }) => canonicalRepositoryName(name) === canonicalRepositoryName(move.repository),
      );
      if (repository === undefined) {
        return yield* BoardProjectNotFound.make({ repository: move.repository });
      }
      const [storedItems, labelProjection] = yield* Effect.all(
        [
          reader
            .list({ closedLimit: 0 })
            .pipe(Effect.flatMap((runs) => readBoardItems(items, repository.name, runs))),
          repositoryLabels.get(move.repository),
        ] as const,
        { concurrency: "unbounded" },
      );
      // Place each card as the Board does, so the move records the lane that the card left.
      const summaries = yield* reader.forItems(storedItems.map(({ itemKey }) => itemKey));
      const runEvents = yield* readRunningEvents(reader, summaries);
      const runWorkers = declaredWorkers(instance.config.workers);
      const board = yield* projectBoard(
        repository,
        Option.match(labelProjection, {
          onNone: () => [],
          onSome: ({ labels }) => labels.map(({ name }) => name),
        }),
        storedItems,
        // Placement reads no pause state, so these views leave every Loop unpaused.
        summaries.map((summary) => runSummaryView(summary, new Set(), runWorkers)),
        pools,
        [],
        new Map(),
        new Map(),
        runEvents,
      );
      const source = board.lanes.find(({ items: laneItems }) =>
        laneItems.some(({ items }) => items.some(({ number }) => number === move.item)),
      );
      const movedItem = storedItems.find(({ number }) => number === move.item);
      if (source === undefined || movedItem === undefined) {
        return yield* BoardItemNotFound.make({ repository: move.repository, item: move.item });
      }
      const target = board.lanes.find(({ id }) => id === move.toLane);
      if (target === undefined) {
        return yield* BoardLaneNotFound.make({ repository: move.repository, lane: move.toLane });
      }
      if (target._tag === "ReadOnlyBoardLane") {
        return yield* BoardLaneReadOnly.make({ repository: move.repository, lane: move.toLane });
      }
      const mutation = labelMutationForBoardMove(board, target);
      const movedAt = yield* DateTime.now;
      // Recorded before the write, so the Run reader never attributes the swap to an Agent.
      yield* boardMoves.record(
        BoardMoveRecord.make({
          repository: move.repository,
          itemKey: movedItem.itemKey,
          at: movedAt,
          fromLane: source.name,
          toLane: target.name,
          added: mutation.add,
          removed: mutation.remove,
        }),
      );
      const changed = { number: move.item, updatedAt: movedAt };
      const item =
        movedItem.source === "pr" ? ChangedPullRequest.make(changed) : ChangedIssue.make(changed);
      const applied = yield* github.updateLabels(move.repository, move.item, mutation).pipe(
        // A failed or interrupted request may have applied part of the label
        // swap. Reconcile it without replacing the writer's original outcome.
        Effect.onExit((exit) =>
          polling.hint(
            move.repository,
            item,
            Option.flatMap(Exit.findErrorOption(exit), (error) =>
              error._tag === "GitHubRateLimitError" ? Option.some(error.retryAt) : Option.none(),
            ),
          ),
        ),
      );
      yield* Effect.logInfo("Operator moved a Board card and queued its authoritative refresh", {
        repository: move.repository,
        item: move.item,
        fromLane: source.id,
        toLane: target.id,
        addedLabels: mutation.add.join(", "),
        removedLabels: mutation.remove.join(", "),
        labels: applied.join(", "),
      });
    },
    Effect.tapError((error) =>
      Effect.logWarning("Board move rejected", {
        errorTag: error._tag,
        message: error.message,
      }),
    ),
  );

  const resetCycleBudget = Effect.fn("Operator.resetCycleBudget")(function* (
    instance: LoadedInstance,
    askId: CycleBudgetAskId,
  ) {
    const ask = (yield* budgets.asks).find((ask) => ask.id === askId);
    yield* requirePermission(
      "operate",
      ask === undefined ? InstanceScope.make() : repositoryScope(instance, ask.repository),
    );
    yield* Effect.annotateCurrentSpan({ askId });
    const key = `cycle-budget-reset:${askId}`;

    const answer = Event.make({
      id: EventId.make(key),
      dedupKey: DedupKey.make(key),
      payload: { action: "reset-cycle-budget", askId },
      receivedAt: yield* DateTime.now,
    });
    const replayed = yield* budgets.reset(askId, answer);
    return CycleBudgetResetView.make({ replayedCiFixEventIds: replayed });
  });

  const callScope = Effect.fn("Operator.callScope")(function* (
    instance: LoadedInstance,
    target: CallScopeTarget,
  ) {
    yield* Effect.annotateCurrentSpan({ target: target._tag });
    const resolved = yield* CallScopeTarget.$match(target, {
      Run: ({ runId }) =>
        Effect.map(reader.inspect(runId), ({ repository }): ResolvedCall => ({
          target,
          scope: repositoryScope(instance, repository),
        })),
      Repository: ({ repository }) =>
        Effect.succeed<ResolvedCall>({ target, scope: repositoryScope(instance, repository) }),
      Loop: ({ loop }) =>
        Option.match(resolveLoopName(instance.loops, loop), {
          onNone: () =>
            Effect.fail(
              LoopNotFoundError.make({
                loop,
                message: "Loop is missing or ambiguous. Use project/loop.",
              }),
            ),
          onSome: (name) =>
            Effect.succeed<ResolvedCall>({
              target: CallScopeTarget.Loop({ loop: name }),
              scope: loopScope(name),
            }),
        }),
      CycleBudgetAsk: ({ askId }) =>
        Effect.flatMap(budgets.asks, (asks) => {
          const ask = asks.find(({ id }) => id === askId);
          return ask === undefined
            ? Effect.fail(CycleBudgetResetRejectedError.make({ askId }))
            : Effect.succeed<ResolvedCall>({
                target,
                scope: repositoryScope(instance, ask.repository),
              });
        }),
    });
    yield* requirePermission("read", resolved.scope);
    return resolved;
  });

  return {
    ...observation,
    approve,
    cancel,
    callScope,
    runWorkerPreflight: (worker: WorkerName) =>
      requirePermission("admin", InstanceScope.make()).pipe(
        Effect.andThen(workerStatus.runPreflight(worker)),
        Effect.map(workerPreflightView),
      ),
    discardLeftovers: (worker: WorkerName) =>
      requirePermission("admin", InstanceScope.make()).pipe(
        Effect.andThen(runs.discardLeftovers(worker)),
        Effect.asVoid,
      ),
    moveBoardItem,
    githubChanges: (instance: LoadedInstance, runId: RunId) =>
      reader.inspect(runId).pipe(
        Effect.flatMap((snapshot) =>
          requirePermission("read", repositoryScope(instance, snapshot.repository)),
        ),
        Effect.andThen(githubChanges.read(instance.config.workers, runId)),
      ),
    pause,
    retry,
    resolveFailure,
    applyCiLabels,
    editAndRetry,
    runAgain,
    intervene,
    unpause,
    resetCycleBudget,
    dismissNeed,
    undoDismissNeed,
  } as const;
});

/**
 * The operator's factory view and actions for approving, retrying, canceling, and directing work.
 */
export class Operator extends Context.Service<
  Operator,
  OperatorObservation["Service"] & {
    /** Acknowledges only the displayed revision, preserving the run or ask state. */
    readonly dismissNeed: (
      instance: LoadedInstance,
      key: AttentionKey,
    ) => Effect.Effect<void, OperatorError>;
    /** Removes the acknowledgement of this revision. */
    readonly undoDismissNeed: (key: AttentionKey) => Effect.Effect<void, OperatorError>;
    /**
     * Answers the current cycle-budget ask, requests fresh polling, and returns the blocked CI fix
     * events the reset replayed.
     */
    readonly resetCycleBudget: (
      instance: LoadedInstance,
      askId: CycleBudgetAskId,
    ) => Effect.Effect<CycleBudgetResetView, OperatorError>;
    /**
     * Records the operator's approval of a waiting Run, attributed to the operator login in
     * `usine.yaml` if one is set. Execution still waits for Worker capacity.
     */
    readonly approve: (
      instance: LoadedInstance,
      runId: RunId,
    ) => Effect.Effect<void, OperatorError>;
    /** Resolves attention for the displayed failed Attempt. Rejects stale requests. */
    readonly resolveFailure: (
      instance: LoadedInstance,
      runId: RunId,
      attemptId: AttemptId,
    ) => Effect.Effect<void, OperatorError>;
    /**
     * Applies the completion labels of a Run whose CI wait ended because CI on its head didn't
     * finish, once CI on that head has passed, and resolves the displayed failed Attempt. Fails with
     * `CiNotPassedError` while CI on the head hasn't passed in full or after its pull request closed
     * without a merge, and with `CiLabelExpressionError` if an `on_green` item expression of the
     * Run's loop fails.
     */
    readonly applyCiLabels: (
      instance: LoadedInstance,
      runId: RunId,
      attemptId: AttemptId,
    ) => Effect.Effect<void, OperatorError>;
    /**
     * Returns `target` as the operation will resolve it, such as a short loop name qualified with
     * its project, and the scope that the call checks its permission on: the project of the
     * target's repository or loop, or the instance. Fails with `AccessDenied` when the caller
     * can't read that scope.
     */
    readonly callScope: (
      instance: LoadedInstance,
      target: CallScopeTarget,
    ) => Effect.Effect<ResolvedCall, OperatorError>;
    /** Requests a new Attempt for a failed Run with its effective task and Agent. */
    readonly retry: (instance: LoadedInstance, runId: RunId) => Effect.Effect<void, OperatorError>;
    /** Amends a failed Run and requests its next Attempt atomically. */
    readonly editAndRetry: (
      instance: LoadedInstance,
      runId: RunId,
      edit: EditAndRetry,
    ) => Effect.Effect<void, OperatorError>;
    /**
     * Opens a new Run for the Item state of a succeeded or canceled Run, with the edited task and
     * Agent and the Loop file's current settings. Returns the new Run, or the cycle-budget Ask that
     * the Item opened instead.
     */
    readonly runAgain: (
      instance: LoadedInstance,
      runId: RunId,
      edit: EditAndRetry,
    ) => Effect.Effect<RunAgainResult, OperatorError>;
    /** Sends an attributed action through a live session's Attempt channel. */
    readonly intervene: (
      instance: LoadedInstance,
      runId: RunId,
      input: SessionIntervention,
    ) => Effect.Effect<void, OperatorError>;
    /**
     * Cancels an open Run and interrupts its current Attempt. Does nothing if the Run is already
     * closed.
     */
    readonly cancel: (instance: LoadedInstance, runId: RunId) => Effect.Effect<void, OperatorError>;
    /** Runs verify-only preflight on one idle worker and returns the stored checks. */
    readonly runWorkerPreflight: (
      worker: WorkerName,
    ) => Effect.Effect<WorkerPreflightView, WorkerPreflightRejectedError | AccessDenied>;
    /**
     * Answers an `UnconfiguredWorkerNeed` so startup stops reconciling the Attempts recorded on
     * `worker`. Fails with `LeftoversDiscardRejectedError` if `usine.yaml` declares the Worker or
     * it still runs Attempts.
     */
    readonly discardLeftovers: (worker: WorkerName) => Effect.Effect<void, OperatorError>;
    /**
     * Records the move, swaps lane labels on GitHub, and hints a refresh of the Item's Board
     * position and Loop matches. If the move can't be recorded, nothing is sent to GitHub.
     */
    readonly moveBoardItem: (
      instance: LoadedInstance,
      move: BoardMove,
    ) => Effect.Effect<void, BoardMoveError>;
    /**
     * Reads the changes on the Run's GitHub Item during each Attempt from the Item's timeline: the
     * Agent's label, comment, and review changes, and the operator's Board moves.
     */
    readonly githubChanges: (
      instance: LoadedInstance,
      runId: RunId,
    ) => Effect.Effect<RunGitHubChangesView, RunGitHubChangesError | AccessDenied>;
    /** Pauses new work for a Loop; its existing Runs continue. */
    readonly pause: (
      loop: LoopName,
    ) => Effect.Effect<LoopRuntimeState, EnginePersistenceError | AccessDenied>;
    /** Lets the Loop's triggers open new Runs again. */
    readonly unpause: (
      loop: LoopName,
    ) => Effect.Effect<LoopRuntimeState, EnginePersistenceError | AccessDenied>;
  }
>()("@usine/orchestrator/operator/operator") {
  /** Provides operator observations and mutations using the run engine and GitHub writers. */
  static readonly layer = Layer.effect(Operator, makeOperator).pipe(
    Layer.provide(Layer.merge(OperatorObservation.layer, RunGitHubChanges.layer)),
  );
}

export { CiLabelExpressionError, CiNotPassedError } from "../ci.ts";
export {
  ProjectStatus,
  ProjectView,
  LoopView,
  ReadyOverview,
  NeedsSetupOverview,
  FactoryOverview,
} from "./overview/view.ts";
export {
  LabelAddedView,
  LabelRemovedView,
  CommentedView,
  ReviewedView,
  BoardMovedView,
  GitHubChangeView,
  AttemptGitHubChangesView,
  RunGitHubChangesView,
} from "./github-changes.ts";
export {
  ApprovalView,
  RunStateTag,
  RunView,
  RunSummaryView,
  RunDurationView,
  RunDetailView,
  UnconfirmedStopView,
  EditAndRetry,
  LoopNotFoundError,
  SessionIntervention,
  RosterAgentNotFoundError,
} from "./run.ts";
export {
  UsageCostView,
  SessionUsageView,
  PoolUsageView,
  RunUsageView,
  TaskPoolUsageView,
  TaskUsageView,
} from "./usage.ts";
export {
  InfraFailureView,
  ProviderCapacityFailureView,
  GitHubPushFailureView,
  DefectFailureView,
  AgentFailureView,
  BlockedFailureView,
  QuestionFailureView,
  RunawayFailureView,
  ChildSessionBudgetFailureView,
  FailureView,
  SucceededAttemptView,
  AwaitingCiAttemptView,
  HandedOffAttemptView,
  FailedAttemptView,
  CanceledAttemptView,
  AttemptOutcomeView,
  LocalWorkerAccess,
  SshWorkerAccess,
  ProvisionedWorkerAccess,
  SandboxWorkerAccess,
  WorkerAccess,
  AttemptView,
  AttemptSummaryView,
} from "./attempt.ts";
export {
  MachineView,
  MachineQuotaWait,
  ProvisioningPauseView,
  HetznerProvisionerView,
  BoatProvisionerView,
  BoxdProvisionerView,
  ProvisionerView,
} from "./machines.ts";
export {
  boardRunSummary,
  boardTaskRuns,
  BoardLaneId,
  BoardLaneOrigin,
  BoardItemLink,
  BoardPullRequestView,
  BoardTaskView,
  WritableBoardLaneView,
  ReadOnlyBoardLaneView,
  BoardLaneView,
  BoardProjectionError,
  BoardView,
  LabelView,
  BoardMove,
  BoardProjectNotFoundError,
  BoardItemNotFoundError,
  BoardLaneNotFoundError,
  BoardLaneReadOnlyError,
} from "./board.ts";
export { ItemEntryCursor, ItemEntryKind, ItemEntryView, ItemView } from "./item.ts";
export {
  AttemptReportView,
  RunBriefView,
  RunTextPageView,
  RunTextPart,
  RunTranscriptCursor,
  RunTranscriptPageView,
  TextExcerptView,
  TranscriptTextView,
} from "./run-pages/view.ts";
export { jsonBytes, PAGE_BYTES, type Page, pageOf, textPrefix } from "./page.ts";
export {
  TaskItemView,
  TaskLaneView,
  TaskCommentView,
  TaskView,
  type TaskReadDepth,
  type TaskReadError,
} from "./task.ts";
export {
  ApprovalNeed,
  CycleBudgetNeed,
  CycleBudgetResetView,
  RunFailureNeed,
  PollFailureNeed,
  PreflightFindingNeed,
  BoardProjectionNeed,
  ScheduleFailureNeed,
  ConfigFileNeed,
  UnconfiguredWorkerNeed,
  UnresponsiveWorkerNeed,
  WorkerPreflightNeed,
  WorkerQuotaNeed,
  WorkerGatewayNeed,
  WorkerPausedNeed,
  WebhookSilenceNeed,
  UpgradeDrainNeed,
  ProviderCapacityNeed,
  UnconfirmedStopNeed,
  NeedView,
  PoolLimitNeed,
} from "./need.ts";
export {
  LoopSelectorView,
  LoopFileView,
  QuarantinedLoopView,
  AgentFileView,
  InvalidAgentView,
  GatewayView,
  WorkerSlotsView,
  PassedCheckView,
  DegradedCheckView,
  DeferredCheckView,
  FailedCheckView,
  PreflightCheckView,
  ContainerView,
  HarnessPreflightView,
  WorkerConfigurationView,
  RemovedWorkerView,
  LabelStateView,
  LabelLaneSourceView,
  StateLaneSourceView,
  LaneSourceView,
  LaneConfigurationView,
  RepositoryConfigurationView,
  SettingsView,
  ConfigurationView,
  OperatorConfiguration,
} from "./configuration/view.ts";
export {
  AgentSummaryView,
  ConfigurationSummaryView,
  configurationSummary,
  FileFailureView,
  LoopSummaryView,
  WorkerSummaryView,
} from "./configuration/summary.ts";
export {
  WorkerSilentView,
  ProviderRetryingView,
  ConnectivityWarningView,
  RunningAttemptView,
  SuppressedForOperatorView,
  ClosedUnchangedView,
  RunFailedView,
  LoopPausedView,
  WaitingForStopView,
  CycleBudgetUsedUpView,
  AwaitingApprovalView,
  QueuedForWorkerView,
  WaitingForUpgradeView,
  AwaitingPollView,
  StallReasonView,
  StalledItemView,
  ClosedRunView,
  WorkerView,
  RepositoryPollView,
  DeskView,
} from "./desk.ts";
export {
  StatisticsWindow,
  StatisticsBucket,
  TaskDoneView,
  TaskPeriodView,
  LoopShareView,
  LoopRunTimeView,
  TaskTimeView,
  TaskCostView,
  TaskTokensView,
  UntimedTasksView,
  ModelOutcomeView,
  AgentModelsView,
  StatisticsView,
  DurationSummaryView,
  OutcomeCountsView,
  PoolTokensView,
  CostSummaryView,
  UsageSummaryView,
  LoopStatisticsView,
  AgentStatisticsView,
  BrainStatisticsView,
  ThroughputPeriodView,
  WorkerQueueWaitView,
  AttemptCountView,
  WorkerUtilizationView,
  NeedsAttentionPeriodView,
  NeedsAttentionView,
  RunStatisticsView,
} from "./statistics/view.ts";
export {
  FailedTranscriptView,
  TranscriptPayload,
  TranscriptEventView,
  TranscriptPageCursor,
  ColdTranscriptRequest,
  TailTranscriptRequest,
  EarlierTranscriptRequest,
  TranscriptRequest,
  TranscriptAttemptNotFoundError,
} from "./transcript.ts";

export { attentionKey, attentionAudiences, projectAttention } from "./attention.ts";

export { ConfigurationEditor, type ConfigurationEditorError } from "./configuration/editor.ts";

export { SetupState } from "./setup.ts";

export { TaskIdentityView } from "./overview/view.ts";

export { TaskPullRequestState, TaskAttemptChangesView } from "./task-changes.ts";
