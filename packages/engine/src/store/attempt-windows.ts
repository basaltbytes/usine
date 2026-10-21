import { type AttemptId, windowOf, windowsOverlap } from "@usine/core/attempt";
import { and, eq, inArray, ne } from "drizzle-orm";
import { Effect, Option } from "effect";
import type { RunDatabaseClient } from "../database/database.ts";
import { attempts, runs, triggerEvents } from "../database/schema.ts";
import { attemptFromRow, decodeAttemptRows } from "./codec.ts";
import { attemptSelection } from "./queries.ts";

/** Reads when the Attempts on one Item were at work, on the caller's transaction. */
export const attemptWindowQueries = (database: RunDatabaseClient) => {
  /**
   * The windows of the other Attempts of `attemptId`'s Agent on its Run's
   * Item that overlap its own (`windowsOverlap`): those still open, and those
   * that ended in or after the second it started. An Attempt that ended before
   * end times were recorded has no known window and is left out. Only Attempts
   * the store holds are asked about, so a missing one is a defect.
   */
  const overlappingWindows = Effect.fn("RunStoreQueries.overlappingWindows")(function* (
    attemptId: AttemptId,
  ) {
    yield* Effect.annotateCurrentSpan({ attemptId });
    const [own] = yield* database
      .select(attemptSelection)
      .from(attempts)
      .where(eq(attempts.attemptId, attemptId))
      .execute()
      .pipe(Effect.flatMap(decodeAttemptRows));
    if (own === undefined) return yield* Effect.die(new Error(`No Attempt ${attemptId} recorded`));
    const ownWindow = windowOf(attemptFromRow(own));
    if (Option.isNone(ownWindow)) {
      yield* Effect.logDebug(
        "The Attempt ended before end times were recorded, so no window overlaps it",
        { attemptId },
      );
      return [];
    }
    const item = database
      .select({ itemKey: triggerEvents.itemKey })
      .from(runs)
      .innerJoin(triggerEvents, eq(triggerEvents.eventId, runs.eventId))
      .where(eq(runs.runId, own.runId));
    const others = yield* database
      .select(attemptSelection)
      .from(attempts)
      .innerJoin(runs, eq(runs.runId, attempts.runId))
      .innerJoin(triggerEvents, eq(triggerEvents.eventId, runs.eventId))
      .where(
        and(
          inArray(triggerEvents.itemKey, item),
          eq(attempts.agent, own.agent),
          ne(attempts.attemptId, attemptId),
        ),
      )
      .orderBy(attempts.startedAt)
      .execute()
      .pipe(Effect.flatMap(decodeAttemptRows));
    return others
      .flatMap((row) => Option.toArray(windowOf(attemptFromRow(row))))
      .filter((window) => windowsOverlap(ownWindow.value, window));
  });

  return { overlappingWindows } as const;
};
