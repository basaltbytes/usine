import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RunId } from "@usine/core/run";
import { RunState } from "@usine/core/run/state";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { Array as EffectArray, Effect, Schema } from "effect";
import {
  jsonArrayValues,
  jsonEach,
  jsonExtract,
  jsonGroupArray,
  jsonObject,
  jsonValue,
  elapsedMillis,
} from "../database/dialect.ts";
import type { RunDatabaseClient } from "../database/database.ts";
import { attempts, runs, steps, triggerEvents } from "../database/schema.ts";
import { ItemRunHistory, RunUsageSource } from "../run-reader/model.ts";

export const runPullRequestUrl = sql<
  string | null
>`(select ${jsonExtract(sql`fact.value`, "$.url")} from ${jsonEach(steps.result, "$.facts")} as fact where ${jsonExtract(sql`fact.value`, "$._tag")} = 'PullRequest' limit 1)`;

const Totals = Schema.Struct({
  itemKey: ItemKey,
  runCount: ItemRunHistory.fields.runCount,
  attemptCount: ItemRunHistory.fields.attemptCount,
  durationMillis: ItemRunHistory.fields.durationMillis,
  unmeasured: ItemRunHistory.fields.unmeasured,
  runningSince: Schema.fromJsonString(Schema.Array(Schema.String)),
});
const LoopHistory = Schema.Struct({
  itemKey: ItemKey,
  loop: LoopName,
  state: RunState,
  firstOpenedAt: Schema.String,
  firstRunId: RunId,
  latestOpenedAt: Schema.String,
  latestRunId: RunId,
});
const Usage = Schema.Struct({
  itemKey: ItemKey,
  runId: RunId,
  attempts: Schema.fromJsonString(RunUsageSource.fields.attempts),
});
const Link = Schema.Struct({ itemKey: ItemKey, url: Schema.String });

export const boardHistoryQueries = (database: RunDatabaseClient) => {
  const itemHistory = Effect.fn("RunStoreQueries.boardItemHistory")(function* (
    itemKeys: ReadonlyArray<ItemKey>,
  ) {
    yield* Effect.annotateCurrentSpan({ itemKeys });
    const batches = yield* Effect.forEach(
      EffectArray.chunksOf([...new Set(itemKeys)], 100),
      (keys) =>
        Effect.gen(function* () {
          const selected = sql`${triggerEvents.itemKey} in (${jsonArrayValues(keys)})`;
          const totals = yield* database
            .select({
              itemKey: triggerEvents.itemKey,
              runCount: sql<number>`count(distinct ${runs.runId})`,
              attemptCount: sql<number>`count(${attempts.attemptId})`,
              durationMillis: sql<number>`coalesce(sum(case when ${attempts.endedAt} is not null then ${elapsedMillis(attempts.startedAt, attempts.endedAt)} else 0 end), 0)`,
              unmeasured: sql<number>`count(case when ${attempts.outcomeJson} is not null and ${attempts.endedAt} is null then 1 end)`,
              runningSince: jsonGroupArray(
                attempts.startedAt,
                sql`${attempts.attemptId} is not null and ${attempts.outcomeJson} is null`,
              ),
            })
            .from(runs)
            .innerJoin(triggerEvents, eq(triggerEvents.eventId, runs.eventId))
            .leftJoin(attempts, eq(attempts.runId, runs.runId))
            .where(selected)
            .groupBy(triggerEvents.itemKey)
            .execute()
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Totals))));
          const ranked = database
            .select({
              itemKey: triggerEvents.itemKey,
              loop: runs.loopName,
              state: runs.stateJson,
              firstOpenedAt:
                sql<string>`first_value(${runs.openedAt}) over (partition by ${triggerEvents.itemKey}, ${runs.loopName} order by ${runs.openedAt}, ${runs.runId})`.as(
                  "first_opened_at",
                ),
              firstRunId:
                sql<string>`first_value(${runs.runId}) over (partition by ${triggerEvents.itemKey}, ${runs.loopName} order by ${runs.openedAt}, ${runs.runId})`.as(
                  "first_run_id",
                ),
              latestOpenedAt: runs.openedAt,
              latestRunId: runs.runId,
              rank: sql<number>`row_number() over (partition by ${triggerEvents.itemKey}, ${runs.loopName} order by ${runs.openedAt} desc, ${runs.runId} desc)`.as(
                "rank",
              ),
            })
            .from(runs)
            .innerJoin(triggerEvents, eq(triggerEvents.eventId, runs.eventId))
            .where(selected)
            .as("board_loop_history");
          const loops = yield* database
            .select()
            .from(ranked)
            .where(eq(ranked.rank, 1))
            .execute()
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(LoopHistory))));
          const usage = yield* database
            .select({
              itemKey: triggerEvents.itemKey,
              runId: runs.runId,
              attempts: jsonGroupArray(
                jsonObject([
                  ["id", attempts.attemptId],
                  [
                    "ended",
                    jsonValue(
                      sql`case when ${attempts.outcomeJson} is null then 'false' else 'true' end`,
                    ),
                  ],
                ]),
                sql`${attempts.attemptId} is not null`,
              ),
            })
            .from(runs)
            .innerJoin(triggerEvents, eq(triggerEvents.eventId, runs.eventId))
            .leftJoin(attempts, eq(attempts.runId, runs.runId))
            .where(selected)
            .groupBy(runs.runId, triggerEvents.itemKey)
            .orderBy(asc(runs.openedAt), asc(runs.runId))
            .execute()
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Usage))));
          const links = yield* database
            .selectDistinct({
              itemKey: triggerEvents.itemKey,
              url: runPullRequestUrl,
            })
            .from(runs)
            .innerJoin(triggerEvents, eq(triggerEvents.eventId, runs.eventId))
            .innerJoin(steps, eq(steps.runId, runs.runId))
            .where(and(selected, isNotNull(runPullRequestUrl)))
            .execute()
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Link))));
          const loopsByItem = EffectArray.groupBy(loops, ({ itemKey }) => itemKey);
          const usageByItem = EffectArray.groupBy(usage, ({ itemKey }) => itemKey);
          const linksByItem = EffectArray.groupBy(links, ({ itemKey }) => itemKey);
          return totals.map(
            (total) =>
              new ItemRunHistory({
                ...total,
                loops: loopsByItem[total.itemKey] ?? [],
                pullRequestUrls: (linksByItem[total.itemKey] ?? []).map(({ url }) => url),
                usageSources: (usageByItem[total.itemKey] ?? []).map(
                  ({ runId, attempts }) => new RunUsageSource({ run: { id: runId }, attempts }),
                ),
              }),
          );
        }),
    );
    const items = batches.flat();
    yield* Effect.logDebug("Read aggregate board history", {
      items: items.length,
      runs: items.reduce((sum, item) => sum + item.runCount, 0),
    });
    return items;
  });
  return { itemHistory };
};
