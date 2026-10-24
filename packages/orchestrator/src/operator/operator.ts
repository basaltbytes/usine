import { transcriptEvent } from "./projection.ts";
import { TranscriptSessionsQuery } from "@usine/engine/transcript";
import { GitHubLabelName } from "@usine/config/label";
import { resolveParentModel } from "@usine/core/agent";
import { AttemptContext, AttemptId } from "@usine/core/attempt";
import { Intervention } from "@usine/core/attempt/channel";
import type { LoadedInstance } from "@usine/config/instance";
import { Event, DedupKey, EventId } from "@usine/core/event";
import { CycleBudgetAskId } from "@usine/core/cycle-budget";
import { BoardMoveRecord, BoardMoves } from "@usine/engine/board-moves";
import { CycleBudgets, type CycleBudgetResetRejectedError } from "@usine/engine/cycle-budget";
import { LoopName } from "@usine/core/loop";
import { RunId } from "@usine/core/run";
import { ApprovalSource } from "@usine/core/run/approval";
import type { WorkerName } from "@usine/core/worker";
import type { ItemKey, ItemNumber } from "@usine/core/item";
import type { RepositoryName } from "@usine/core/repository";
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
  type UnconfirmedStop,
  UnconfirmedStops,
} from "@usine/engine/engine";
import { ItemProjectionReader } from "@usine/engine/item-projection";
import { LoopControl, type LoopRuntimeState } from "@usine/engine/loop-control";
import { type ProjectionRevision, RunReader, type RunSummary } from "@usine/engine/run-reader";
import { RepositoryLabelProjectionReader } from "@usine/engine/repository-label-projection";
import { GitHubItemWriter } from "@usine/github/item-writer";
import type { GitHubAppError } from "@usine/github/github-app";
import { ChangedIssue, ChangedPullRequest } from "@usine/github/polling";
import {
  Context,
  DateTime,
  Effect,
  Exit,
  Layer,
  Match,
  Option,
  Schema,
  SynchronizedRef,
} from "effect";
import { settledItemState } from "../board/items.ts";
import { labelMutationForBoardMove, projectBoard } from "../board/projection.ts";
import type { LabelPreflightFinding } from "../label-reconciler.ts";
import { LoopMatches } from "../loop-matches.ts";
import { GitHubItemKey, PollingTriggers, type RepositoryPollFailure } from "../polling-triggers.ts";
import { ScheduleTriggers, type ScheduleFailure } from "../schedule-triggers.ts";
import { cycleLimitOf } from "../trigger-submission.ts";
import {
  ApprovalNeed,
  ConfigFileNeed,
  CycleBudgetNeed,
  BoardProjectionNeed,
  PollFailureNeed,
  PreflightFindingNeed,
  RunFailureNeed,
  ScheduleFailureNeed,
  UnconfiguredWorkerNeed,
  UnconfirmedStopNeed,
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
  BoardTaskView,
  BoardView,
  LabelView,
  ReadOnlyBoardLaneView,
  WritableBoardLaneView,
} from "./board.ts";
import {
  ColdTranscriptRequest,
  type TranscriptAttemptNotFoundError,
  type TranscriptRequest,
} from "./transcript.ts";
import { LoopView, ProjectView, ReadyOverview, type ProjectStatus } from "./overview.ts";
import {
  RunDetailView,
  EditAndRetry,
  LoopNotFoundError,
  SessionIntervention,
  RosterAgentNotFoundError,
} from "./run.ts";
import {
  readRunningEvents,
  readTranscript,
  readUnrecordedEnds,
  runDuration,
  runView,
  workerAccesses,
} from "./projection.ts";
import { RunUsageReader, type RunUsageView, taskUsage } from "./usage.ts";
import {
  RunGitHubChanges,
  type RunGitHubChangesError,
  type RunGitHubChangesView,
} from "./github-changes.ts";
import { TaskReader, type TaskReadError, type TaskView } from "./task.ts";
import { type DeskView, OperatorDesk } from "./desk.ts";

export type BoardMoveError =
  | BoardItemNotFoundError
  | BoardLaneNotFoundError
  | BoardLaneReadOnlyError
  | BoardProjectNotFoundError
  | EnginePersistenceError
  | RunStoreError
  | GitHubAppError;
export type OperatorError =
  | LoopNotFoundError
  | RosterAgentNotFoundError
  | RunEngineError
  | LeftoversDiscardRejectedError
  | TranscriptAttemptNotFoundError
  | BoardMoveError
  | CycleBudgetResetRejectedError
  | RunGitHubChangesError;
export type OperatorObservationError = RunStoreError | TranscriptAttemptNotFoundError;

/** The number of closed Runs the overview keeps next to the open ones. */
const OVERVIEW_CLOSED_RUNS = 100;

/** The number of newest Items a Board shows. */
const OVERVIEW_BOARD_ITEMS = 500;

/**
 * Each Board Run's usage at projection time, and the Runs whose Attempt was running then. Token
 * reports don't change the projection revision, so a cached overview rereads these Runs' usage.
 */
interface BoardUsage {
  readonly runs: ReadonlyMap<RunId, RunUsageView>;
  readonly working: ReadonlyArray<RunSummary>;
}

interface CachedOverview {
  readonly token: string;
  readonly overview: ReadyOverview;
  readonly usage: BoardUsage;
}

/**
 * Returns `overview` with the usage of every card that contains a `changed` Run recomputed from
 * `usage`.
 */
const withRunUsage = (
  overview: ReadyOverview,
  changed: ReadonlySet<RunId>,
  usage: ReadonlyMap<RunId, RunUsageView>,
): ReadyOverview =>
  new ReadyOverview({
    ...overview,
    projects: overview.projects.map(
      (project) =>
        new ProjectView({
          ...project,
          board: new BoardView({
            ...project.board,
            lanes: project.board.lanes.map((lane) => {
              const items = lane.items.map((task) =>
                task.runs.some(({ id }) => changed.has(id))
                  ? new BoardTaskView({ ...task, usage: taskUsage(task.runs, usage) })
                  : task,
              );
              return lane._tag === "WritableBoardLane"
                ? new WritableBoardLaneView({ ...lane, items })
                : new ReadOnlyBoardLaneView({ ...lane, items });
            }),
          }),
        }),
    ),
  });

const makeOperatorObservation = Effect.gen(function* () {
  const budgets = yield* CycleBudgets;
  const reader = yield* RunReader;
  const controls = yield* LoopControl;
  const itemReader = yield* ItemProjectionReader;
  const repositoryLabels = yield* RepositoryLabelProjectionReader;
  const polling = yield* PollingTriggers;
  const schedules = yield* ScheduleTriggers;
  const loopMatches = yield* LoopMatches;
  const cache = yield* SynchronizedRef.make(Option.none<CachedOverview>());
  const usageReader = yield* RunUsageReader;
  const stops = yield* UnconfirmedStops;

  const projectOverview = Effect.fn("Operator.projectOverview")(function* (
    instance: LoadedInstance,
    pollFailures: ReadonlyArray<RepositoryPollFailure>,
    preflightFindings: ReadonlyArray<LabelPreflightFinding>,
    scheduleFailures: ReadonlyArray<ScheduleFailure>,
    revision: Option.Option<ProjectionRevision>,
    unconfirmedStops: ReadonlyArray<UnconfirmedStop>,
  ) {
    const [snapshots, states, cycleAsks, workerAttempts] = yield* Effect.all(
      [
        reader.list({ closedLimit: OVERVIEW_CLOSED_RUNS }),
        controls.states,
        budgets.asks(),
        reader.attemptsByWorker(),
      ] as const,
      { concurrency: "unbounded" },
    );
    const paused = new Set(states.filter((state) => state.paused).map((state) => state.loop));
    const access = workerAccesses(instance.config.workers);
    const views = snapshots.map((snapshot) => runView(snapshot, paused, access));
    const runsByRepository = new Map<string, Array<(typeof views)[number]>>();
    for (const view of views) {
      const projectRuns = runsByRepository.get(view.repository) ?? [];
      projectRuns.push(view);
      runsByRepository.set(view.repository, projectRuns);
    }
    const projected = yield* Effect.forEach(
      instance.config.repos,
      (repository) =>
        Effect.gen(function* () {
          const { name } = repository;
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
          const [history, matches] = yield* Effect.all(
            [
              reader.forItems(boardItems.map(({ itemKey }) => itemKey)),
              loopMatches.matching(instance, repository, boardItems),
            ] as const,
            { concurrency: "unbounded" },
          );
          const itemLoops = new Map<ItemKey, Array<LoopName>>();
          for (const { loop, item } of matches) {
            itemLoops.set(item.itemKey, [...(itemLoops.get(item.itemKey) ?? []), loop.name]);
          }
          const merged = new Map((runsByRepository.get(name) ?? []).map((run) => [run.id, run]));
          for (const saved of history) {
            const view = runView(saved, paused, access);
            merged.set(view.id, view);
          }
          const projectRuns = [...merged.values()].sort(
            (a, b) => b.openedAt.localeCompare(a.openedAt) || b.id.localeCompare(a.id),
          );
          // The reader keeps ended Attempts' reports, so only running Attempts are read again. A
          // running Run's Event gives the lane its card stays in while its Agent changes labels.
          const [usages, runEvents] = yield* Effect.all(
            [
              Effect.forEach(
                history,
                (summary) =>
                  usageReader
                    .read(summary)
                    .pipe(Effect.map((usage) => [summary.run.id, usage] as const)),
                { concurrency: 4 },
              ),
              readRunningEvents(reader, history),
            ] as const,
            { concurrency: "unbounded" },
          );
          const runUsage = new Map(usages);
          yield* Effect.logDebug("Read the usage of the Board's Runs", {
            repository: name,
            runs: runUsage.size,
          });
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
            itemLoops,
            runUsage,
            runEvents,
          );
          const working = history.filter(({ attempts }) =>
            attempts.some(({ outcome }) => Option.isNone(outcome)),
          );
          const status: ProjectStatus =
            cycleAsks.some((ask) => ask.repository === name) ||
            board.failures.length > 0 ||
            projectFindings.length > 0 ||
            projectRuns.some((run) => run.canApprove || run.canResolveFailure)
              ? "needs-you"
              : projectRuns.some((run) => run.canCancel)
                ? "active"
                : "clear";
          const project = new ProjectView({
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
          return { project, runUsage, working } as const;
        }),
      { concurrency: 4 },
    );
    const projects = projected.map(({ project }) => project);
    const usage: BoardUsage = {
      runs: new Map(projected.flatMap(({ runUsage }) => [...runUsage])),
      working: projected.flatMap(({ working }) => working),
    };
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
    const allRuns = new Map(views.map((run) => [run.id, run]));
    for (const project of projects) for (const run of project.runs) allRuns.set(run.id, run);
    const cardedItems = new Map(
      projects.flatMap(({ board }) =>
        board.lanes.flatMap(({ items }) =>
          items.flatMap((task) => task.items.map((item) => [item.itemKey, item] as const)),
        ),
      ),
    );
    const failedItems = new Set(
      [...allRuns.values()].flatMap((run) =>
        run.state !== "Waiting" && run.canResolveFailure ? [run.itemKey] : [],
      ),
    );
    const settledItems = new Map(
      yield* Effect.forEach(
        failedItems,
        (key) =>
          settledItemState(key).pipe(
            Effect.provideService(ItemProjectionReader, itemReader),
            Effect.map((state) => [key, state] as const),
          ),
        { concurrency: 4 },
      ),
    );
    for (const run of allRuns.values()) {
      if (run.state === "Waiting") {
        needsYou.push(
          new ApprovalNeed({
            id: `approval:${run.id}`,
            repository: run.repository,
            runId: run.id,
            loop: run.loop,
            item: cardedItems.get(run.itemKey) ?? null,
          }),
        );
      } else if (run.canResolveFailure) {
        const attempt = run.attempts.at(-1);
        if (attempt?.outcome?._tag !== "Failed") {
          return yield* Effect.die(new Error(`Failed run ${run.id} has no failed attempt`));
        }
        const settled = settledItems.get(run.itemKey) ?? Option.none();
        if (Option.isSome(settled)) {
          yield* Effect.logDebug("Failed Run's Item is closed; left out of Needs attention", {
            runId: run.id,
            itemKey: run.itemKey,
            itemState: settled.value,
            failure: attempt.outcome.failure._tag,
          });
          continue;
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
    for (const { file, error } of instance.invalidAgents) {
      needsYou.push(new ConfigFileNeed({ id: `config-file:${file}`, kind: "agent", error }));
    }
    for (const { file, error } of instance.quarantinedLoops) {
      needsYou.push(new ConfigFileNeed({ id: `config-file:${file}`, kind: "loop", error }));
    }
    const configuredWorkers = new Set(instance.config.workers.map(({ name }) => name));
    for (const { worker, attempts, running } of workerAttempts) {
      if (configuredWorkers.has(worker)) continue;
      needsYou.push(
        new UnconfiguredWorkerNeed({
          id: `unconfigured-worker:${worker}`,
          worker,
          attempts,
          running,
        }),
      );
    }
    for (const { attemptId, runId, worker } of unconfirmedStops) {
      const run = allRuns.get(runId) ?? runView(yield* reader.inspect(runId), paused, access);
      const attempt = run.attempts.find(({ id }) => id === attemptId);
      if (attempt === undefined) {
        yield* Effect.logWarning(
          "The Run has no Attempt with the unconfirmed stop; no need shown",
          {
            runId,
            attemptId,
          },
        );
        continue;
      }
      needsYou.push(
        new UnconfirmedStopNeed({
          id: `unconfirmed-stop:${attemptId}`,
          repository: run.repository,
          runId,
          loop: run.loop,
          attemptNumber: attempt.number,
          worker,
        }),
      );
    }
    const overview = new ReadyOverview({ projects, loops, needsYou });
    yield* Effect.logDebug("Refreshed operator overview", {
      revision,
      runs: views.length,
      needsYou: needsYou.length,
      runsAtWork: usage.working.length,
    });
    return { overview, usage } as const;
  });

  // Each session keeps its highest report, so a Run's usage changes only with more tokens or
  // another session.
  const refreshWorkingUsage = Effect.fn("Operator.refreshWorkingUsage")(function* (
    cached: CachedOverview,
  ) {
    if (cached.usage.working.length === 0) return cached;
    const read = yield* Effect.forEach(
      cached.usage.working,
      (summary) =>
        usageReader.read(summary).pipe(Effect.map((usage) => [summary.run.id, usage] as const)),
      { concurrency: 4 },
    );
    const changed = new Set(
      read.flatMap(([runId, usage]) => {
        const before = cached.usage.runs.get(runId);
        return before?.tokens === usage.tokens && before.sessions.length === usage.sessions.length
          ? []
          : [runId];
      }),
    );
    if (changed.size === 0) return cached;
    const runs = new Map([...cached.usage.runs, ...read]);
    yield* Effect.logDebug("Refreshed the usage of Runs at work on the cached overview", {
      runsAtWork: read.length,
      changed: changed.size,
    });
    return {
      ...cached,
      overview: withRunUsage(cached.overview, changed, runs),
      usage: { ...cached.usage, runs },
    };
  });

  const overview = Effect.fn("Operator.overview")((instance: LoadedInstance) =>
    SynchronizedRef.modifyEffect(cache, (cached) =>
      Effect.gen(function* () {
        const [revision, latestPoll, latestSchedule, unconfirmedStops] = yield* Effect.all(
          [reader.revision(), polling.latest, schedules.latest, stops.list] as const,
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
        // Without the invalidation singleton, staleness can't be detected, so the cache is
        // bypassed.
        const token = Option.map(revision, (value) =>
          JSON.stringify([
            value,
            instance.config.repos.map(({ name, tags, lanes }) => [name, tags, lanes]),
            [...workerAccesses(instance.config.workers)],
            instance.loops.map(({ name, agent, trigger, selector }) => [
              name,
              agent,
              trigger,
              selector,
            ]),
            [...instance.invalidAgents, ...instance.quarantinedLoops].map(({ file, error }) => [
              file,
              error.stage,
              error.message,
            ]),
            pollFailures,
            preflightFindings,
            scheduleFailures,
            unconfirmedStops.map(({ attemptId }) => attemptId),
          ]),
        );
        if (Option.isNone(token)) {
          yield* Effect.logWarning(
            "Projection revision singleton is missing; the overview cache is bypassed",
          );
          const { overview: projected } = yield* projectOverview(
            instance,
            pollFailures,
            preflightFindings,
            scheduleFailures,
            revision,
            unconfirmedStops,
          );
          return [projected, Option.none<CachedOverview>()] as const;
        }
        if (Option.isSome(cached) && cached.value.token === token.value) {
          yield* Effect.logDebug("Reusing unchanged operator overview", {
            revision,
          });
          const current = yield* refreshWorkingUsage(cached.value);
          return [current.overview, Option.some(current)] as const;
        }
        const projected = yield* projectOverview(
          instance,
          pollFailures,
          preflightFindings,
          scheduleFailures,
          revision,
          unconfirmedStops,
        );
        return [projected.overview, Option.some({ token: token.value, ...projected })] as const;
      }),
    ),
  );

  const detail = Effect.fn("Operator.detail")(function* (
    instance: LoadedInstance,
    runId: RunId,
    request: TranscriptRequest = new ColdTranscriptRequest(),
  ) {
    yield* Effect.annotateCurrentSpan({ runId });
    const [snapshot, states] = yield* Effect.all(
      [reader.inspect(runId), controls.states] as const,
      { concurrency: "unbounded" },
    );
    const paused = new Set(states.filter((state) => state.paused).map((state) => state.loop));
    const [transcript, sessionState, usage, unrecordedEnds, settled] = yield* Effect.all(
      [
        readTranscript(reader, snapshot, request),
        Effect.forEach(
          snapshot.attempts.filter((attempt) => Option.isNone(attempt.outcome)),
          (attempt) => reader.transcript(new TranscriptSessionsQuery({ attemptId: attempt.id })),
          { concurrency: "unbounded" },
        ),
        usageReader.read(snapshot),
        readUnrecordedEnds(reader, snapshot),
        settledItemState(snapshot.itemKey).pipe(
          Effect.provideService(ItemProjectionReader, itemReader),
        ),
      ],
      { concurrency: "unbounded" },
    );
    return new RunDetailView({
      run: runView(snapshot, paused, workerAccesses(instance.config.workers)),
      eventDedupKey: snapshot.event.dedupKey,
      eventPayload: snapshot.event.payload,
      transcript: transcript.events,
      sessionState: sessionState.flat().map(transcriptEvent),
      earlierTranscript: transcript.earlier,
      worker: snapshot.attempts.at(-1)?.worker ?? null,
      settledItemState: Option.getOrNull(settled),
      duration: runDuration(snapshot.attempts, unrecordedEnds),
      usage,
    });
  });

  const tasks = yield* TaskReader;
  const { desk } = yield* OperatorDesk;

  return { detail, overview, task: tasks.read, desk } as const;
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
     * Reads the Task that contains Item `item` of `repository`, with its Items, saved Runs, and
     * harvested comments. Fails if the Item isn't among the Board's newest Items.
     */
    readonly task: (
      instance: LoadedInstance,
      repository: RepositoryName,
      item: ItemNumber,
    ) => Effect.Effect<TaskView, TaskReadError>;
    /**
     * Builds the instance's desk: running Attempts, matched Items with no running Attempt, recently
     * closed Runs, Worker slots and preflights, and poll times.
     */
    readonly desk: (instance: LoadedInstance) => Effect.Effect<DeskView, OperatorObservationError>;
  }
>()("@usine/orchestrator/OperatorObservation") {
  static readonly layer = Layer.effect(OperatorObservation, makeOperatorObservation).pipe(
    Layer.provide(
      Layer.mergeAll(TaskReader.layer, OperatorDesk.layer, LoopMatches.layer, RunUsageReader.layer),
    ),
  );
}

const makeOperator = Effect.gen(function* () {
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

  const approve = Effect.fn("Operator.approve")(function* (instance: LoadedInstance, runId: RunId) {
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
      new ApprovalSource({ channel: "ui", approver: instance.config.operator }),
    );
    yield* Effect.logInfo("Operator approved Run", { runId });
  });

  const retry = Effect.fn("Operator.retry")(function* (instance: LoadedInstance, runId: RunId) {
    yield* Effect.annotateCurrentSpan({ runId });
    yield* runs.retry(
      runId,
      new RetryRequest({ requestedBy: instance.config.operator, amendment: Option.none() }),
    );
    yield* Effect.logInfo("Operator retried Run", { runId });
  });

  const editAndRetry = Effect.fn("Operator.editAndRetry")(function* (
    instance: LoadedInstance,
    runId: RunId,
    edit: EditAndRetry,
  ) {
    yield* Effect.annotateCurrentSpan({ runId, agent: edit.agent });
    const file = instance.agents.find(({ name }) => name === edit.agent);
    if (file === undefined)
      return yield* new RosterAgentNotFoundError({
        agent: edit.agent,
        message: `Agent "${edit.agent}" is not in the roster`,
      });
    const agent = file.agent;
    yield* runs.retry(
      runId,
      new RetryRequest({
        requestedBy: instance.config.operator,
        amendment: Option.some(
          new AttemptContext({
            task: edit.task,
            agent,
            parentModel: resolveParentModel(agent, instance.config.settings.parentModel),
          }),
        ),
      }),
    );
    yield* Effect.logInfo("Operator amended and retried Run", { runId, agent: agent.name });
  });

  const runAgain = Effect.fn("Operator.runAgain")(function* (
    instance: LoadedInstance,
    runId: RunId,
    edit: EditAndRetry,
  ) {
    yield* Effect.annotateCurrentSpan({ runId, agent: edit.agent });
    const current = yield* runs.inspect(runId);
    const loop = instance.loops.find(({ name }) => name === current.run.loop);
    if (loop === undefined) {
      yield* Effect.logInfo("Run again rejected; the Run's Loop is not loaded", {
        runId,
        loop: current.run.loop,
      });
      return yield* new LoopNotFoundError({
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
      return yield* new RosterAgentNotFoundError({
        agent: edit.agent,
        message: `Agent "${edit.agent}" is not in the roster`,
      });
    }
    const agent = file.agent;
    const result = yield* runs.runAgain(
      runId,
      new RunAgainRequest({
        step: loop.step,
        approval: loop.approval,
        cycleLimit: cycleLimitOf(loop),
        permissions: loop.permissions,
        context: new AttemptContext({
          task: edit.task,
          agent,
          parentModel: resolveParentModel(agent, instance.config.settings.parentModel),
        }),
        requestedBy: instance.config.operator,
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
    yield* Effect.annotateCurrentSpan({
      runId,
      attemptId: input.attemptId,
      action: input.action._tag,
    });
    yield* runs.intervene(
      runId,
      input.attemptId,
      new Intervention({
        operator: Option.getOrElse(instance.config.operator, () => "local operator"),
        target: input.target,
        action: input.action,
      }),
    );
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
      // Place each card as the Board does, so the move records the lane that the card left.
      const summaries = yield* reader.forItems(storedItems.map(({ itemKey }) => itemKey));
      const runEvents = yield* readRunningEvents(reader, summaries);
      const access = workerAccesses(instance.config.workers);
      const board = yield* projectBoard(
        repository,
        Option.match(labelProjection, {
          onNone: () => [],
          onSome: ({ labels }) => labels.map(({ name }) => name),
        }),
        storedItems,
        // Placement reads no pause state, so these views leave every Loop unpaused.
        summaries.map((summary) => runView(summary, new Set(), access)),
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
      const movedAt = yield* DateTime.now;
      // Recorded before the write, so the Run reader never attributes the swap to an Agent.
      yield* boardMoves.record(
        new BoardMoveRecord({
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
        movedItem.source === "pr" ? new ChangedPullRequest(changed) : new ChangedIssue(changed);
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
    discardLeftovers: (worker: WorkerName) => runs.discardLeftovers(worker).pipe(Effect.asVoid),
    moveBoardItem,
    githubChanges: githubChanges.read,
    pause,
    retry,
    resolveFailure: runs.resolveFailure,
    editAndRetry,
    runAgain,
    intervene,
    unpause,
    resetCycleBudget,
  } as const;
});

/**
 * The operator's factory view and actions for approving, retrying, canceling, and directing work.
 */
export class Operator extends Context.Service<
  Operator,
  OperatorObservation["Service"] & {
    /**
     * Answers the Item's current cycle-budget Ask. Polling refreshes its state before more Runs
     * open.
     */
    readonly resetCycleBudget: (askId: CycleBudgetAskId) => Effect.Effect<void, OperatorError>;
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
      runId: RunId,
      attemptId: AttemptId,
    ) => Effect.Effect<void, OperatorError>;
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
    readonly cancel: (runId: RunId) => Effect.Effect<void, OperatorError>;
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
      runId: RunId,
    ) => Effect.Effect<RunGitHubChangesView, RunGitHubChangesError>;
    /** Pauses new work for a Loop; its existing Runs continue. */
    readonly pause: (loop: LoopName) => Effect.Effect<LoopRuntimeState, EnginePersistenceError>;
    /** Lets the Loop's triggers open new Runs again. */
    readonly unpause: (loop: LoopName) => Effect.Effect<LoopRuntimeState, EnginePersistenceError>;
  }
>()("@usine/orchestrator/Operator") {
  static readonly layer = Layer.effect(Operator, makeOperator).pipe(
    Layer.provide(Layer.merge(OperatorObservation.layer, RunGitHubChanges.layer)),
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
  RunDurationView,
  RunDetailView,
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
  DefectFailureView,
  AgentFailureView,
  BlockedFailureView,
  QuestionFailureView,
  RunawayFailureView,
  ChildSessionBudgetFailureView,
  FailureView,
  SucceededAttemptView,
  FailedAttemptView,
  CanceledAttemptView,
  AttemptOutcomeView,
  LocalWorkerAccess,
  SshWorkerAccess,
  WorkerAccess,
  AttemptView,
} from "./attempt.ts";
export {
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
export {
  TaskItemView,
  TaskLaneView,
  TaskCommentView,
  TaskView,
  type TaskReadError,
} from "./task.ts";
export {
  ApprovalNeed,
  CycleBudgetNeed,
  RunFailureNeed,
  PollFailureNeed,
  PreflightFindingNeed,
  BoardProjectionNeed,
  ScheduleFailureNeed,
  ConfigFileNeed,
  UnconfiguredWorkerNeed,
  UnconfirmedStopNeed,
  NeedView,
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
  FailedCheckView,
  PreflightCheckView,
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
} from "./configuration.ts";
export {
  WorkerSilentView,
  ProviderRetryingView,
  ConnectivityWarningView,
  RunningAttemptView,
  SuppressedForOperatorView,
  ClosedUnchangedView,
  RunFailedView,
  LoopPausedView,
  CycleBudgetUsedUpView,
  AwaitingApprovalView,
  QueuedForWorkerView,
  AwaitingPollView,
  StallReasonView,
  StalledItemView,
  ClosedRunView,
  WorkerView,
  RepositoryPollView,
  DeskView,
} from "./desk.ts";
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
