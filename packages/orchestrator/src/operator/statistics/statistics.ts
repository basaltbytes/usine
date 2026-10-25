import type { LoadedInstance } from "@usine/config/instance";
import type { ItemKey } from "@usine/core/item";
import type { RepositoryName } from "@usine/core/repository";
import * as RunState from "@usine/core/run/state";
import type { RunStoreError } from "@usine/engine/engine";
import { ItemProjectionReader } from "@usine/engine/item-projection";
import { RunReader } from "@usine/engine/run-reader";
import { Context, DateTime, Effect, Layer, Option, Result, Schema } from "effect";
import { type ProjectedItem, projectedItem } from "../../board/items.ts";
import { taskCards } from "../../board/tasks.ts";
import { runView } from "../projection.ts";
import { RunUsageReader } from "../usage.ts";
import { type PullRequestMerge, statisticsView, windowStart } from "./compute.ts";
import type { StatisticsView, StatisticsWindow } from "./view.ts";

/** The number of newest Items per repository searched for merged pull requests, as on a Board. */
const STATISTICS_ITEMS = 500;

const decodeMergedAt = Schema.decodeUnknownOption(
  Schema.Struct({ mergedAt: Schema.NullOr(Schema.DateTimeUtcFromString) }),
);

const makeStatistics = Effect.gen(function* () {
  const reader = yield* RunReader;
  const itemReader = yield* ItemProjectionReader;
  const usageReader = yield* RunUsageReader;

  /**
   * Returns each pull request of `repository` merged at or after `since` among its newest Items,
   * with every Run on the Items of its Task.
   */
  const merges = Effect.fn("Operator.statistics.merges")(function* (
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
    const found = cards.flatMap(({ view }) =>
      view.items.flatMap(({ itemKey }): ReadonlyArray<PullRequestMerge> => {
        const at = mergedAt.get(itemKey);
        return at === undefined
          ? []
          : [{ mergedAt: at, runs: view.runs.flatMap(({ id }) => summaries.get(id) ?? []) }];
      }),
    );
    yield* Effect.logDebug("Read the merged pull requests for the statistics", {
      repository,
      merged: found.length,
      runs: history.length,
    });
    return found;
  });

  const statistics = Effect.fn("Operator.statistics")(function* (
    instance: LoadedInstance,
    window: StatisticsWindow,
  ) {
    yield* Effect.annotateCurrentSpan({ window });
    const now = yield* DateTime.now;
    const since = windowStart(window, now);
    const [closed, listed, repositoryMerges] = yield* Effect.all(
      [
        reader.closedSince(since),
        reader.list({ closedLimit: 0 }),
        Effect.forEach(instance.config.repos, ({ name }) => merges(name, since), {
          concurrency: 4,
        }),
      ] as const,
      { concurrency: "unbounded" },
    );
    const open = listed.filter(({ run }) => RunState.isOpen(run.state));
    // The reader keeps ended Attempts' reports, so a closed Run's usage is read once per process.
    const usage = new Map(
      yield* Effect.forEach(
        closed,
        (summary) =>
          usageReader.read(summary).pipe(Effect.map((read) => [summary.run.id, read] as const)),
        { concurrency: 4 },
      ),
    );
    const view = statisticsView({
      window,
      now,
      runs: [...closed, ...open],
      usage,
      merges: repositoryMerges.flat(),
      workers: instance.config.workers.map(({ name, maxConcurrentAttempts }) => ({
        name,
        slots: maxConcurrentAttempts,
      })),
    });
    yield* Effect.logDebug("Computed the operator statistics", {
      window,
      from: view.from,
      closedRuns: closed.length,
      openRuns: open.length,
      mergedPullRequests: view.firstPass.merged,
    });
    return view;
  });

  return { statistics };
});

/** Computes the operator's statistics from the stored Runs, their usage, and the stored Items. */
export class OperatorStatistics extends Context.Service<
  OperatorStatistics,
  {
    /** Returns the statistics of `window`, as described in `StatisticsView`. */
    readonly statistics: (
      instance: LoadedInstance,
      window: StatisticsWindow,
    ) => Effect.Effect<StatisticsView, RunStoreError>;
  }
>()("@usine/orchestrator/OperatorStatistics") {
  static readonly layer = Layer.effect(OperatorStatistics, makeStatistics);
}
