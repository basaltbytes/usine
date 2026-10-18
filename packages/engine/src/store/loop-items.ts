import { EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { and, eq } from "drizzle-orm";
import { Effect, Option, Schema } from "effect";
import type { RunDatabaseClient } from "../database/database.ts";
import { loopItems } from "../database/schema.ts";
import type { PreviousSighting } from "../engine/lifecycle.ts";

const ObservationRow = Schema.Struct({ observedEventId: Schema.NullOr(EventId) });
const decodeObservations = Schema.decodeUnknownEffect(Schema.Array(ObservationRow));

/** Transaction-local reads and writes of what each Loop last saw of an Item. */
export const loopItemQueries = (database: RunDatabaseClient) => {
  const where = (loop: LoopName, itemKey: ItemKey) =>
    and(eq(loopItems.loopName, loop), eq(loopItems.itemKey, itemKey));

  const previous = Effect.fn("LoopItems.previous")(function* (loop: LoopName, itemKey: ItemKey) {
    const rows = yield* decodeObservations(
      yield* database
        .select({ observedEventId: loopItems.observedEventId })
        .from(loopItems)
        .where(where(loop, itemKey))
        .execute(),
    );
    return Option.map(Option.fromNullishOr(rows[0]), ({ observedEventId }) =>
      Option.fromNullishOr(observedEventId),
    );
  });

  /** Records a trigger's sighting of `eventId` and returns what the Loop saw before it. */
  const sighted = Effect.fn("LoopItems.sighted")(function* (
    loop: LoopName,
    itemKey: ItemKey,
    eventId: EventId,
  ) {
    const before: PreviousSighting = yield* previous(loop, itemKey);
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

  // A Loop that never saw the Item matching has nothing to record.
  const unmatched = Effect.fn("LoopItems.unmatched")(function* (loop: LoopName, itemKey: ItemKey) {
    yield* database
      .update(loopItems)
      .set({ observedEventId: null })
      .where(where(loop, itemKey))
      .execute();
  });

  return { sighted, unmatched } as const;
};
