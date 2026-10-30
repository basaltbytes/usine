import type { EffectDrizzleQueryError, QueryEffectHKTBase } from "drizzle-orm/effect-core";
import type { SQLiteEffectDatabase } from "drizzle-orm/sqlite-core/effect";
import { Context, Layer } from "effect";

interface RunDatabaseEffect extends QueryEffectHKTBase {
  readonly context: never;
  readonly error: EffectDrizzleQueryError;
}

/** The Effect database client for the Run store, independent of the SQLite driver. */
export type RunDatabaseClient = SQLiteEffectDatabase<RunDatabaseEffect, unknown>;

/**
 * The database service for engine records. Adapters must provide atomic SQLite transactions and
 * apply engine migrations before use (ADR 0020).
 */
export class RunDatabase extends Context.Service<RunDatabase, RunDatabaseClient>()(
  "@usine/engine/internal/RunDatabase",
) {
  /** Provides an already initialized database client without opening, migrating, or closing it. */
  static readonly layer = (database: RunDatabaseClient) => Layer.succeed(RunDatabase)(database);
}

export { RepositoryProject, migrateProjectLoops } from "./project-migration.ts";
