import { Context, Effect, Layer, Option, Schema } from "effect";
import { eq } from "drizzle-orm";
import { RunDatabase } from "../database/database.ts";
import { cursors } from "../database/schema.ts";
import { EnginePersistenceError } from "../model.ts";
import { type CursorKey } from "./model.ts";

const CursorRow = Schema.Struct({ value: Schema.Json });
const decodeCursorRows = Schema.decodeUnknownEffect(Schema.Array(CursorRow));

const persistence =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, EnginePersistenceError, R> =>
    Effect.mapError(effect, (cause) => new EnginePersistenceError({ operation, cause }));

/**
 * Durable storage for efficiency-only cursors. The module that owns a key also
 * owns its schema and passes it per call; a stored value that no longer decodes
 * is treated as absent — losing a cursor is always safe — and logged.
 */
export class CursorStore extends Context.Service<
  CursorStore,
  {
    readonly read: <T, E extends Schema.Json>(
      key: CursorKey,
      schema: Schema.Codec<T, E, never, never>,
    ) => Effect.Effect<Option.Option<T>, EnginePersistenceError>;
    readonly write: <T, E extends Schema.Json>(
      key: CursorKey,
      schema: Schema.Codec<T, E, never, never>,
      value: T,
    ) => Effect.Effect<void, EnginePersistenceError>;
  }
>()("@usine/engine/CursorStore") {
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
