import { Context, Effect, Schema } from "effect";

export const SqliteReaderState = Schema.Literals(["worker", "fallback", "respawning"]);
export type SqliteReaderState = typeof SqliteReaderState.Type;

/** Reports where standalone reads execute; respawning reads use the main connection. */
export class SqliteReader extends Context.Service<
  SqliteReader,
  {
    readonly state: Effect.Effect<SqliteReaderState>;
  }
>()("@usine/engine/SqliteReader") {}
