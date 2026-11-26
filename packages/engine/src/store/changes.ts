import { jsonKey } from "@usine/core/json-key";
import { ChangeBus, type ScopedChange } from "@usine/core/changes";
import type { AttemptId } from "@usine/core/attempt";
import type { RunId } from "@usine/core/run";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import type { RunDatabaseClient } from "../database/database.ts";
import { attempts, runs, triggerEvents } from "../database/schema.ts";

export type RecordChange = (change: ScopedChange) => Effect.Effect<void>;

/** Publishes each target once after commit; a failed transaction discards its pending notices. */
export const changeTransaction =
  (database: RunDatabaseClient, bus: typeof ChangeBus.Service) =>
  <A, E, R>(
    operation: (transaction: RunDatabaseClient, record: RecordChange) => Effect.Effect<A, E, R>,
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const changes = new Map<string, ScopedChange>();
        const record: RecordChange = (change) =>
          Effect.sync(() => {
            changes.set(jsonKey([change.audience, change.target]), change);
          });
        const value = yield* database.transaction((transaction) =>
          restore(operation(transaction, record)),
        );
        yield* bus.publish([...changes.values()]);
        return value;
      }),
    );

/** Returns the recorders of Run and Attempt changes, which do nothing without `record`. */
export const changeRecorder = (database: RunDatabaseClient, record?: RecordChange) => {
  const changedRun = (runId: RunId) =>
    Effect.gen(function* () {
      if (record === undefined) return;
      const [row] = yield* database
        .select({ repository: runs.repository, itemKey: triggerEvents.itemKey })
        .from(runs)
        .innerJoin(triggerEvents, eq(triggerEvents.eventId, runs.eventId))
        .where(eq(runs.runId, runId))
        .execute();
      if (row === undefined) return;
      const audience = { _tag: "Repository", repository: row.repository } as const;
      yield* record({ audience, target: { kind: "run", id: runId } });
      yield* record({ audience, target: { kind: "item", id: row.itemKey } });
    });
  const changedAttempt = (attemptId: AttemptId) =>
    Effect.gen(function* () {
      if (record === undefined) return;
      const [row] = yield* database
        .select({ repository: runs.repository, runId: runs.runId })
        .from(attempts)
        .innerJoin(runs, eq(runs.runId, attempts.runId))
        .where(eq(attempts.attemptId, attemptId))
        .execute();
      if (row === undefined) return;
      yield* record({
        audience: { _tag: "Repository", repository: row.repository },
        target: { kind: "attempt", id: attemptId },
      });
      yield* changedRun(row.runId);
    });

  return { changedRun, changedAttempt } as const;
};
