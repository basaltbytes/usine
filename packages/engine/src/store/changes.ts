import { jsonKey } from "@usine/core/json-key";
import { ChangeBus, type ScopedChange } from "@usine/core/changes";
import { Effect } from "effect";
import type { RunDatabaseClient } from "../database/database.ts";

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
