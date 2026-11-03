import type { EffectDrizzleQueryError, QueryEffectHKTBase } from "drizzle-orm/effect-core";
import type { SQLiteEffectDatabase } from "drizzle-orm/sqlite-core/effect";
import { Context, type Effect, Layer } from "effect";
import type { SqlError } from "effect/sql/SqlError";

interface RunDatabaseEffect extends QueryEffectHKTBase {
  readonly context: never;
  readonly error: EffectDrizzleQueryError;
}

/** The Effect database client for the Run store, independent of the SQLite driver. */
export type RunDatabaseClient = SQLiteEffectDatabase<RunDatabaseEffect, unknown>;

/** Runs related reads against one committed snapshot; adapters can use a separate connection. */
export const ReadSnapshot = Context.Reference<{
  readonly run: <A, E, R>(
    database: RunDatabaseClient,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | EffectDrizzleQueryError | SqlError, R>;
}>("@usine/engine/ReadSnapshot", {
  defaultValue: () => ({ run: (database, effect) => database.transaction(() => effect) }),
});

/**
 * The SQLite composition service for engine records, with atomic transactions and migrations
 * applied before use. Other dialects implement the domain ports directly (ADR 0020).
 */
export class RunDatabase extends Context.Service<RunDatabase, RunDatabaseClient>()(
  "@usine/engine/internal/RunDatabase",
) {
  /** Provides an already initialized database client without opening, migrating, or closing it. */
  static readonly layer = (database: RunDatabaseClient) => Layer.succeed(RunDatabase)(database);
}

export { RepositoryProject, migrateProjectLoops } from "./project-migration.ts";
