import { jsonKey } from "@usine/core/json-key";
import { upgradeAttentionFor } from "../upgrade.ts";
import { capacityAttentionFor } from "../capacity.ts";
import { WebhookHealth } from "../../webhooks.ts";
import { webhookAttentionFor } from "../webhooks.ts";
import { groupProjectViews } from "../projects.ts";
import { readApprovalItems } from "../approval.ts";
import { boardRepositories } from "@usine/config/project";
import { AttentionAcknowledgements } from "@usine/engine/attention";
import { attentionKey, partitionNeeds, projectAttention, poolAttentionFor } from "../attention.ts";
import { GitHubLabelName } from "@usine/core/label";
import { BillingPools, type PoolDescriptor } from "@usine/core/agent/pool";
import type { LoadedInstance } from "@usine/config/instance";
import { CycleBudgets } from "@usine/engine/cycle-budget";
import { LoopName } from "@usine/core/loop";
import { RunId } from "@usine/core/run";
import { GitHubItemKey, type ItemKey } from "@usine/core/item";
import { canonicalRepositoryName } from "@usine/core/repository";
import {
  RunEngine,
  type RunStoreError,
  type UnconfirmedStop,
  UnconfirmedStops,
} from "@usine/engine/engine";
import { ItemProjectionReader } from "@usine/engine/item-projection";
import { LoopControl } from "@usine/engine/loop-control";
import {
  type ProjectionRevision,
  RunReader,
  type RunUsageSource,
  type ItemRunHistory,
} from "@usine/engine/run-reader";
import { RepositoryLabelProjectionReader } from "@usine/engine/repository-label-projection";
import {
  Array as EffectArray,
  Context,
  Effect,
  Layer,
  Option,
  Schema,
  SynchronizedRef,
} from "effect";
import { readBoardItems } from "../../board/selection.ts";
import { settledItemState } from "../../board/items.ts";
import { projectBoard } from "../../board/projection.ts";
import type { LabelPreflightFinding } from "../../label-reconciler.ts";
import { LoopMatches } from "../../loop-matches.ts";
import { PollingTriggers, type RepositoryPollFailure } from "../../polling-triggers.ts";
import { ScheduleTriggers, type ScheduleFailure } from "../../schedule-triggers.ts";
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
} from "../need.ts";
import {
  BoardTaskView,
  BoardView,
  LabelView,
  ReadOnlyBoardLaneView,
  WritableBoardLaneView,
} from "../board.ts";
import { LoopView, ProjectView, ReadyOverview } from "./view.ts";
import type { RunSummaryView } from "../run.ts";
import {
  type EngineWaits,
  readEngineWaits,
  readRunningEvents,
  runSummaryView,
  declaredWorkers,
  workerAccesses,
} from "../projection.ts";
import { RunUsageReader, type RunUsageView, taskHistoryUsage } from "../usage.ts";
import { quotaWaits } from "../machines.ts";
import { type ProvisioningPause, WorkerStatus } from "../../worker-status.ts";
import { workerAttentionFor } from "../worker-attention.ts";

/** The number of closed Runs the overview keeps next to the open ones. */
const OVERVIEW_CLOSED_RUNS = 50;

/**
 * Each Board Run's usage at projection time, and the Runs whose Attempt was running then. Token
 * reports don't change the projection revision, so a cached overview rereads these Runs' usage.
 */
interface BoardUsage {
  readonly runs: ReadonlyMap<RunId, RunUsageView>;
  readonly working: ReadonlyArray<RunUsageSource>;
  readonly history: ReadonlyArray<ItemRunHistory>;
}

interface CachedOverview {
  readonly token: string;
  readonly overview: ReadyOverview;
  readonly usage: BoardUsage;
  readonly running: ReadonlyArray<RunSummaryView>;
}

/**
 * Returns `overview` with the usage of every card that contains a `changed` Run recomputed from
 * `usage`, per pool of `pools`.
 */
const withRunUsage = (
  overview: ReadyOverview,
  changed: ReadonlySet<RunId>,
  usage: ReadonlyMap<RunId, RunUsageView>,
  history: ReadonlyArray<ItemRunHistory>,
  pools: ReadonlyArray<PoolDescriptor>,
): ReadyOverview => {
  const byItem = new Map(history.map((item) => [item.itemKey, item]));
  return ReadyOverview.make({
    ...overview,
    projects: overview.projects.map((project) =>
      ProjectView.make({
        ...project,
        board: BoardView.make({
          ...project.board,
          lanes: project.board.lanes.map((lane) => {
            const items = lane.items.map((task) => {
              const items = task.items.flatMap(({ itemKey }) => byItem.get(itemKey) ?? []);
              return items.some(({ usageSources }) =>
                usageSources.some(({ run }) => changed.has(run.id)),
              )
                ? BoardTaskView.make({ ...task, usage: taskHistoryUsage(pools, items, usage) })
                : task;
            });
            return lane._tag === "WritableBoardLane"
              ? WritableBoardLaneView.make({ ...lane, items })
              : ReadOnlyBoardLaneView.make({ ...lane, items });
          }),
        }),
      }),
    ),
  });
};

const makeOverviewReader = Effect.gen(function* () {
  const acknowledgements = yield* AttentionAcknowledgements;
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
  const engine = yield* Effect.serviceOption(RunEngine);
  const readWaits = readEngineWaits(engine);
  const upgradeAttention = upgradeAttentionFor(
    Effect.map(readWaits, ({ upgrade }) => upgrade),
    acknowledgements,
  );
  const capacityAttention = capacityAttentionFor(
    Effect.map(readWaits, ({ capacity }) => capacity),
    acknowledgements,
  );
  const workerStatus = yield* WorkerStatus;
  const workerAttention = workerAttentionFor(reader, acknowledgements, workerStatus);
  const pools = yield* BillingPools;
  const poolAttention = poolAttentionFor(reader, acknowledgements, pools);
  const webhookHealth = yield* WebhookHealth;
  const webhookAttention = webhookAttentionFor(webhookHealth, acknowledgements);

  const projectOverview = Effect.fn("Operator.projectOverview")(function* (
    instance: LoadedInstance,
    pollFailures: ReadonlyArray<RepositoryPollFailure>,
    preflightFindings: ReadonlyArray<LabelPreflightFinding>,
    scheduleFailures: ReadonlyArray<ScheduleFailure>,
    revision: Option.Option<ProjectionRevision>,
    unconfirmedStops: ReadonlyArray<UnconfirmedStop>,
    provisioning: ReadonlyArray<ProvisioningPause>,
    engineWaits: EngineWaits,
  ) {
    const [snapshots, states, cycleAsks, workerAttempts] = yield* Effect.all(
      [
        reader.list({ closedLimit: OVERVIEW_CLOSED_RUNS }),
        controls.states,
        budgets.asks,
        reader.attemptsByWorker,
      ] as const,
      { concurrency: "unbounded" },
    );
    const paused = new Set(states.filter((state) => state.paused).map((state) => state.loop));
    const runWorkers = declaredWorkers(instance.config.workers);
    const waits = quotaWaits(provisioning);
    const views = snapshots.map((snapshot) =>
      runSummaryView(snapshot, paused, runWorkers, waits, engineWaits),
    );
    const runsByRepository = new Map<string, Array<(typeof views)[number]>>();
    for (const view of views) {
      const projectRuns = runsByRepository.get(view.repository) ?? [];
      projectRuns.push(view);
      runsByRepository.set(view.repository, projectRuns);
    }
    const projected = yield* Effect.forEach(
      boardRepositories(instance.config),
      (repository) =>
        Effect.gen(function* () {
          const { name } = repository;
          const projectFindings = preflightFindings.filter(
            ({ repository: findingRepository }) => findingRepository === name,
          );
          const [boardItems, labelProjection] = yield* Effect.all(
            [readBoardItems(itemReader, name, snapshots), repositoryLabels.get(name)] as const,
            { concurrency: "unbounded" },
          );
          const [history, matches] = yield* Effect.all(
            [
              reader.board(
                boardItems.map(({ itemKey }) => itemKey),
                unconfirmedStops.map(({ runId }) => runId),
              ),
              loopMatches.matching(instance, repository, boardItems),
            ] as const,
            { concurrency: "unbounded" },
          );
          const itemLoops = new Map<ItemKey, Array<LoopName>>();
          for (const { loop, item } of matches) {
            itemLoops.set(item.itemKey, [...(itemLoops.get(item.itemKey) ?? []), loop.name]);
          }
          const merged = new Map((runsByRepository.get(name) ?? []).map((run) => [run.id, run]));
          for (const saved of history.runs) {
            const view = runSummaryView(saved, paused, runWorkers, waits, engineWaits);
            merged.set(view.id, view);
          }
          const projectRuns = [...merged.values()].sort(
            (a, b) => b.openedAt.localeCompare(a.openedAt) || b.id.localeCompare(a.id),
          );
          // The reader keeps ended Attempts' reports, so only running Attempts are read again. A
          // running Run's Event gives its card's lane while its Item has no lane label.
          const [usages, runEvents] = yield* Effect.all(
            [
              Effect.forEach(
                history.items.flatMap(({ usageSources }) => usageSources),
                (summary) =>
                  usageReader
                    .read(summary)
                    .pipe(Effect.map((usage) => [summary.run.id, usage] as const)),
                { concurrency: 4 },
              ),
              readRunningEvents(reader, history.runs),
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
            pools,
            cycleAsks.map(({ itemKey }) => itemKey),
            itemLoops,
            runUsage,
            runEvents,
            new Set(unconfirmedStops.map(({ runId }) => runId)),
            new Map(history.items.map((item) => [item.itemKey, item])),
          );
          const working = history.items
            .flatMap(({ usageSources }) => usageSources)
            .filter(({ attempts }) => attempts.some(({ ended }) => !ended));
          const overviewRuns = runsByRepository.get(name) ?? [];
          yield* Effect.logDebug("Bounded overview run history", {
            repository: name,
            historyRuns: projectRuns.length,
            overviewRuns: overviewRuns.length,
            closedLimit: OVERVIEW_CLOSED_RUNS,
          });
          return {
            name,
            projectFindings,
            projectRuns,
            overviewRuns,
            board,
            catalog,
            runUsage,
            working,
            history: history.items,
          } as const;
        }),
      { concurrency: 4 },
    );
    const allRuns = new Map(views.map((run) => [run.id, run]));
    for (const { projectRuns } of projected)
      for (const run of projectRuns) allRuns.set(run.id, run);
    // A Run of a repository that usine.yaml no longer lists has no Project to mark.
    const managed = new Set(instance.config.repos.map(({ name }) => canonicalRepositoryName(name)));
    const managedRuns: Array<(typeof views)[number]> = [];
    for (const run of allRuns.values()) {
      if (managed.has(canonicalRepositoryName(run.repository))) managedRuns.push(run);
      else if (run.state === "Waiting" || run.canResolveFailure)
        yield* Effect.logDebug(
          "Run's repository is not in usine.yaml; left out of Needs attention",
          { runId: run.id, repository: run.repository, state: run.state },
        );
    }
    const failedItems = new Set(
      managedRuns.flatMap((run) =>
        run.state !== "Waiting" && run.canResolveFailure ? [run.itemKey] : [],
      ),
    );
    // The Items of failed Runs that are closed, merged, or gone, with their state.
    const settledItemStates = yield* Effect.forEach(
      failedItems,
      (key) =>
        settledItemState(key).pipe(
          Effect.provideService(ItemProjectionReader, itemReader),
          Effect.map(Option.map((state) => [key, state] as const)),
        ),
      { concurrency: 4 },
    );
    const settledItems = new Map(EffectArray.getSomes(settledItemStates));
    const projects = groupProjectViews(
      instance.config,
      projected.map(({ name, projectFindings, overviewRuns, board, catalog }) =>
        ProjectView.make({
          repository: name,
          status: "clear",
          runs: overviewRuns,
          board,
          labels: catalog.map(({ name: label, color, description }) =>
            LabelView.make({
              name: GitHubLabelName.make(label),
              color: Option.getOrNull(color),
              description: Option.getOrNull(description),
            }),
          ),
          preflightFindings: projectFindings,
        }),
      ),
    );
    const usage: BoardUsage = {
      runs: new Map(projected.flatMap(({ runUsage }) => [...runUsage])),
      working: projected.flatMap(({ working }) => working),
      history: projected.flatMap(({ history }) => history),
    };
    const loops = instance.loops.map((loop) =>
      LoopView.make({
        name: loop.name,
        trigger: loop.trigger.on,
        agent: loop.agent,
        paused: paused.has(loop.name),
      }),
    );
    const needsYou: Array<NeedView> = [];
    for (const ask of cycleAsks) {
      const item = Schema.decodeOption(GitHubItemKey)(ask.itemKey);
      needsYou.push(
        CycleBudgetNeed.make({
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
    const cardedItems = new Map(
      projects.flatMap(({ board }) =>
        board.lanes.flatMap(({ items }) =>
          items.flatMap((task) => task.items.map((item) => [item.itemKey, item] as const)),
        ),
      ),
    );
    const approvalItems = yield* readApprovalItems(managedRuns, cardedItems).pipe(
      Effect.provideService(ItemProjectionReader, itemReader),
    );
    const fixRuns = yield* reader.ciFixRuns(
      managedRuns.filter(({ canResolveFailure }) => canResolveFailure).map(({ id }) => id),
    );
    for (const run of managedRuns) {
      if (run.state === "Waiting") {
        needsYou.push(
          ApprovalNeed.make({
            id: `approval:${run.id}`,
            repository: run.repository,
            runId: run.id,
            approvalReason: run.approvalReason,
            loop: run.loop,
            item: approvalItems.get(run.itemKey) ?? null,
          }),
        );
      } else if (run.canResolveFailure) {
        const attempt = run.attempts.at(-1);
        if (attempt?.outcome?._tag !== "Failed") {
          return yield* Effect.die(new Error(`Failed run ${run.id} has no failed attempt`));
        }
        const settled = settledItems.get(run.itemKey);
        if (settled !== undefined) {
          yield* Effect.logDebug(
            "Failed Run's Item is closed; left out of Needs attention and the Project status",
            {
              runId: run.id,
              itemKey: run.itemKey,
              itemState: settled,
              failure: attempt.outcome.failure._tag,
            },
          );
          continue;
        }
        const failed = {
          id: `run-failure:${run.id}:${attempt.id}`,
          repository: run.repository,
          runId: run.id,
          loop: run.loop,
          failure: attempt.outcome.failure,
          fixRun: fixRuns.get(run.id) ?? null,
        };
        // The key stays absent for other failures, so their attention revisions don't change.
        needsYou.push(
          RunFailureNeed.make(
            run.canApplyCiLabels ? { ...failed, unfinishedCiAttemptId: attempt.id } : failed,
          ),
        );
      }
    }
    for (const project of projects) {
      for (const failure of project.board.failures) {
        needsYou.push(
          BoardProjectionNeed.make({
            id: `board-projection:${failure.repository}:${failure.itemKey}`,
            failure,
          }),
        );
      }
    }
    pollFailures.forEach((failure) => {
      needsYou.push(
        PollFailureNeed.make({
          id: `poll-failure:${jsonKey([failure.repository, failure.errorTag, failure.message])}`,
          failure,
        }),
      );
    });
    preflightFindings.forEach((finding) => {
      needsYou.push(
        PreflightFindingNeed.make({
          id: `preflight:${finding.repository}:${finding.label}`,
          finding,
        }),
      );
    });
    scheduleFailures.forEach((failure) => {
      needsYou.push(
        ScheduleFailureNeed.make({
          id: `schedule-failure:${jsonKey([
            failure.loop,
            failure._tag,
            failure._tag === "ScheduleTickFailure" ? failure.repository : null,
          ])}`,
          failure,
        }),
      );
    });
    for (const { file, error } of instance.invalidAgents) {
      needsYou.push(ConfigFileNeed.make({ id: `config-file:${file}`, kind: "agent", error }));
    }
    for (const { file, error } of instance.quarantinedLoops) {
      needsYou.push(ConfigFileNeed.make({ id: `config-file:${file}`, kind: "loop", error }));
    }
    const configuredWorkers = new Set(instance.config.workers.map(({ name }) => name));
    for (const { worker, attempts, running } of workerAttempts) {
      if (configuredWorkers.has(worker)) continue;
      needsYou.push(
        UnconfiguredWorkerNeed.make({
          id: `unconfigured-worker:${worker}`,
          worker,
          attempts,
          running,
        }),
      );
    }
    for (const { attemptId, runId, worker } of unconfirmedStops) {
      let run = allRuns.get(runId);
      if (run === undefined) {
        const summary = yield* reader.summary(runId);
        run = runSummaryView(summary, paused, runWorkers, waits, engineWaits);
      }
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
        UnconfirmedStopNeed.make({
          id: `unconfirmed-stop:${attemptId}`,
          repository: run.repository,
          runId,
          loop: run.loop,
          attemptNumber: attempt.number,
          worker,
        }),
      );
    }
    const saved = yield* acknowledgements.list;
    const { needsYou: visible, dismissedNeeds } = partitionNeeds(needsYou, saved);
    const overview = ReadyOverview.make({
      projects: projectAttention(projects, visible),
      loops,
      needsYou: visible,
      dismissedNeeds,
    });
    yield* Effect.logDebug("Refreshed operator overview", {
      revision,
      runs: views.length,
      needsYou: visible.length,
      dismissedNeeds: dismissedNeeds.length,
      runsAtWork: usage.working.length,
    });
    return { overview, usage, running: views.filter((run) => run.state === "Running") } as const;
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
      overview: withRunUsage(cached.overview, changed, runs, cached.usage.history, pools),
      usage: { ...cached.usage, runs },
    };
  });

  const overview = Effect.fn("Operator.overview")((instance: LoadedInstance) =>
    SynchronizedRef.modifyEffect(cache, (cached) =>
      Effect.gen(function* () {
        const [revision, latestPoll, latestSchedule, unconfirmedStops, provisioning] =
          yield* Effect.all(
            [
              reader.revision,
              polling.latest,
              schedules.latest,
              stops.list,
              workerStatus.provisioning,
            ] as const,
            { concurrency: "unbounded" },
          );
        const engineWaits = yield* readWaits;
        const reports = {
          pollReported: Option.isSome(latestPoll),
          scheduleReported: Option.isSome(latestSchedule),
        };
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
          jsonKey([
            value,
            instance.config.repos,
            instance.config.projects,
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
            provisioning,
            engineWaits,
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
            unconfirmedStops,
            provisioning,
            engineWaits,
          );
          return [{ ...projected, reports }, Option.none<CachedOverview>()] as const;
        }
        if (Option.isSome(cached) && cached.value.token === token.value) {
          yield* Effect.logDebug("Reusing unchanged operator overview", {
            revision,
          });
          const current = yield* refreshWorkingUsage(cached.value);
          return [
            { overview: current.overview, running: current.running, reports },
            Option.some(current),
          ] as const;
        }
        const projected = yield* projectOverview(
          instance,
          pollFailures,
          preflightFindings,
          scheduleFailures,
          revision,
          unconfirmedStops,
          provisioning,
          engineWaits,
        );
        return [
          { ...projected, reports },
          Option.some({ token: token.value, ...projected }),
        ] as const;
      }),
    ).pipe(
      Effect.flatMap(({ overview, running, reports }) =>
        workerAttention(overview, running, instance.config.workers).pipe(
          Effect.flatMap(poolAttention),
          Effect.flatMap(upgradeAttention),
          Effect.flatMap(capacityAttention),
          Effect.flatMap((view) => webhookAttention(view, instance.config.webhooks)),
          Effect.tap(({ needsYou, dismissedNeeds }) =>
            reports.pollReported && reports.scheduleReported
              ? acknowledgements.prune([...needsYou, ...dismissedNeeds].map(attentionKey))
              : Effect.logDebug("Deferred attention pruning until trigger sources report", reports),
          ),
        ),
      ),
    ),
  );

  return { read: overview } as const;
});

/** A failure to read the stored records that the overview projects. */
type OverviewReadError = RunStoreError;

/** Builds the instance's Projects, Boards, and Needs attention, and caches the result. */
export class OverviewReader extends Context.Service<
  OverviewReader,
  {
    /**
     * Returns the instance's overview with Worker, pool, upgrade, capacity, and webhook attention
     * applied and no access filter. The result is cached until the projection revision or
     * instance changes, except for running Attempts' token usage.
     */
    readonly read: (instance: LoadedInstance) => Effect.Effect<ReadyOverview, OverviewReadError>;
  }
>()("@usine/orchestrator/operator/overview/overview/OverviewReader") {
  static readonly layer = Layer.effect(OverviewReader, makeOverviewReader);
}
