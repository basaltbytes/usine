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
import {
  RunDetailView,
  EditAndRetry,
  LoopNotFoundError,
  SessionIntervention,
  RosterAgentNotFoundError,
} from "./run.ts";
import { readTranscript, readUnrecordedEnds, runDuration, runView } from "./projection.ts";
import { readRunUsage } from "./usage.ts";
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
  | GitHubAppError;
export type OperatorError =
  | LoopNotFoundError
  | RosterAgentNotFoundError
  | RunEngineError
  | TranscriptAttemptNotFoundError
  | BoardMoveError
  | CycleBudgetResetRejectedError
  | RunGitHubChangesError;
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
  const loopMatches = yield* LoopMatches;
  const cache = yield* SynchronizedRef.make(Option.none<CachedOverview>());

  const projectOverview = Effect.fn("Operator.projectOverview")(function* (
    instance: LoadedInstance,
    pollFailures: ReadonlyArray<RepositoryPollFailure>,
    preflightFindings: ReadonlyArray<LabelPreflightFinding>,
    scheduleFailures: ReadonlyArray<ScheduleFailure>,
    revision: Option.Option<ProjectionRevision>,
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
            const view = runView(saved, paused);
            merged.set(view.id, view);
          }
          const projectRuns = [...merged.values()].sort(
            (a, b) => b.openedAt.localeCompare(a.openedAt) || b.id.localeCompare(a.id),
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
            itemLoops,
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
    const allRuns = new Map(views.map((run) => [run.id, run]));
    for (const project of projects) for (const run of project.runs) allRuns.set(run.id, run);
    const cardedItems = new Map(
      projects.flatMap(({ board }) =>
        board.lanes.flatMap(({ items }) =>
          items.flatMap((task) => task.items.map((item) => [item.itemKey, item] as const)),
        ),
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
    for (const { file, error } of instance.invalidAgents) {
      needsYou.push(new ConfigFileNeed({ id: `config-file:${file}`, kind: "agent", error }));
    }
    for (const { file, error } of instance.quarantinedLoops) {
      needsYou.push(new ConfigFileNeed({ id: `config-file:${file}`, kind: "loop", error }));
    }
    const configuredWorkers = new Set(instance.config.workers.map(({ name }) => name));
    for (const { worker, attempts } of workerAttempts) {
      if (configuredWorkers.has(worker)) continue;
      needsYou.push(
        new UnconfiguredWorkerNeed({ id: `unconfigured-worker:${worker}`, worker, attempts }),
      );
    }
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
            instance.config.repos.map(({ name, tags, lanes }) => [name, tags, lanes]),
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
    const [transcript, sessionState, usage, unrecordedEnds] = yield* Effect.all(
      [
        readTranscript(reader, snapshot, request),
        Effect.forEach(
          snapshot.attempts.filter((attempt) => Option.isNone(attempt.outcome)),
          (attempt) => reader.transcript(new TranscriptSessionsQuery({ attemptId: attempt.id })),
          { concurrency: "unbounded" },
        ),
        readRunUsage(reader, snapshot),
        readUnrecordedEnds(reader, snapshot),
      ],
      { concurrency: "unbounded" },
    );
    return new RunDetailView({
      run: runView(snapshot, paused),
      eventDedupKey: snapshot.event.dedupKey,
      eventPayload: snapshot.event.payload,
      transcript: transcript.events,
      sessionState: sessionState.flat().map(transcriptEvent),
      earlierTranscript: transcript.earlier,
      worker: snapshot.attempts.at(-1)?.worker ?? null,
      duration: runDuration(snapshot.attempts, unrecordedEnds),
      usage,
    });
  });

  const tasks = yield* TaskReader;
  // The desk: Running now, Not moving, Last outcomes, Workers, and poll times.
  const { desk } = yield* OperatorDesk;

  return { detail, overview, task: tasks.read, desk } as const;
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

    /**
     * Reads the Task holding Item `item` of `repository`: its Items, every saved Run on
     * them, and their harvested comments. Any member's number finds the Task; the view
     * names its originating Item. Fails when the Item is not among the Board's newest Items.
     */
    readonly task: (
      instance: LoadedInstance,
      repository: RepositoryName,
      item: ItemNumber,
    ) => Effect.Effect<TaskView, TaskReadError>;
    /**
     * Builds the supplied instance's desk: the Attempts in flight with their
     * last activity and open connectivity warnings, each Item a Loop's trigger
     * matches without an Attempt running on it and why, the Runs that closed
     * last, the Workers' slots and last preflight, and when each repository
     * was last polled.
     */
    readonly desk: (instance: LoadedInstance) => Effect.Effect<DeskView, OperatorObservationError>;
  }
>()("@usine/orchestrator/OperatorObservation") {
  static readonly layer = Layer.effect(OperatorObservation, makeOperatorObservation).pipe(
    Layer.provide(Layer.mergeAll(TaskReader.layer, OperatorDesk.layer, LoopMatches.layer)),
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
        message: `Agent ${edit.agent} is not in the roster`,
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
        message: `Loop ${current.run.loop} is not loaded, so Run ${runId} cannot run again`,
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
        message: `Agent ${edit.agent} is not in the roster`,
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
      // Recorded before the write, so the Run reader never takes the swap for an Agent's.
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

/** The operator's view of the factory and actions for approving, retrying, canceling, and directing work. */
export class Operator extends Context.Service<
  Operator,
  OperatorObservation["Service"] & {
    /** Answers the Item's current cycle Ask; polling refreshes its state before more Runs open. */
    readonly resetCycleBudget: (askId: CycleBudgetAskId) => Effect.Effect<void, OperatorError>;
    /**
     * Records the web UI's approval of a waiting Run as given by the operator
     * login `usine.yaml` names, or by no named approver when it names none;
     * execution still waits for Worker capacity.
     */
    readonly approve: (
      instance: LoadedInstance,
      runId: RunId,
    ) => Effect.Effect<void, OperatorError>;
    /** Resolves attention for the failed Attempt displayed to the operator; stale requests are rejected. */
    readonly resolveFailure: (
      runId: RunId,
      attemptId: AttemptId,
    ) => Effect.Effect<void, OperatorError>;
    /** Requests a new Attempt for a failed Run using its effective task and Agent, as the instance's operator. */
    readonly retry: (instance: LoadedInstance, runId: RunId) => Effect.Effect<void, OperatorError>;
    /** Atomically amends a failed Run before requesting its next Attempt. */
    readonly editAndRetry: (
      instance: LoadedInstance,
      runId: RunId,
      edit: EditAndRetry,
    ) => Effect.Effect<void, OperatorError>;
    /**
     * Opens a new Run for the Item state of a succeeded or canceled Run, with
     * the edit's task and roster Agent and the Step, approval, and cycle limit
     * the Run's Loop file names now, as run again by the operator login
     * `usine.yaml` names. Returns the new Run, or the cycle-budget Ask the Item
     * opened instead.
     */
    readonly runAgain: (
      instance: LoadedInstance,
      runId: RunId,
      edit: EditAndRetry,
    ) => Effect.Effect<RunAgainResult, OperatorError>;
    /** Delivers an attributed action through a live session's Attempt channel. */
    readonly intervene: (
      instance: LoadedInstance,
      runId: RunId,
      input: SessionIntervention,
    ) => Effect.Effect<void, OperatorError>;
    /** Cancels an open Run and interrupts its current Attempt; an already closed Run is unchanged. */
    readonly cancel: (runId: RunId) => Effect.Effect<void, OperatorError>;
    /**
     * Answers an `UnconfiguredWorkerNeed`: startup stops reconciling the
     * Attempts recorded on `worker` and whatever they left stays on it. A
     * Worker `usine.yaml` declares is left unchanged.
     */
    readonly discardLeftovers: (worker: WorkerName) => Effect.Effect<void, OperatorError>;
    /**
     * Records the move, swaps lane labels on GitHub, and hints an authoritative refresh
     * of its Board position and Loop matches. A move that cannot be recorded is not sent.
     */
    readonly moveBoardItem: (
      instance: LoadedInstance,
      move: BoardMove,
    ) => Effect.Effect<void, BoardMoveError>;
    /**
     * What changed on the Run's GitHub Item while each of its Attempts was at work, read
     * from the Item's timeline: the Agent's label, comment, and review changes, and the
     * operator's Board moves.
     */
    readonly githubChanges: (
      runId: RunId,
    ) => Effect.Effect<RunGitHubChangesView, RunGitHubChangesError>;
    /** Pauses new work for a Loop while its existing Runs continue. */
    readonly pause: (loop: LoopName) => Effect.Effect<LoopRuntimeState, EnginePersistenceError>;
    /** Allows the Loop's triggers to open new Runs again. */
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
export { UsageCostView, SessionUsageView, PoolUsageView, RunUsageView } from "./usage.ts";
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
  AttemptView,
} from "./attempt.ts";
export {
  BoardLaneId,
  BoardLaneOrigin,
  BoardItemLink,
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
  HeldForOperatorView,
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
