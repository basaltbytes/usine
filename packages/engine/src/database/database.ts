import type { EffectDrizzleQueryError, QueryEffectHKTBase } from "drizzle-orm/effect-core";
import type { SQLiteEffectDatabase } from "drizzle-orm/sqlite-core/effect";
import { Context, Layer } from "effect";

interface RunDatabaseEffect extends QueryEffectHKTBase {
  readonly context: never;
  readonly error: EffectDrizzleQueryError;
}

/** The Effect database the run projection store queries, independent of the SQLite driver. */
export type RunDatabaseClient = SQLiteEffectDatabase<RunDatabaseEffect, unknown>;

export class RunDatabase extends Context.Service<RunDatabase, RunDatabaseClient>()(
  "@usine/engine/internal/RunDatabase",
) {
  static readonly layer = (database: RunDatabaseClient) => Layer.succeed(RunDatabase)(database);
}
