import { PoolRateLimitsUpdated } from "@usine/core/agent/session";
import { sql } from "drizzle-orm";
import { Effect, Schema } from "effect";
import type { RunDatabaseClient } from "../database/database.ts";
import { jsonExtract } from "../database/dialect.ts";
import { poolRateLimits } from "../database/schema.ts";
import { EnginePersistenceError } from "../engine/error.ts";

export const latestPoolRateLimits = Effect.fn("RunReader.latestPoolRateLimits")(
  function* (database: RunDatabaseClient) {
    const rows = yield* database
      .select({
        event: sql<string>`${jsonExtract(poolRateLimits.envelope, "$.payload.event")}`,
      })
      .from(poolRateLimits)
      .execute();
    const events = yield* Schema.decodeEffect(
      Schema.Array(
        Schema.Struct({
          event: Schema.fromJsonString(PoolRateLimitsUpdated),
        }),
      ),
    )(rows, { onExcessProperty: "error" });
    yield* Effect.annotateCurrentSpan({ pools: events.map(({ event }) => event.pool) });
    yield* Effect.logDebug("Read latest pool rate limits", {
      pools: events.map(({ event }) => event.pool),
    });
    return events.map(({ event }) => event);
  },
  Effect.mapError((cause) =>
    EnginePersistenceError.make({ operation: "read latest pool rate limits", cause }),
  ),
);
