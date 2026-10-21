import type { WorkerName } from "@usine/core/worker";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { type DateTime, Effect, Schema } from "effect";
import type { RunDatabaseClient } from "../database/database.ts";
import { attempts } from "../database/schema.ts";
import { WorkerAttempts } from "../run-reader/model.ts";
import { encodeDateTime } from "./codec.ts";

// Startup reconciliation visits an Attempt until the operator discards its leftovers.
const tracked = isNull(attempts.leftoversDiscardedAt);
// An Attempt without an outcome is still open: it runs, or its Run has not closed it yet.
const open = isNull(attempts.outcomeJson);

/**
 * Counts and discards, per Worker, the Attempts startup reconciliation visits,
 * on the caller's transaction.
 */
export const leftoverQueries = (database: RunDatabaseClient) => {
  const attemptCountsByWorker = Effect.fn("RunStoreQueries.attemptCountsByWorker")(function* () {
    const rows = yield* database
      .select({
        worker: attempts.workerName,
        attempts: sql<number>`count(*)`,
        running: sql<number>`sum(case when ${open} then 1 else 0 end)`,
      })
      .from(attempts)
      .where(tracked)
      .groupBy(attempts.workerName)
      .orderBy(asc(attempts.workerName))
      .execute();
    return yield* Schema.decodeUnknownEffect(Schema.Array(WorkerAttempts))(rows);
  });

  /** How many tracked Attempts on `worker` are open; 0 for a Worker without any tracked Attempt. */
  const openAttempts = Effect.fn("RunStoreQueries.openAttempts")(function* (worker: WorkerName) {
    const counted = yield* attemptCountsByWorker();
    return counted.find((count) => count.worker === worker)?.running ?? 0;
  });

  /** Stops tracking every Attempt on `worker`; returns how many it marked. */
  const discardLeftovers = Effect.fn("RunStoreQueries.discardLeftovers")(function* (
    worker: WorkerName,
    discardedAt: DateTime.Utc,
  ) {
    const discarded = yield* database
      .update(attempts)
      .set({ leftoversDiscardedAt: encodeDateTime(discardedAt) })
      .where(and(eq(attempts.workerName, worker), tracked))
      .returning({ attemptId: attempts.attemptId })
      .execute();
    return discarded.length;
  });

  return { attemptCountsByWorker, openAttempts, discardLeftovers } as const;
};
