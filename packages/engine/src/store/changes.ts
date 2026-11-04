import { ChangeBus, type ScopedChange } from "@usine/core/changes";
import { Effect, Schema } from "effect";
import type { RunDatabaseClient } from "../database/database.ts";

// Pure serializers and synchronous callbacks return JSON values directly.
// @effect-diagnostics-next-line schemaSync:off
const stringifyJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

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
            changes.set(stringifyJson([change.audience, change.target]), change);
          });
        const value = yield* database.transaction((transaction) =>
          restore(operation(transaction, record)),
        );
        yield* bus.publish([...changes.values()]);
        return value;
      }),
    );
