import { EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RunId } from "@usine/core/run";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { Array as EffectArray, Effect, Option, Schema } from "effect";
import type { RunDatabaseClient } from "../database/database.ts";
import { loopItems, runs, triggerEvents } from "../database/schema.ts";
import type { PreviousSighting, Suppression } from "../engine/lifecycle.ts";
import { LoopSighting } from "../run-reader/model.ts";

const LoopItemRow = Schema.Struct({
  observedEventId: Schema.NullOr(EventId),
  suppressedByRunId: Schema.NullOr(RunId),
  suppressedEventId: Schema.NullOr(EventId),
});
const decodeLoopItems = Schema.decodeUnknownEffect(Schema.Array(LoopItemRow));
const decodeSightingRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      loop: LoopName,
      itemKey: ItemKey,
      observedEventId: Schema.NullOr(EventId),
      suppressedByRunId: Schema.NullOr(RunId),
    }),
  ),
);
const decodeReopeningRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ eventId: EventId, reopensEventId: EventId })),
);
const decodeOwnerRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ eventId: EventId, runId: RunId })),
);

/** Returns the Loop sighting and suppression queries that run on the caller's transaction. */
export const loopItemQueries = (database: RunDatabaseClient) => {
  const where = (loop: LoopName, itemKey: ItemKey) =>
    and(eq(loopItems.loopName, loop), eq(loopItems.itemKey, itemKey));

  const row = Effect.fn("LoopItems.row")(function* (loop: LoopName, itemKey: ItemKey) {
    const rows = yield* decodeLoopItems(
      yield* database
        .select({
          observedEventId: loopItems.observedEventId,
          suppressedByRunId: loopItems.suppressedByRunId,
          suppressedEventId: loopItems.suppressedEventId,
        })
        .from(loopItems)
        .where(where(loop, itemKey))
        .execute(),
    );
    return Option.fromNullishOr(rows[0]);
  });

  /** Records a sighting of `eventId` and returns the Loop's previous sighting. */
  const sighted = Effect.fn("LoopItems.sighted")(function* (
    loop: LoopName,
    itemKey: ItemKey,
    eventId: EventId,
  ) {
    const before: PreviousSighting = Option.map(yield* row(loop, itemKey), ({ observedEventId }) =>
      Option.fromNullishOr(observedEventId),
    );
    yield* database
      .insert(loopItems)
      .values({ loopName: loop, itemKey, observedEventId: eventId })
      .onConflictDoUpdate({
        target: [loopItems.loopName, loopItems.itemKey],
        set: { observedEventId: eventId },
      })
      .execute();
    return before;
  });

  /** Records a non-matching sighting and lifts any suppression; does nothing if the Loop has no row. */
  const unmatched = Effect.fn("LoopItems.unmatched")(function* (loop: LoopName, itemKey: ItemKey) {
    yield* database
      .update(loopItems)
      .set({ observedEventId: null, suppressedByRunId: null, suppressedEventId: null })
      .where(where(loop, itemKey))
      .execute();
  });

  /** Returns the Loop's suppression of the Item, or `None`. */
  const suppression = Effect.fn("LoopItems.suppression")(function* (
    loop: LoopName,
    itemKey: ItemKey,
  ) {
    return Option.flatMap(yield* row(loop, itemKey), ({ suppressedByRunId, suppressedEventId }) =>
      suppressedByRunId === null
        ? Option.none<Suppression>()
        : Option.some<Suppression>({
            runId: suppressedByRunId,
            suppressedEventId: Option.fromNullishOr(suppressedEventId),
          }),
    );
  });

  /**
   * Starts the suppression of `runId` unless the Loop's last sighting was a non-match, and
   * returns whether it started. `opened` is recorded as the sighting if the Loop has no row;
   * `queued` is the newest queued Event, already the state after the stop.
   */
  const startSuppression = Effect.fn("LoopItems.startSuppression")(function* (
    loop: LoopName,
    itemKey: ItemKey,
    runId: RunId,
    opened: EventId,
    queued: Option.Option<EventId>,
  ) {
    const current = yield* row(loop, itemKey);
    if (Option.exists(current, ({ observedEventId }) => observedEventId === null)) return false;
    const suppressedEventId = Option.getOrNull(queued);
    yield* database
      .insert(loopItems)
      .values({
        loopName: loop,
        itemKey,
        observedEventId: opened,
        suppressedByRunId: runId,
        suppressedEventId,
      })
      .onConflictDoUpdate({
        target: [loopItems.loopName, loopItems.itemKey],
        set: { suppressedByRunId: runId, suppressedEventId },
      })
      .execute();
    return true;
  });

  /** Records `eventId` as the Item's state after the stop. */
  const suppressFrom = Effect.fn("LoopItems.suppressFrom")(function* (
    loop: LoopName,
    itemKey: ItemKey,
    eventId: EventId,
  ) {
    yield* database
      .update(loopItems)
      .set({ suppressedEventId: eventId })
      .where(and(where(loop, itemKey), isNotNull(loopItems.suppressedByRunId)))
      .execute();
  });

  const lift = Effect.fn("LoopItems.lift")(function* (loop: LoopName, itemKey: ItemKey) {
    yield* database
      .update(loopItems)
      .set({ suppressedByRunId: null, suppressedEventId: null })
      .where(where(loop, itemKey))
      .execute();
  });

  /** Lifts the suppression of `runId` on any Loop and returns whether there was one. */
  const liftRun = Effect.fn("LoopItems.liftRun")(function* (runId: RunId) {
    const lifted = yield* database
      .update(loopItems)
      .set({ suppressedByRunId: null, suppressedEventId: null })
      .where(eq(loopItems.suppressedByRunId, runId))
      .returning({ loopName: loopItems.loopName })
      .execute();
    return lifted.length > 0;
  });

  /**
   * Returns each Loop's last sighting of the Items in `itemKeys`, with the newest reopening or
   * run-again Event for the submitted Event.
   */
  const sightings = Effect.fn("LoopItems.sightings")(function* (itemKeys: ReadonlyArray<ItemKey>) {
    const keys = [...new Set(itemKeys)];
    if (keys.length === 0) return [];
    // Chunks keep each read below the driver's bind-parameter limit.
    const rows = (yield* Effect.forEach(EffectArray.chunksOf(keys, 100), (chunk) =>
      database
        .select({
          loop: loopItems.loopName,
          itemKey: loopItems.itemKey,
          observedEventId: loopItems.observedEventId,
          suppressedByRunId: loopItems.suppressedByRunId,
        })
        .from(loopItems)
        .where(inArray(loopItems.itemKey, chunk))
        .execute()
        .pipe(Effect.flatMap(decodeSightingRows)),
    )).flat();
    const observed = [
      ...new Set(
        rows.flatMap(({ observedEventId }) => (observedEventId === null ? [] : [observedEventId])),
      ),
    ];
    const reopenings = (yield* Effect.forEach(EffectArray.chunksOf(observed, 100), (chunk) =>
      database
        .select({ eventId: triggerEvents.eventId, reopensEventId: triggerEvents.reopensEventId })
        .from(triggerEvents)
        .where(inArray(triggerEvents.reopensEventId, chunk))
        .orderBy(desc(triggerEvents.reopening))
        .execute()
        .pipe(Effect.flatMap(decodeReopeningRows)),
    )).flat();
    const newest = new Map<EventId, EventId>();
    for (const { eventId, reopensEventId } of reopenings) {
      if (!newest.has(reopensEventId)) newest.set(reopensEventId, eventId);
    }
    const current = (eventId: EventId) => newest.get(eventId) ?? eventId;
    const owners = new Map(
      (yield* Effect.forEach(EffectArray.chunksOf(observed.map(current), 100), (chunk) =>
        database
          .select({ eventId: runs.eventId, runId: runs.runId })
          .from(runs)
          .where(inArray(runs.eventId, chunk))
          .execute()
          .pipe(Effect.flatMap(decodeOwnerRows)),
      ))
        .flat()
        .map(({ eventId, runId }) => [eventId, runId] as const),
    );
    return rows.map(({ loop, itemKey, observedEventId, suppressedByRunId }) => {
      const event = Option.map(Option.fromNullishOr(observedEventId), current);
      return new LoopSighting({
        loop,
        itemKey,
        event,
        run: Option.flatMap(event, (eventId) => Option.fromNullishOr(owners.get(eventId))),
        suppressedBy: Option.fromNullishOr(suppressedByRunId),
      });
    });
  });

  return {
    sighted,
    unmatched,
    suppression,
    startSuppression,
    suppressFrom,
    lift,
    liftRun,
    sightings,
  } as const;
};
