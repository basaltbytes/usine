import { ConfigurationStore, type ConfigurationStoreError } from "@usine/config/configuration";
import type { LoadedInstance } from "@usine/config/instance";
import type { ItemKey } from "@usine/core/item";
import type { RepositoryName } from "@usine/core/repository";
import * as RunState from "@usine/core/run/state";
import { CycleBudgets } from "@usine/engine/cycle-budget";
import type { RunStoreError } from "@usine/engine/engine";
import { ItemProjectionReader } from "@usine/engine/item-projection";
import { RunReader, type RunSummary } from "@usine/engine/run-reader";
import { Context, DateTime, Effect, Layer, Option, Result, Schema } from "effect";
import { type ProjectedItem, projectedItem } from "../../board/items.ts";
import { taskCards } from "../../board/tasks.ts";
import { runView } from "../projection.ts";
import { RunUsageReader } from "../usage.ts";
import { cacheStatistics } from "./cache.ts";
import { readWorkerCapacity } from "./workers.ts";
import { runStatisticsView } from "./runs.ts";
import { type MergedTask, taskStatisticsView } from "./tasks.ts";
import type { RunStatisticsView, StatisticsView, StatisticsWindow } from "./view.ts";
import { sum, windowStart } from "./window.ts";

/** The number of newest Items per repository searched for merged pull requests, as on a Board. */
const STATISTICS_ITEMS = 500;

const decodeMergedAt = Schema.decodeUnknownOption(
  Schema.Struct({ mergedAt: Schema.NullOr(Schema.DateTimeUtcFromString) }),
);

const makeStatistics = Effect.gen(function* () {
  const reader = yield* RunReader;
  const configuration = yield* ConfigurationStore;
  const itemReader = yield* ItemProjectionReader;
  const usageReader = yield* RunUsageReader;
  const budgets = yield* CycleBudgets;

  const usageOf = (runs: ReadonlyArray<RunSummary>) =>
    Effect.forEach(
      runs,
      (summary) =>
        usageReader.read(summary).pipe(Effect.map((read) => [summary.run.id, read] as const)),
      { concurrency: 4 },
    ).pipe(Effect.map((entries) => new Map(entries)));

  /**
   * Returns each task of `repository` among its newest Items whose pull request merged at or after
   * `since`, with every Run on its Items and the resets of their cycle budgets.
   */
  const mergedTasks = Effect.fn("Operator.statistics.mergedTasks")(function* (
    repository: RepositoryName,
    since: Option.Option<DateTime.Utc>,
  ) {
    yield* Effect.annotateCurrentSpan({ repository });
    const stored = yield* itemReader.list(repository, { limit: STATISTICS_ITEMS });
    const items: Array<ProjectedItem> = [];
    const mergedAt = new Map<ItemKey, DateTime.Utc>();
    for (const item of stored) {
      const projected = yield* Effect.result(projectedItem(item));
      // The Board reports an Item it can't project in Needs attention.
      if (Result.isFailure(projected)) continue;
      items.push(projected.success);
      if (projected.success.state !== "pr-merged") continue;
      const merged = Option.flatMap(decodeMergedAt(item.payload), ({ mergedAt }) =>
        Option.fromNullOr(mergedAt),
      );
      if (
        Option.isSome(merged) &&
        Option.match(since, {
          onNone: () => true,
          onSome: (from) => DateTime.isGreaterThanOrEqualTo(merged.value, from),
        })
      )
        mergedAt.set(item.itemKey, merged.value);
    }
    if (mergedAt.size === 0) {
      yield* Effect.logDebug("No pull request merged in the statistics window", {
        repository,
        items: items.length,
      });
      return [];
    }
    const history = yield* reader.forItems(items.map(({ itemKey }) => itemKey));
    const summaries = new Map(history.map((summary) => [summary.run.id, summary]));
    const cards = taskCards(
      repository,
      items,
      history.map((summary) => runView(summary, new Set(), new Map())),
      [],
      new Map(),
      new Map(),
    );
    const found = cards.flatMap(({ view }) => {
      const merges = view.items.flatMap(({ itemKey }) => {
        const at = mergedAt.get(itemKey);
        return at === undefined ? [] : [at];
      });
      const runs = view.runs.flatMap(({ id }) => summaries.get(id) ?? []);
      const [first] = merges;
      return first === undefined || runs.length === 0
        ? []
        : [
            {
              view,
              runs,
              mergedAt: merges.reduce(
                (latest, at) => (DateTime.isGreaterThan(at, latest) ? at : latest),
                first,
              ),
            },
          ];
    });
    const tasks = yield* Effect.forEach(
      found,
      ({ view, runs, mergedAt }) =>
        Effect.forEach(view.items, ({ itemKey }) => budgets.generation(itemKey)).pipe(
          Effect.map((generations): MergedTask => ({
            repository,
            number: view.items[0]?.number ?? view.number,
            mergedAt,
            runs,
            budgetResets: sum(generations),
          })),
        ),
      { concurrency: 4 },
    );
    yield* Effect.logDebug("Read the merged tasks for the statistics", {
      repository,
      mergedPullRequests: mergedAt.size,
      tasks: tasks.length,
      runs: history.length,
    });
    return tasks;
  });

  const statistics = Effect.fn("Operator.statistics")(function* (
    instance: LoadedInstance,
    window: StatisticsWindow,
  ) {
    yield* Effect.annotateCurrentSpan({ window });
    const now = yield* DateTime.now;
    const tasks = (yield* Effect.forEach(
      instance.config.repos,
      ({ name }) => mergedTasks(name, windowStart(window, now)),
      { concurrency: 4 },
    )).flat();
    // The reader keeps ended Attempts' reports, so a closed Run's usage is read once per process.
    const usage = yield* usageOf(tasks.flatMap(({ runs }) => runs));
    const view = taskStatisticsView({ window, now, tasks, usage });
    yield* Effect.logDebug("Computed the task statistics", {
      window,
      from: view.from,
      tasks: view.tasks.length,
      timedTasks: view.time?.tasks ?? 0,
      meteredTasks: view.tokens?.tasks ?? 0,
    });
    return view;
  });

  const runStatistics = Effect.fn("Operator.runStatistics")(function* (
    instance: LoadedInstance,
    window: StatisticsWindow,
  ) {
    yield* Effect.annotateCurrentSpan({ window });
    const now = yield* DateTime.now;
    const [closed, listed] = yield* Effect.all(
      [reader.closedSince(windowStart(window, now)), reader.list({ closedLimit: 0 })] as const,
      { concurrency: "unbounded" },
    );
    const open = listed.filter(({ run }) => RunState.isOpen(run.state));
    const view = runStatisticsView({
      window,
      now,
      runs: [...closed, ...open],
      usage: yield* usageOf(closed),
      workers: yield* Effect.forEach(
        instance.config.workers,
        (worker) => readWorkerCapacity(configuration, worker),
        { concurrency: 4 },
      ),
    });
    yield* Effect.logDebug("Computed the run statistics", {
      window,
      from: view.from,
      closedRuns: closed.length,
      openRuns: open.length,
    });
    return view;
  });

  return {
    statistics: cacheStatistics(reader.revision, statistics),
    runStatistics: cacheStatistics(reader.revision, runStatistics),
  };
});

/** Computes the operator's statistics from the stored Items, Runs, usage, and cycle budgets. */
export class OperatorStatistics extends Context.Service<
  OperatorStatistics,
  {
    /** Returns the tasks done in `window`, as described in `StatisticsView`. */
    readonly statistics: (
      instance: LoadedInstance,
      window: StatisticsWindow,
    ) => Effect.Effect<StatisticsView, RunStoreError>;
    /** Returns the Runs of `window`, as described in `RunStatisticsView`. */
    readonly runStatistics: (
      instance: LoadedInstance,
      window: StatisticsWindow,
    ) => Effect.Effect<RunStatisticsView, RunStoreError | ConfigurationStoreError>;
  }
>()("@usine/orchestrator/OperatorStatistics") {
  static readonly layer = Layer.effect(OperatorStatistics, makeStatistics);
}
