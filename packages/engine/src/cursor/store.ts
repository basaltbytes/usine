import { Context, Effect, Layer, Option, Schema } from "effect";
import { eq } from "drizzle-orm";
import { RunDatabase } from "../database/database.ts";
import { cursors } from "../database/schema.ts";
import { EnginePersistenceError } from "../model.ts";
import { CursorEntry, type CursorKey } from "./model.ts";

const CursorRow = Schema.Struct({ value: Schema.Json });
const decodeCursorRows = Schema.decodeUnknownEffect(Schema.Array(CursorRow));
const encodeJson = Schema.encodeSync(Schema.Json);

const persistence =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, EnginePersistenceError, R> =>
    Effect.mapError(effect, (cause) => new EnginePersistenceError({ operation, cause }));

/** Durable storage for efficiency-only cursors whose schemas stay with their owners. */
export class CursorStore extends Context.Service<
  CursorStore,
  {
    readonly read: (
      key: CursorKey,
    ) => Effect.Effect<Option.Option<Schema.Json>, EnginePersistenceError>;
    readonly write: (entry: CursorEntry) => Effect.Effect<void, EnginePersistenceError>;
  }
>()("@usine/engine/CursorStore") {
  static readonly layer = Layer.effect(
    CursorStore,
    Effect.gen(function* () {
      const database = yield* RunDatabase;

      return {
        read: Effect.fn("CursorStore.read")((key: CursorKey) =>
          Effect.gen(function* () {
            const rows = yield* database
              .select({ value: cursors.valueJson })
              .from(cursors)
              .where(eq(cursors.cursorKey, key))
              .limit(1)
              .execute();
            const decoded = yield* decodeCursorRows(rows);
            return Option.fromNullishOr(decoded[0]).pipe(Option.map(({ value }) => value));
          }).pipe(persistence("read runtime cursor")),
        ),
        write: Effect.fn("CursorStore.write")((entry: CursorEntry) =>
          database
            .insert(cursors)
            .values({ cursorKey: entry.key, valueJson: encodeJson(entry.value) })
            .onConflictDoUpdate({
              target: cursors.cursorKey,
              set: { valueJson: encodeJson(entry.value) },
            })
            .execute()
            .pipe(Effect.asVoid, persistence("write runtime cursor")),
        ),
      };
    }),
  );
}
