import { and, eq } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { RunDatabase } from "../database/database.ts";
import { attentionAcknowledgements } from "../database/schema.ts";
import { EnginePersistenceError } from "../engine/error.ts";
import { AttentionAcknowledgement, AttentionKey } from "./model.ts";

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(AttentionAcknowledgement));
const persistence =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => new EnginePersistenceError({ operation, cause })));

/** Stores attention acknowledgements without changing runs or asks. */
export class AttentionAcknowledgements extends Context.Service<
  AttentionAcknowledgements,
  {
    readonly list: () => Effect.Effect<
      ReadonlyArray<AttentionAcknowledgement>,
      EnginePersistenceError
    >;
    readonly dismiss: (
      acknowledgement: AttentionAcknowledgement,
    ) => Effect.Effect<void, EnginePersistenceError>;
    readonly undo: (key: AttentionKey) => Effect.Effect<void, EnginePersistenceError>;
  }
>()("@usine/engine/AttentionAcknowledgements") {
  static readonly layer = Layer.effect(
    AttentionAcknowledgements,
    Effect.gen(function* () {
      const database = yield* RunDatabase;
      return {
        list: Effect.fn("AttentionAcknowledgements.list")(function* () {
          const rows = yield* database.select().from(attentionAcknowledgements).execute();
          return yield* decodeRows(rows, { onExcessProperty: "error" });
        }, persistence("read attention acknowledgements")),
        dismiss: Effect.fn("AttentionAcknowledgements.dismiss")(function* (
          acknowledgement: AttentionAcknowledgement,
        ) {
          yield* Effect.annotateCurrentSpan({ needId: acknowledgement.id });
          yield* database
            .insert(attentionAcknowledgements)
            .values({
              ...acknowledgement,
              dismissedBy: Option.getOrNull(acknowledgement.dismissedBy),
              dismissedAt: DateTime.formatIso(acknowledgement.dismissedAt),
            })
            .onConflictDoNothing()
            .execute();
          yield* Effect.logInfo("Attention entry dismissed", {
            needId: acknowledgement.id,
            dismissedBy: acknowledgement.dismissedBy,
          });
        }, persistence("dismiss attention entry")),
        undo: Effect.fn("AttentionAcknowledgements.undo")(function* (key: AttentionKey) {
          yield* Effect.annotateCurrentSpan({ needId: key.id });
          yield* database
            .delete(attentionAcknowledgements)
            .where(
              and(
                eq(attentionAcknowledgements.id, key.id),
                eq(attentionAcknowledgements.revision, key.revision),
              ),
            )
            .execute();
          yield* Effect.logInfo("Attention dismissal undone", { needId: key.id });
        }, persistence("undo attention dismissal")),
      };
    }),
  );
}

export { AttentionAcknowledgement, AttentionKey, AttentionRevision } from "./model.ts";
