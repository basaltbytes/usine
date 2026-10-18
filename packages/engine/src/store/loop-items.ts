import { EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RunId } from "@usine/core/run";
import { and, eq, isNotNull } from "drizzle-orm";
import { Effect, Option, Schema } from "effect";
import type { RunDatabaseClient } from "../database/database.ts";
import { loopItems } from "../database/schema.ts";
import type { PreviousSighting, QuestionHold } from "../engine/lifecycle.ts";

const LoopItemRow = Schema.Struct({
  observedEventId: Schema.NullOr(EventId),
  heldByRunId: Schema.NullOr(RunId),
  heldEventId: Schema.NullOr(EventId),
});
const decodeLoopItems = Schema.decodeUnknownEffect(Schema.Array(LoopItemRow));

/** Transaction-local reads and writes of what each Loop last saw of an Item, and of question holds. */
export const loopItemQueries = (database: RunDatabaseClient) => {
  const where = (loop: LoopName, itemKey: ItemKey) =>
    and(eq(loopItems.loopName, loop), eq(loopItems.itemKey, itemKey));

  const row = Effect.fn("LoopItems.row")(function* (loop: LoopName, itemKey: ItemKey) {
    const rows = yield* decodeLoopItems(
      yield* database
        .select({
          observedEventId: loopItems.observedEventId,
          heldByRunId: loopItems.heldByRunId,
          heldEventId: loopItems.heldEventId,
        })
        .from(loopItems)
        .where(where(loop, itemKey))
        .execute(),
    );
    return Option.fromNullishOr(rows[0]);
  });

  /** Records a trigger's sighting of `eventId` and returns what the Loop saw before it. */
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

  /**
   * Records a sighting that did not match, which also ends a question's hold. A
   * Loop that never saw the Item matching has nothing to record.
   */
  const unmatched = Effect.fn("LoopItems.unmatched")(function* (loop: LoopName, itemKey: ItemKey) {
    yield* database
      .update(loopItems)
      .set({ observedEventId: null, heldByRunId: null, heldEventId: null })
      .where(where(loop, itemKey))
      .execute();
  });

  /** The question that holds the Loop on the Item, if one does. */
  const hold = Effect.fn("LoopItems.hold")(function* (loop: LoopName, itemKey: ItemKey) {
    return Option.flatMap(yield* row(loop, itemKey), ({ heldByRunId, heldEventId }) =>
      heldByRunId === null
        ? Option.none<QuestionHold>()
        : Option.some<QuestionHold>({
            runId: heldByRunId,
            heldEventId: Option.fromNullishOr(heldEventId),
          }),
    );
  });

  /**
   * Starts the hold of `runId`'s question unless the Loop last saw the Item not
   * matching. `opened` is the asking Run's Event, recorded as the Loop's sighting
   * for an Item it has no record of; `queued` is the newest Event waiting behind
   * the Run, already the Item's state after the question. True when the hold started.
   */
  const startHold = Effect.fn("LoopItems.startHold")(function* (
    loop: LoopName,
    itemKey: ItemKey,
    runId: RunId,
    opened: EventId,
    queued: Option.Option<EventId>,
  ) {
    const current = yield* row(loop, itemKey);
    if (Option.exists(current, ({ observedEventId }) => observedEventId === null)) return false;
    const heldEventId = Option.getOrNull(queued);
    yield* database
      .insert(loopItems)
      .values({ loopName: loop, itemKey, observedEventId: opened, heldByRunId: runId, heldEventId })
      .onConflictDoUpdate({
        target: [loopItems.loopName, loopItems.itemKey],
        set: { heldByRunId: runId, heldEventId },
      })
      .execute();
    return true;
  });

  /** Records `eventId` as the Item's state after the question that holds the Loop. */
  const holdAt = Effect.fn("LoopItems.holdAt")(function* (
    loop: LoopName,
    itemKey: ItemKey,
    eventId: EventId,
  ) {
    yield* database
      .update(loopItems)
      .set({ heldEventId: eventId })
      .where(and(where(loop, itemKey), isNotNull(loopItems.heldByRunId)))
      .execute();
  });

  const release = Effect.fn("LoopItems.release")(function* (loop: LoopName, itemKey: ItemKey) {
    yield* database
      .update(loopItems)
      .set({ heldByRunId: null, heldEventId: null })
      .where(where(loop, itemKey))
      .execute();
  });

  /** Ends the hold of `runId`'s question, wherever it holds a Loop. True when there was one. */
  const releaseRun = Effect.fn("LoopItems.releaseRun")(function* (runId: RunId) {
    const released = yield* database
      .update(loopItems)
      .set({ heldByRunId: null, heldEventId: null })
      .where(eq(loopItems.heldByRunId, runId))
      .returning({ loopName: loopItems.loopName })
      .execute();
    return released.length > 0;
  });

  return { sighted, unmatched, hold, startHold, holdAt, release, releaseRun } as const;
};
