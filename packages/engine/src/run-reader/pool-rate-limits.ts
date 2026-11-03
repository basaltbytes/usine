import { PoolRateLimitsUpdated } from "@usine/core/agent/session";
import { sql } from "drizzle-orm";
import { Effect, Schema } from "effect";
import type { RunDatabaseClient } from "../database/database.ts";
import { poolRateLimits } from "../database/schema.ts";
import { persistence } from "../store/codec.ts";

export const latestPoolRateLimits = Effect.fn("RunReader.latestPoolRateLimits")(function* (
  database: RunDatabaseClient,
) {
  const rows = yield* database
    .select({
      event: sql<string>`json_extract(${poolRateLimits.envelope}, '$.payload.event')`,
    })
    .from(poolRateLimits)
    .execute();
  const events = yield* Schema.decodeUnknownEffect(
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
}, persistence("read latest pool rate limits"));
