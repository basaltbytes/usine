import { GitHubLabelName } from "@usine/config/label";
import type { LoadedInstance } from "@usine/config/instance";
import { Event, DedupKey, EventId } from "@usine/core/event";
import { CycleBudgetAskId } from "@usine/core/cycle-budget";
import { CycleBudgets, type CycleBudgetResetRejectedError } from "@usine/engine/cycle-budget";
import { LoopName } from "@usine/core/loop";
import { RunId } from "@usine/core/run";
import {
  RunEngine,
  type EnginePersistenceError,
  type RunEngineError,
  RunOperationRejectedError,
  type RunStoreError,
} from "@usine/engine/engine";
import { ItemProjectionReader } from "@usine/engine/item-projection";
import { LoopControl, type LoopRuntimeState } from "@usine/engine/loop-control";
import { type ProjectionRevision, RunReader } from "@usine/engine/run-reader";
import { RepositoryLabelProjectionReader } from "@usine/engine/repository-label-projection";
import { GitHubItemWriter } from "@usine/github/item-writer";
import type { GitHubAppError } from "@usine/github/github-app";
import { Context, DateTime, Effect, Layer, Option, Schema, SynchronizedRef } from "effect";
import { labelMutationForBoardMove, projectBoard } from "../board/projection.ts";
import type { LabelPreflightFinding } from "../label-reconciler.ts";
import { GitHubItemKey, PollingTriggers, type RepositoryPollFailure } from "../polling-triggers.ts";
import { ScheduleTriggers, type ScheduleFailure } from "../schedule-triggers.ts";
import {
  ApprovalNeed,
  CycleBudgetNeed,
  BoardProjectionNeed,
  PollFailureNeed,
  PreflightFindingNeed,
  RunFailureNeed,
  ScheduleFailureNeed,
  type NeedView,
} from "./need.ts";
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
  LabelView,
} from "./board.ts";
import {
  ColdTranscriptRequest,
  type TranscriptAttemptNotFoundError,
  type TranscriptRequest,
} from "./transcript.ts";
import { LoopView, ProjectView, ReadyOverview, type ProjectStatus } from "./overview.ts";
import { RunDetailView } from "./run.ts";
import { readTranscript, runView } from "./projection.ts";

export type BoardMoveError =
  | BoardItemNotFoundError
  | BoardLaneNotFoundError
  | BoardLaneReadOnlyError
  | BoardProjectNotFoundError
  | EnginePersistenceError
  | GitHubAppError;
export type OperatorError =
  | RunEngineError
  | TranscriptAttemptNotFoundError
  | BoardMoveError
  | CycleBudgetResetRejectedError;
export type OperatorObservationError = RunStoreError | TranscriptAttemptNotFoundError;

/** How many settled Runs the overview keeps beside the open ones. */
const OVERVIEW_CLOSED_RUNS = 100;

/** How many newest Items a Board shows; older ones drop off. */
const OVERVIEW_BOARD_ITEMS = 500;

interface CachedOverview {
  readonly token: string;
  readonly overview: ReadyOverview;
}

const makeOperatorObservation = Effect.gen(function* () {
  const budgets = yield* CycleBudgets;
  const reader = yield* RunReader;
  const controls = yield* LoopControl;
  const itemReader = yield* ItemProjectionReader;
  const repositoryLabels = yield* RepositoryLabelProjectionReader;
  const polling = yield* PollingTriggers;
  const schedules = yield* ScheduleTriggers;
  const cache = yield* SynchronizedRef.make(Option.none<CachedOverview>());

  const projectOverview = Effect.fn("Operator.projectOverview")(function* (
    instance: LoadedInstance,
    pollFailures: ReadonlyArray<RepositoryPollFailure>,
    preflightFindings: ReadonlyArray<LabelPreflightFinding>,
    scheduleFailures: ReadonlyArray<ScheduleFailure>,
    revision: Option.Option<ProjectionRevision>,
  ) {
    const [snapshots, states, cycleAsks] = yield* Effect.all(
      [
        reader.list({ closedLimit: OVERVIEW_CLOSED_RUNS }),
        controls.states,
        budgets.asks(),
      ] as const,
      { concurrency: "unbounded" },
    );
    const paused = new Set(states.filter((state) => state.paused).map((state) => state.loop));
    const views = snapshots.map((snapshot) => runView(snapshot, paused));
    const runsByRepository = new Map<string, Array<(typeof views)[number]>>();
    for (const view of views) {
      const projectRuns = runsByRepository.get(view.repository) ?? [];
      projectRuns.push(view);
      runsByRepository.set(view.repository, projectRuns);
    }
    const projects = yield* Effect.forEach(
      instance.config.repos,
      (repository) =>
        Effect.gen(function* () {
          const { name } = repository;
          const projectRuns = runsByRepository.get(name) ?? [];
          const projectFindings = preflightFindings.filter(
            ({ repository: findingRepository }) => findingRepository === name,
          );
          const [boardItems, labelProjection] = yield* Effect.all(
            [
              itemReader.list(name, { limit: OVERVIEW_BOARD_ITEMS }),
              repositoryLabels.get(name),
            ] as const,
            { concurrency: "unbounded" },
          );
          const catalog = Option.match(labelProjection, {
            onNone: () => [],
            onSome: ({ labels }) => labels,
          });
          const board = yield* projectBoard(
            repository,
            catalog.map(({ name }) => name),
            boardItems,
            projectRuns,
            cycleAsks.map(({ itemKey }) => itemKey),
          );
          const status: ProjectStatus =
            cycleAsks.some((ask) => ask.repository === name) ||
            board.failures.length > 0 ||
            projectFindings.length > 0 ||
            projectRuns.some((run) => run.state === "Waiting" || run.state === "Failed")
              ? "needs-you"
              : projectRuns.some((run) => run.canCancel)
                ? "active"
                : "clear";
          return new ProjectView({
            repository: name,
            status,
            runs: projectRuns,
            board,
            labels: catalog.map(
              ({ name: label, color, description }) =>
                new LabelView({
                  name: GitHubLabelName.make(label),
                  color: Option.getOrNull(color),
                  description: Option.getOrNull(description),
                }),
            ),
            preflightFindings: projectFindings,
          });
        }),
      { concurrency: 4 },
    );
    const loops = instance.loops.map(
      (loop) =>
        new LoopView({
          name: loop.name,
          trigger: loop.trigger.on,
          agent: loop.agent,
          paused: paused.has(loop.name),
        }),
    );
    const needsYou: Array<NeedView> = [];
    for (const ask of cycleAsks) {
      const item = Schema.decodeUnknownOption(GitHubItemKey)(ask.itemKey);
      needsYou.push(
        new CycleBudgetNeed({
          id: `cycle-budget:${ask.id}`,
          ask,
          itemLabel: Option.match(item, {
            onNone: () => ask.itemKey,
            onSome: ([, repository, number]) => `${repository}#${number}`,
          }),
          itemUrl: Option.match(item, {
            onNone: () => null,
            onSome: ([, repository, number]) => `https://github.com/${repository}/issues/${number}`,
          }),
        }),
      );
    }
    for (const run of views) {
      if (run.state === "Waiting") {
        needsYou.push(
          new ApprovalNeed({
            id: `approval:${run.id}`,
            repository: run.repository,
            runId: run.id,
            loop: run.loop,
          }),
        );
      } else if (run.state === "Failed") {
        const attempt = run.attempts.at(-1);
        if (attempt?.outcome?._tag !== "Failed") {
          return yield* Effect.die(new Error(`Failed Run ${run.id} has no failed Attempt`));
        }
        needsYou.push(
          new RunFailureNeed({
            id: `run-failure:${run.id}`,
            repository: run.repository,
            runId: run.id,
            loop: run.loop,
            failure: attempt.outcome.failure,
          }),
        );
      }
    }
    for (const project of projects) {
      for (const failure of project.board.failures) {
        needsYou.push(
          new BoardProjectionNeed({
            id: `board-projection:${failure.repository}:${failure.itemKey}`,
            failure,
          }),
        );
      }
    }
    pollFailures.forEach((failure, index) => {
      needsYou.push(
        new PollFailureNeed({
          id: `poll-failure:${failure.repository}:${failure.errorTag}:${index}`,
          failure,
        }),
      );
    });
    preflightFindings.forEach((finding) => {
      needsYou.push(
        new PreflightFindingNeed({
          id: `preflight:${finding.repository}:${finding.label}`,
          finding,
        }),
      );
    });
    scheduleFailures.forEach((failure, index) => {
      needsYou.push(
        new ScheduleFailureNeed({
          id: `schedule-failure:${failure.loop}:${failure._tag}:${index}`,
          failure,
        }),
      );
    });
    const projected = new ReadyOverview({ projects, loops, needsYou });
    yield* Effect.logDebug("Refreshed operator overview", {
      revision,
      runs: views.length,
      needsYou: needsYou.length,
    });
    return projected;
  });

  const overview = Effect.fn("Operator.overview")((instance: LoadedInstance) =>
    SynchronizedRef.modifyEffect(cache, (cached) =>
      Effect.gen(function* () {
        const [revision, latestPoll, latestSchedule] = yield* Effect.all(
          [reader.revision(), polling.latest, schedules.latest] as const,
          { concurrency: "unbounded" },
        );
        const pollFailures = Option.match(latestPoll, {
          onNone: () => [],
          onSome: ({ failures }) => failures,
        });
        const preflightFindings = Option.match(latestPoll, {
          onNone: () => [],
          onSome: ({ preflightFindings }) => preflightFindings,
        });
        const scheduleFailures = Option.match(latestSchedule, {
          onNone: () => [],
          onSome: ({ failures }) => failures,
        });
        // Without the invalidation singleton staleness cannot be detected, so the
        // cache is bypassed.
        const token = Option.map(revision, (value) =>
          JSON.stringify([
            value,
            instance.config.repos.map(({ name, lanes }) => [name, lanes]),
            instance.loops.map(({ name, agent, trigger }) => [name, agent, trigger.on]),
            pollFailures,
            preflightFindings,
            scheduleFailures,
          ]),
        );
        if (Option.isNone(token)) {
          yield* Effect.logWarning(
            "Projection revision singleton is missing; the overview cache is bypassed",
          );
          const projected = yield* projectOverview(
            instance,
            pollFailures,
            preflightFindings,
            scheduleFailures,
            revision,
          );
          return [projected, Option.none<CachedOverview>()] as const;
        }
        if (Option.isSome(cached) && cached.value.token === token.value) {
          yield* Effect.logDebug("Reusing unchanged operator overview", {
            revision,
          });
          return [cached.value.overview, cached] as const;
        }
        const projected = yield* projectOverview(
          instance,
          pollFailures,
          preflightFindings,
          scheduleFailures,
          revision,
        );
        return [projected, Option.some({ token: token.value, overview: projected })] as const;
      }),
    ),
  );

  const detail = Effect.fn("Operator.detail")(function* (
    runId: RunId,
    request: TranscriptRequest = new ColdTranscriptRequest(),
  ) {
    yield* Effect.annotateCurrentSpan({ runId });
    const [snapshot, states] = yield* Effect.all(
      [reader.inspect(runId), controls.states] as const,
      { concurrency: "unbounded" },
    );
    const paused = new Set(states.filter((state) => state.paused).map((state) => state.loop));
    const transcript = yield* readTranscript(reader, snapshot, request);
    return new RunDetailView({
      run: runView(snapshot, paused),
      eventDedupKey: snapshot.event.dedupKey,
      eventPayload: snapshot.event.payload,
      transcript: transcript.events,
      earlierTranscript: transcript.earlier,
    });
  });

  return { detail, overview } as const;
});

/** The read-only operator surface. It needs no trigger execution to build. */
export class OperatorObservation extends Context.Service<
  OperatorObservation,
  {
    /** Builds the supplied instance's Projects, Boards, Runs, and items needing operator attention. */
    readonly overview: (
      instance: LoadedInstance,
    ) => Effect.Effect<ReadyOverview, OperatorObservationError>;
    /** Reads one Run and a bounded transcript page; `request` selects the latest, newer, or earlier activity. */
    readonly detail: (
      runId: RunId,
      request?: TranscriptRequest,
    ) => Effect.Effect<RunDetailView, OperatorObservationError>;
  }
>()("@usine/orchestrator/OperatorObservation") {
  static readonly layer = Layer.effect(OperatorObservation, makeOperatorObservation);
}

const makeOperator = Effect.gen(function* () {
  const budgets = yield* CycleBudgets;
  const observation = yield* OperatorObservation;
  const runs = yield* RunEngine;
  const controls = yield* LoopControl;
  const items = yield* ItemProjectionReader;
  const repositoryLabels = yield* RepositoryLabelProjectionReader;
  const github = yield* GitHubItemWriter;

  const approve = Effect.fn("Operator.approve")(function* (runId: RunId) {
    yield* Effect.annotateCurrentSpan({ runId });
    const current = yield* runs.inspect(runId);
    if (current.run.state._tag !== "Waiting") {
      yield* Effect.logInfo("Operator approval rejected; the Run is past its gate", {
        runId,
        state: current.run.state._tag,
      });
      return yield* new RunOperationRejectedError({
        runId,
        operation: "approve",
        state: current.run.state._tag,
      });
    }
    const receivedAt = yield* DateTime.now;
    const dedupKey = DedupKey.make(JSON.stringify(["operator-approval", runId]));
    yield* runs.approve(
      runId,
      new Event({
        id: EventId.make(dedupKey),
        dedupKey,
        payload: { runId, decision: "approved" },
        receivedAt,
      }),
    );
    yield* Effect.logInfo("Operator approved Run", { runId });
  });

  const retry = Effect.fn("Operator.retry")(function* (runId: RunId) {
    yield* Effect.annotateCurrentSpan({ runId });
    yield* runs.retry(runId);
    yield* Effect.logInfo("Operator retried Run", { runId });
  });

  const cancel = Effect.fn("Operator.cancel")(function* (runId: RunId) {
    yield* Effect.annotateCurrentSpan({ runId });
    yield* runs.cancel(runId);
    yield* Effect.logInfo("Operator canceled Run", { runId });
  });

  const pause = Effect.fn("Operator.pause")(function* (loop: LoopName) {
    yield* Effect.annotateCurrentSpan({ loop });
    return yield* controls.pause(loop);
  });
  const unpause = Effect.fn("Operator.unpause")(function* (loop: LoopName) {
    yield* Effect.annotateCurrentSpan({ loop });
    return yield* controls.unpause(loop);
  });

  const moveBoardItem = Effect.fn("Operator.moveBoardItem")(
    function* (instance: LoadedInstance, move: BoardMove) {
      yield* Effect.annotateCurrentSpan({
        repository: move.repository,
        item: move.item,
        lane: move.toLane,
      });
      const repository = instance.config.repos.find(({ name }) => name === move.repository);
      if (repository === undefined) {
        return yield* new BoardProjectNotFound({ repository: move.repository });
      }
      const [storedItems, labelProjection] = yield* Effect.all(
        [
          items.list(move.repository, { limit: OVERVIEW_BOARD_ITEMS }),
          repositoryLabels.get(move.repository),
        ] as const,
        { concurrency: "unbounded" },
      );
      const board = yield* projectBoard(
        repository,
        Option.match(labelProjection, {
          onNone: () => [],
          onSome: ({ labels }) => labels.map(({ name }) => name),
        }),
        storedItems,
        [],
      );
      const source = board.lanes.find(({ items: laneItems }) =>
        laneItems.some(({ number }) => number === move.item),
      );
      if (source === undefined) {
        return yield* new BoardItemNotFound({ repository: move.repository, item: move.item });
      }
      const target = board.lanes.find(({ id }) => id === move.toLane);
      if (target === undefined) {
        return yield* new BoardLaneNotFound({ repository: move.repository, lane: move.toLane });
      }
      if (target._tag === "ReadOnlyBoardLane") {
        return yield* new BoardLaneReadOnly({ repository: move.repository, lane: move.toLane });
      }
      const mutation = labelMutationForBoardMove(board, target);
      const applied = yield* github.updateLabels(move.repository, move.item, mutation);
      yield* Effect.logInfo("Operator moved a Board card; the next poll projects the new lane", {
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
    askId: CycleBudgetAskId,
  ) {
    yield* Effect.annotateCurrentSpan({ askId });
    const key = `cycle-budget-reset:${askId}`;
    yield* budgets.reset(
      askId,
      new Event({
        id: EventId.make(key),
        dedupKey: DedupKey.make(key),
        payload: { action: "reset-cycle-budget", askId },
        receivedAt: yield* DateTime.now,
      }),
    );
  });

  return {
    ...observation,
    approve,
    cancel,
    moveBoardItem,
    pause,
    retry,
    unpause,
    resetCycleBudget,
  } as const;
});

/** The operator's view of the factory and actions for approving, retrying, canceling, and directing work. */
export class Operator extends Context.Service<
  Operator,
  OperatorObservation["Service"] & {
    /** Answers the Item's current cycle Ask; polling refreshes its state before more Runs open. */
    readonly resetCycleBudget: (askId: CycleBudgetAskId) => Effect.Effect<void, OperatorError>;
    /** Records approval for a waiting Run; execution still waits for Worker capacity. */
    readonly approve: (runId: RunId) => Effect.Effect<void, OperatorError>;
    /** Requests a new Attempt for a failed Run using its effective task and Agent. */
    readonly retry: (runId: RunId) => Effect.Effect<void, OperatorError>;
    /** Cancels an open Run and interrupts its current Attempt; an already closed Run is unchanged. */
    readonly cancel: (runId: RunId) => Effect.Effect<void, OperatorError>;
    /** Swaps lane labels on GitHub; the next poll refreshes the Board's observed position. */
    readonly moveBoardItem: (
      instance: LoadedInstance,
      move: BoardMove,
    ) => Effect.Effect<void, BoardMoveError>;
    /** Pauses new work for a Loop while its existing Runs continue. */
    readonly pause: (loop: LoopName) => Effect.Effect<LoopRuntimeState, EnginePersistenceError>;
    /** Allows the Loop's triggers to open new Runs again. */
    readonly unpause: (loop: LoopName) => Effect.Effect<LoopRuntimeState, EnginePersistenceError>;
  }
>()("@usine/orchestrator/Operator") {
  static readonly layer = Layer.effect(Operator, makeOperator).pipe(
    Layer.provide(OperatorObservation.layer),
  );
}

export {
  ProjectStatus,
  ProjectView,
  LoopView,
  ReadyOverview,
  NeedsSetupOverview,
  FactoryOverview,
} from "./overview.ts";
export { RunStateTag, RunView, RunDetailView } from "./run.ts";
export {
  InfraFailureView,
  AgentFailureView,
  RunawayFailureView,
  ChildSessionBudgetFailureView,
  FailureView,
  SucceededAttemptView,
  FailedAttemptView,
  CanceledAttemptView,
  AttemptOutcomeView,
  AttemptView,
} from "./attempt.ts";
export {
  BoardLaneId,
  BoardLaneOrigin,
  BoardItemView,
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
export {
  ApprovalNeed,
  CycleBudgetNeed,
  RunFailureNeed,
  PollFailureNeed,
  PreflightFindingNeed,
  BoardProjectionNeed,
  ScheduleFailureNeed,
  NeedView,
} from "./need.ts";
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
