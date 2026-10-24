import { type AttemptId, AttemptWindows, windowOf, windowsOverlap } from "@usine/core/attempt";
import { and, eq, inArray, ne } from "drizzle-orm";
import { Effect, Option } from "effect";
import type { RunDatabaseClient } from "../database/database.ts";
import { attempts, runs, triggerEvents } from "../database/schema.ts";
import { attemptFromRow, decodeAttemptRows } from "./codec.ts";
import { attemptSelection } from "./queries.ts";

/** Returns the Attempt window queries that run on the caller's transaction. */
export const attemptWindowQueries = (database: RunDatabaseClient) => {
  /**
   * Returns the window of `attemptId` and the overlapping windows of the same Agent's other
   * Attempts on the Item. An Attempt that ended before end times were recorded has no window: for
   * `attemptId` the result is empty, and other such Attempts are left out. Dies if `attemptId`
   * isn't recorded.
   */
  const attemptWindows = Effect.fn("RunStoreQueries.attemptWindows")(function* (
    attemptId: AttemptId,
  ) {
    yield* Effect.annotateCurrentSpan({ attemptId });
    const [own] = yield* database
      .select(attemptSelection)
      .from(attempts)
      .where(eq(attempts.attemptId, attemptId))
      .execute()
      .pipe(Effect.flatMap(decodeAttemptRows));
    if (own === undefined) return yield* Effect.die(new Error(`No attempt ${attemptId} recorded`));
    const ownWindow = windowOf(attemptFromRow(own));
    if (Option.isNone(ownWindow)) {
      yield* Effect.logDebug(
        "The Attempt ended before end times were recorded, so it has no window and none overlaps it",
        { attemptId },
      );
      return new AttemptWindows({ own: ownWindow, overlapping: [] });
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
    return new AttemptWindows({
      own: ownWindow,
      overlapping: others
        .flatMap((row) => Option.toArray(windowOf(attemptFromRow(row))))
        .filter((window) => windowsOverlap(ownWindow.value, window)),
    });
  });

  return { attemptWindows } as const;
};
