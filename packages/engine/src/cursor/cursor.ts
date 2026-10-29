import { Schema, Context, Effect, Layer, Option } from "effect";
import { eq } from "drizzle-orm";
import { RunDatabase } from "../database/database.ts";
import { cursors } from "../database/schema.ts";
import { EnginePersistenceError } from "../engine/error.ts";

/** The key of a cursor; losing a cursor only repeats work. */
export const CursorKey = Schema.NonEmptyString.pipe(Schema.brand("CursorKey"));

export type CursorKey = typeof CursorKey.Type;

const CursorRow = Schema.Struct({ value: Schema.Json });
const decodeCursorRows = Schema.decodeUnknownEffect(Schema.Array(CursorRow));

const persistence =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, EnginePersistenceError, R> =>
    Effect.mapError(effect, (cause) => new EnginePersistenceError({ operation, cause }));

/** The durable cursor store. A stored value that no longer decodes with `schema` reads as `None` and is logged. */
export class CursorStore extends Context.Service<
  CursorStore,
  {
    /**
     * Decodes the JSON stored under `key` with `schema`. Returns `None` for a missing or
     * incompatible value, logging decode failures; storage failures remain typed errors.
     */
    readonly read: <T, E extends Schema.Json>(
      key: CursorKey,
      schema: Schema.Codec<T, E, never, never>,
    ) => Effect.Effect<Option.Option<T>, EnginePersistenceError>;
    /**
     * Encodes `value` with `schema` and replaces the JSON stored under `key`. Encoding and storage
     * failures return `EnginePersistenceError`.
     */
    readonly write: <T, E extends Schema.Json>(
      key: CursorKey,
      schema: Schema.Codec<T, E, never, never>,
      value: T,
    ) => Effect.Effect<void, EnginePersistenceError>;
  }
>()("@usine/engine/CursorStore") {
  /** Stores JSON cursors in the supplied runtime database. */
  static readonly layer = Layer.effect(
    CursorStore,
    Effect.gen(function* () {
      const database = yield* RunDatabase;

      return {
        read: Effect.fn("CursorStore.read")(function* <T, E extends Schema.Json>(
          key: CursorKey,
          schema: Schema.Codec<T, E, never, never>,
        ) {
          const rows = yield* Effect.gen(function* () {
            const selected = yield* database
              .select({ value: cursors.valueJson })
              .from(cursors)
              .where(eq(cursors.cursorKey, key))
              .limit(1)
              .execute();
            return yield* decodeCursorRows(selected);
          }).pipe(persistence("read runtime cursor"));
          const stored = Option.fromNullishOr(rows[0]);
          if (Option.isNone(stored)) return Option.none<T>();
          return yield* Schema.decodeUnknownEffect(schema)(stored.value.value, {
            onExcessProperty: "error",
          }).pipe(
            Effect.map(Option.some),
            Effect.catch((error) =>
              Effect.logWarning("Stored cursor no longer decodes; treating it as absent", {
                key,
                detail: error.message,
              }).pipe(Effect.as(Option.none<T>())),
            ),
          );
        }),
        write: Effect.fn("CursorStore.write")(function* <T, E extends Schema.Json>(
          key: CursorKey,
          schema: Schema.Codec<T, E, never, never>,
          value: T,
        ) {
          const encoded = yield* Schema.encodeEffect(schema)(value).pipe(
            persistence("encode runtime cursor"),
          );
          yield* database
            .insert(cursors)
            .values({ cursorKey: key, valueJson: encoded })
            .onConflictDoUpdate({
              target: cursors.cursorKey,
              set: { valueJson: encoded },
            })
            .execute()
            .pipe(Effect.asVoid, persistence("write runtime cursor"));
        }),
      };
    }),
  );
}
