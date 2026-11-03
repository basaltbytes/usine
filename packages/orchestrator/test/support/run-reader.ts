import { BoardRunHistory, ItemRunHistory, type RunSummary } from "@usine/engine/run-reader";
import { Array as EffectArray, DateTime } from "effect";
import { runSummaryView } from "../../src/operator/projection.ts";
import { runUsageSource, taskUsage } from "../../src/operator/usage.ts";

/** Supplies aggregate history for operator tests that inject saved runs. */
export const boardHistory = (runs: ReadonlyArray<RunSummary>): BoardRunHistory =>
  BoardRunHistory.make({
    runs,
    items: Object.values(EffectArray.groupBy(runs, ({ itemKey }) => itemKey)).flatMap((history) => {
      const first = history[0];
      if (first === undefined) return [];
      const views = history.map((run) => runSummaryView(run, new Set(), new Map()));
      const { durationMillis, runningSince, unmeasured } = taskUsage(views, new Map());
      return [
        ItemRunHistory.make({
          itemKey: first.itemKey,
          runCount: history.length,
          attemptCount: history.reduce((sum, run) => sum + run.attempts.length, 0),
          durationMillis,
          runningSince,
          unmeasured,
          pullRequestUrls: history.flatMap(({ pullRequestUrl }) => pullRequestUrl ?? []),
          loops: Object.values(EffectArray.groupBy(history, ({ run }) => run.loop)).flatMap(
            (history) => {
              const ordered = [...history].sort(
                (a, b) =>
                  DateTime.toEpochMillis(a.run.openedAt) - DateTime.toEpochMillis(b.run.openedAt) ||
                  a.run.id.localeCompare(b.run.id),
              );
              const first = ordered[0];
              const last = ordered.at(-1);
              return first === undefined || last === undefined
                ? []
                : [
                    {
                      loop: first.run.loop,
                      state: last.run.state,
                      firstOpenedAt: DateTime.formatIso(first.run.openedAt),
                      firstRunId: first.run.id,
                      latestOpenedAt: DateTime.formatIso(last.run.openedAt),
                      latestRunId: last.run.id,
                    },
                  ];
            },
          ),
          usageSources: history.map(runUsageSource),
        }),
      ];
    }),
  });
