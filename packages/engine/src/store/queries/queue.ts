import type { RecordChange } from "../changes.ts";
import { EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import type { RunId } from "@usine/core/run";
import { and, desc, eq, inArray, isNull, ne, or, sql, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { Effect, Option, Schema } from "effect";
import type { RunDatabaseClient } from "../../database/database.ts";
import {
  events,
  ignoredEvents,
  itemCycleBudgets,
  loopItems,
  runs,
  triggerEvents,
} from "../../database/schema.ts";
import type { RevokeScope, Submission } from "../../engine/submission.ts";
import { cycleQueries } from "../../cycle-budget/queries.ts";
import { decodeEventRoutes, decodeRunIds, submissionFromRow } from "../codec.ts";
import { eventQueries, eventRouteSelection } from "./events.ts";
import { loopItemQueries } from "./loop-items.ts";
import { runQueries, unstartedState } from "./runs.ts";

/** The newest queued submission and the Events read with it. */
export interface QueuedEvents {
  readonly submission: Submission;
  readonly eventIds: ReadonlyArray<EventId>;
  readonly triggerMatchEventIds: ReadonlyArray<EventId>;
}

/** An admissible queue, with the newest closed Run of its Loop's Item, if any. */
export interface PendingQueue {
  readonly queued: QueuedEvents;
  readonly closedRunId: Option.Option<RunId>;
}

/** Returns the Queued Event queries that run on the caller's transaction. */
export const queueQueries = (database: RunDatabaseClient, record?: RecordChange) => {
  const { eventRouteByRun } = eventQueries(database);
  const { blockingRun } = runQueries(database, record);

  /**
   * Returns the current unclaimed Events of a Loop's Item, newest first, with the newest as the
   * submission to recheck. Every admission path starts with the newest Event, CI fix or trigger match.
   */
  const queuedOn = Effect.fn("RunStoreQueries.queuedOn")(function* (
    loop: LoopName,
    itemKey: ItemKey,
  ) {
    const queuedRows = yield* database
      .select(eventRouteSelection)
      .from(events)
      .innerJoin(triggerEvents, eq(triggerEvents.eventId, events.eventId))
      .leftJoin(runs, eq(runs.eventId, events.eventId))
      .leftJoin(ignoredEvents, eq(ignoredEvents.eventId, events.eventId))
      .where(
        and(
          eq(triggerEvents.loopName, loop),
          eq(triggerEvents.itemKey, itemKey),
          cycleQueries(database, record).currentEvent,
          isNull(runs.runId),
          isNull(ignoredEvents.eventId),
        ),
      )
      .orderBy(desc(events.receivedAt), desc(events.eventId))
      .execute();
    const queued = yield* decodeEventRoutes(queuedRows);
    return Option.fromNullishOr(queued[0]).pipe(
      Option.map((newest): QueuedEvents => ({
        submission: submissionFromRow(newest),
        eventIds: queued.map((row) => row.eventId),
        triggerMatchEventIds: queued
          .filter((row) => row.ciFailureHead === null)
          .map((row) => row.eventId),
      })),
    );
  });

  /**
   * Returns the Loops' Items with a current queued Event and no open Run, excluding Items waiting
   * for a cycle-budget reset or under a suppression.
   */
  const admissibleItems = Effect.fn("RunStoreQueries.admissibleItems")(function* () {
    const items = yield* database
      .selectDistinct({ loop: triggerEvents.loopName, itemKey: triggerEvents.itemKey })
      .from(triggerEvents)
      .leftJoin(runs, eq(runs.eventId, triggerEvents.eventId))
      .leftJoin(ignoredEvents, eq(ignoredEvents.eventId, triggerEvents.eventId))
      .leftJoin(itemCycleBudgets, eq(itemCycleBudgets.itemKey, triggerEvents.itemKey))
      .leftJoin(
        loopItems,
        and(
          eq(loopItems.loopName, triggerEvents.loopName),
          eq(loopItems.itemKey, triggerEvents.itemKey),
        ),
      )
      .where(
        and(
          isNull(runs.runId),
          isNull(ignoredEvents.eventId),
          isNull(itemCycleBudgets.askJson),
          isNull(loopItems.suppressedByRunId),
          cycleQueries(database, record).currentEvent,
        ),
      )
      .execute();
    const decoded = yield* Schema.decodeEffect(
      Schema.Array(Schema.Struct({ loop: LoopName, itemKey: ItemKey })),
    )(items);
    const unblocked = yield* Effect.forEach(decoded, (item) =>
      blockingRun(item.loop, item.itemKey).pipe(
        Effect.map((blocking) => (blocking.length === 0 ? [item] : [])),
      ),
    );
    return unblocked.flat();
  });

  /** Returns the queued Events of a Loop's Item, or `None` during a suppression. */
  const unsuppressedQueue = Effect.fn("RunStoreQueries.unsuppressedQueue")(function* (
    loop: LoopName,
    itemKey: ItemKey,
  ) {
    const suppression = yield* loopItemQueries(database).suppression(loop, itemKey);
    if (Option.isSome(suppression)) {
      yield* Effect.logInfo("Queued Events wait while a suppression keeps the Item", {
        suppressedBy: suppression.value.runId,
        loop,
        itemKey,
      });
      return Option.none<QueuedEvents>();
    }
    return yield* queuedOn(loop, itemKey);
  });

  const nextQueued = Effect.fn("RunStoreQueries.nextQueued")(function* (runId: RunId) {
    const routes = yield* eventRouteByRun(runId);
    const current = routes[0];
    if (current === undefined) return Option.none<QueuedEvents>();
    return yield* unsuppressedQueue(current.loop, current.itemKey);
  });

  /**
   * Returns the queued Events of a Loop's Item, or `None` while the Item has an open Run or a
   * suppression, either of which refuses the claim.
   */
  const admissibleQueue = Effect.fn("RunStoreQueries.admissibleQueue")(function* (
    loop: LoopName,
    itemKey: ItemKey,
  ) {
    const blocking = yield* blockingRun(loop, itemKey);
    if (blocking[0] !== undefined) {
      yield* Effect.logInfo("Queued Events wait behind the Item's open Run", {
        openRunId: blocking[0].runId,
        loop,
        itemKey,
      });
      return Option.none<QueuedEvents>();
    }
    return yield* unsuppressedQueue(loop, itemKey);
  });

  /** Returns the queue of every admissible Item, with the newest closed Run of its Loop's Item. */
  const pendingQueues = Effect.fn("RunStoreQueries.pendingQueues")(function* () {
    const items = yield* admissibleItems();
    const queues = yield* Effect.forEach(items, ({ loop, itemKey }) =>
      Effect.gen(function* () {
        const queued = yield* queuedOn(loop, itemKey);
        if (Option.isNone(queued)) return [];
        const rows = yield* database
          .select({ runId: runs.runId })
          .from(runs)
          .innerJoin(triggerEvents, eq(triggerEvents.eventId, runs.eventId))
          .where(and(eq(triggerEvents.loopName, loop), eq(triggerEvents.itemKey, itemKey)))
          .orderBy(desc(runs.openedAt), desc(runs.runId))
          .limit(1)
          .execute();
        const closed = yield* decodeRunIds(rows);
        return [
          {
            queued: queued.value,
            closedRunId: Option.fromNullishOr(closed[0]?.runId),
          } satisfies PendingQueue,
        ];
      }),
    );
    return queues.flat();
  });

  const revokeQueued = Effect.fn("RunStoreQueries.revokeQueued")(function* (
    loop: LoopName,
    itemKey: ItemKey,
    eventIds: ReadonlyArray<EventId> | SQLWrapper,
  ) {
    const candidate = alias(triggerEvents, "candidate");
    const candidateRun = alias(runs, "candidate_run");
    const ignored = yield* database
      .insert(ignoredEvents)
      .select(
        database
          .select({
            eventId: candidate.eventId,
            reason: sql<"revoked">`'revoked'`.as("reason"),
          })
          .from(candidate)
          .leftJoin(candidateRun, eq(candidateRun.eventId, candidate.eventId))
          .where(
            and(
              eq(candidate.loopName, loop),
              eq(candidate.itemKey, itemKey),
              inArray(candidate.eventId, eventIds),
              isNull(candidateRun.runId),
            ),
          ),
      )
      .onConflictDoNothing()
      .returning({ eventId: ignoredEvents.eventId })
      .execute();
    return ignored.length;
  });

  const revokeUnstarted = Effect.fn("RunStoreQueries.revokeUnstarted")(function* (
    loop: LoopName,
    itemKey: ItemKey,
    scope: RevokeScope,
  ) {
    const revokedHead =
      scope === "all"
        ? undefined
        : or(
            isNull(triggerEvents.ciFailureHead),
            ne(triggerEvents.ciFailureHead, scope.openCiHead),
          );
    const storedRows = yield* database
      .select({ runId: runs.runId })
      .from(runs)
      .innerJoin(triggerEvents, eq(triggerEvents.eventId, runs.eventId))
      .where(
        and(
          eq(triggerEvents.loopName, loop),
          eq(triggerEvents.itemKey, itemKey),
          revokedHead,
          unstartedState,
        ),
      )
      .execute();
    const rows = yield* decodeRunIds(storedRows);
    const queued = database
      .select({ eventId: triggerEvents.eventId })
      .from(triggerEvents)
      .where(
        and(eq(triggerEvents.loopName, loop), eq(triggerEvents.itemKey, itemKey), revokedHead),
      );
    yield* revokeQueued(loop, itemKey, queued);
    return rows;
  });

  return {
    nextQueued,
    admissibleQueue,
    pendingQueues,
    revokeQueued,
    revokeUnstarted,
  } as const;
};
