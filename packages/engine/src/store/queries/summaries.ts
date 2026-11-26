import { type RepositoryName, canonicalRepositoryName } from "@usine/core/repository";
import type { ItemKey } from "@usine/core/item";
import type { RunId } from "@usine/core/run";
import * as RunState from "@usine/core/run/state";
import { and, asc, desc, eq, gte, inArray, isNull, isNotNull, ne, or, sql } from "drizzle-orm";
import { Array as EffectArray, DateTime, Effect, Option, Struct } from "effect";
import { jsonArrayValues, jsonExtract, jsonObject, isTrue } from "../../database/dialect.ts";
import type { RunDatabaseClient } from "../../database/database.ts";
import {
  approvals,
  attempts,
  events,
  projectionRevision,
  runAgainEvents,
  runs,
  steps,
  triggerEvents,
} from "../../database/schema.ts";
import { RunNotFoundError } from "../../engine/error.ts";
import { BoardRunHistory, type RunSummary } from "../../run-reader/model.ts";
import {
  type RunSummaryRow,
  decodeAttemptSummaryRows,
  decodeProjectionRevision,
  decodeRunEventRows,
  decodeRunSummaryRows,
  encodeDateTime,
  runEventFromRow,
  runSummaryFromRow,
} from "../codec.ts";
import { attemptSelection } from "./attempts.ts";
import { boardHistoryQueries, runPullRequestUrl } from "./board.ts";
import { approvalEvents, openState, runSelection } from "./runs.ts";

const newestRunFirst = (left: RunSummaryRow, right: RunSummaryRow) =>
  DateTime.toEpochMillis(right.openedAt) - DateTime.toEpochMillis(left.openedAt) ||
  right.runId.localeCompare(left.runId);

const runSummarySelection = {
  ...Struct.omit(runSelection, ["task", "result", "revision", "stepName", "agent"]),
  agent: jsonObject([
    ["name", jsonExtract(runs.agentJson, "$.name")],
    ["brain", jsonExtract(runs.agentJson, "$.brain")],
  ]).mapWith(runs.agentJson),
  pullRequestUrl: runPullRequestUrl,
} as const;

const attemptSummarySelection = Struct.omit(attemptSelection, ["task", "comments", "result"]);

/** Returns the Run summary reads. */
export const summaryQueries = (database: RunDatabaseClient) => {
  const selectRunSummaries = () =>
    database
      .select(runSummarySelection)
      .from(runs)
      .innerJoin(triggerEvents, eq(triggerEvents.eventId, runs.eventId))
      .innerJoin(steps, eq(steps.runId, runs.runId))
      .leftJoin(approvals, eq(approvals.runId, runs.runId))
      .leftJoin(approvalEvents, eq(approvalEvents.eventId, approvals.eventId))
      .leftJoin(runAgainEvents, eq(runAgainEvents.eventId, runs.eventId));

  const summariesWithAttempts = Effect.fn("RunStoreQueries.summariesWithAttempts")(function* (
    storedRuns: ReadonlyArray<RunSummaryRow>,
  ) {
    const runIds = storedRuns.map(({ runId }) => runId);
    // Chunks keep each read below the driver's bind-parameter limit.

    const storedAttempts = (yield* Effect.forEach(EffectArray.chunksOf(runIds, 100), (ids) =>
      database
        .select(attemptSummarySelection)
        .from(attempts)
        .where(inArray(attempts.runId, ids))
        .orderBy(asc(attempts.runId), asc(attempts.attemptNumber))
        .execute()
        .pipe(Effect.flatMap(decodeAttemptSummaryRows)),
    )).flat();
    const attemptsByRun = EffectArray.groupBy(storedAttempts, ({ runId }) => runId);
    return storedRuns.map((row): RunSummary =>
      runSummaryFromRow(row, attemptsByRun[row.runId] ?? []),
    );
  });

  const runSummary = Effect.fn("RunStoreQueries.runSummary")(function* (runId: RunId) {
    yield* Effect.annotateCurrentSpan({ runId });
    const rows = yield* selectRunSummaries()
      .where(eq(runs.runId, runId))
      .limit(1)
      .execute()
      .pipe(Effect.flatMap(decodeRunSummaryRows));
    const [summary] = yield* summariesWithAttempts(rows);
    if (summary === undefined) return yield* RunNotFoundError.make({ runId });
    return summary;
  });

  const itemRunSummaries = Effect.fn("RunStoreQueries.itemRunSummaries")(function* (
    itemKeys: ReadonlyArray<ItemKey>,
  ) {
    if (itemKeys.length === 0) return [];

    const storedRuns = (yield* Effect.forEach(
      EffectArray.chunksOf([...new Set(itemKeys)], 100),
      (keys) =>
        selectRunSummaries()
          .where(inArray(triggerEvents.itemKey, keys))
          .execute()
          .pipe(Effect.flatMap(decodeRunSummaryRows)),
    ))
      .flat()
      .sort(newestRunFirst);
    return yield* summariesWithAttempts(storedRuns);
  });

  const boardRunSummaries = Effect.fn("RunStoreQueries.boardRunSummaries")(function* (
    itemKeys: ReadonlyArray<ItemKey>,
    attentionRunIds: ReadonlyArray<RunId>,
  ) {
    yield* Effect.annotateCurrentSpan({ itemKeys, attentionRunIds });
    const items = yield* boardHistoryQueries(database).itemHistory(itemKeys);

    const storedRuns = (yield* Effect.forEach(
      EffectArray.chunksOf([...new Set(itemKeys)], 100),
      (keys) => {
        const ranked = database
          .select({
            runId: runs.runId,
            state: runs.stateJson,
            resolved: runs.resolvedFailureAttemptId,
            latestAttempt: sql<
              string | null
            >`(select ${attempts.attemptId} from ${attempts} where ${attempts.runId} = ${runs.runId} order by ${attempts.attemptNumber} desc limit 1)`.as(
              "latest_attempt",
            ),
            rank: sql<number>`row_number() over (partition by ${triggerEvents.itemKey} order by ${runs.openedAt} desc, ${runs.runId} desc)`.as(
              "rank",
            ),
          })
          .from(runs)
          .innerJoin(triggerEvents, eq(triggerEvents.eventId, runs.eventId))
          .where(sql`${triggerEvents.itemKey} in (${jsonArrayValues(keys)})`)
          .as("board_current_runs");
        const state = jsonExtract(ranked.state, "$._tag");
        const current = () =>
          database
            .select({ runId: ranked.runId })
            .from(ranked)
            .where(
              or(
                eq(ranked.rank, 1),
                inArray(state, [...RunState.OPEN_STATE_TAGS]),
                and(
                  eq(state, "Failed"),
                  or(isNull(ranked.resolved), ne(ranked.resolved, ranked.latestAttempt)),
                ),
                sql`${ranked.runId} in (${jsonArrayValues(attentionRunIds)})`,
              ),
            );
        const selectedRuns = current().unionAll(
          database
            .select({ runId: runs.runId })
            .from(runs)
            .where(
              inArray(sql`cast(${jsonExtract(runs.stateJson, "$.fixRunId")} as text)`, current()),
            ),
        );
        return selectRunSummaries()
          .where(inArray(runs.runId, selectedRuns))
          .orderBy(desc(runs.openedAt), desc(runs.runId))
          .execute()
          .pipe(Effect.flatMap(decodeRunSummaryRows));
      },
    ))
      .flat()
      .sort(newestRunFirst);
    const uniqueRuns = [...new Map(storedRuns.map((run) => [run.runId, run])).values()];
    const summaries = yield* summariesWithAttempts(uniqueRuns);
    yield* Effect.logDebug("Read current board runs", {
      items: items.length,
      runs: summaries.length,
    });
    return BoardRunHistory.make({ items, runs: summaries });
  });

  // Every open Run plus the newest `closedLimit` closed ones, so an old waiting Run stays listed.
  const runSummaries = Effect.fn("RunStoreQueries.runSummaries")(function* (closedLimit: number) {
    const [openRuns, closedRuns] = yield* Effect.all([
      selectRunSummaries()
        .where(openState)
        .orderBy(desc(runs.openedAt), desc(runs.runId))
        .execute()
        .pipe(Effect.flatMap(decodeRunSummaryRows)),
      selectRunSummaries()
        .where(isTrue(sql`${runs.closedAt} is not null`))
        .orderBy(desc(runs.openedAt), desc(runs.runId))
        .limit(closedLimit)
        .execute()
        .pipe(Effect.flatMap(decodeRunSummaryRows)),
    ]);
    const storedRuns = [...openRuns, ...closedRuns].sort(newestRunFirst);
    return yield* summariesWithAttempts(storedRuns);
  });

  const runEvents = Effect.fn("RunStoreQueries.runEvents")(function* (
    runIds: ReadonlyArray<RunId>,
  ) {
    // Chunks keep each read below the driver's bind-parameter limit.
    const rows = yield* Effect.forEach(EffectArray.chunksOf([...new Set(runIds)], 100), (ids) =>
      database
        .select({
          runId: runs.runId,
          eventId: events.eventId,
          dedupKey: events.dedupKey,
          payload: events.payloadJson,
          receivedAt: events.receivedAt,
        })
        .from(runs)
        .innerJoin(events, eq(events.eventId, runs.eventId))
        .where(inArray(runs.runId, ids))
        .execute()
        .pipe(Effect.flatMap(decodeRunEventRows)),
    );
    return rows.flat().map(runEventFromRow);
  });

  const closedRunSummaries = Effect.fn("RunStoreQueries.closedRunSummaries")(function* (
    limit: number,
    repositories?: ReadonlyArray<RepositoryName>,
  ) {
    const closedRuns = yield* selectRunSummaries()
      .where(
        and(
          isNotNull(runs.closedAt),
          repositories === undefined
            ? undefined
            : sql`lower(${runs.repository}) in (${jsonArrayValues(repositories.map(canonicalRepositoryName))})`,
        ),
      )
      .orderBy(desc(runs.closedAt), desc(runs.runId))
      .limit(limit)
      .execute()
      .pipe(Effect.flatMap(decodeRunSummaryRows));
    return yield* summariesWithAttempts(closedRuns);
  });

  // Every closed Run with `closedAt` at or after `since`, or every closed Run for `None`.
  const closedRunSummariesSince = Effect.fn("RunStoreQueries.closedRunSummariesSince")(function* (
    since: Option.Option<DateTime.Utc>,
  ) {
    const closed = isNotNull(runs.closedAt);
    const closedRuns = yield* selectRunSummaries()
      .where(
        Option.match(since, {
          onNone: () => closed,
          onSome: (from) => and(closed, gte(runs.closedAt, encodeDateTime(from))),
        }),
      )
      .orderBy(desc(runs.closedAt), desc(runs.runId))
      .execute()
      .pipe(Effect.flatMap(decodeRunSummaryRows));
    return yield* summariesWithAttempts(closedRuns);
  });

  const revision = Effect.fn("RunStoreQueries.projectionRevision")(function* () {
    const storedRows = yield* database
      .select({ revision: projectionRevision.revision })
      .from(projectionRevision)
      .where(eq(projectionRevision.singleton, 1))
      .limit(1)
      .execute();
    const rows = yield* decodeProjectionRevision(storedRows);
    return Option.fromNullishOr(rows[0]?.revision);
  });

  return {
    runSummary,
    runSummaries,
    closedRunSummaries,
    closedRunSummariesSince,
    itemRunSummaries,
    boardRunSummaries,
    runEvents,
    revision,
  } as const;
};
