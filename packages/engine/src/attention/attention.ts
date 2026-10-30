import { and, eq, sql } from "drizzle-orm";
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
    /**
     * Returns all stored dismissals in no specified order, including entries that may no longer be
     * current.
     */
    readonly list: () => Effect.Effect<
      ReadonlyArray<AttentionAcknowledgement>,
      EnginePersistenceError
    >;
    /**
     * Records a dismissal for this entry ID and revision. Repeating it preserves the first
     * operator and time; run and ask state stay unchanged.
     */
    readonly dismiss: (
      acknowledgement: AttentionAcknowledgement,
    ) => Effect.Effect<void, EnginePersistenceError>;
    /**
     * Deletes the dismissal matching both `key.id` and `key.revision`; does nothing if no record
     * matches.
     */
    readonly undo: (key: AttentionKey) => Effect.Effect<void, EnginePersistenceError>;
    /**
     * Deletes acknowledgements without a matching current ID and revision.
     * Include dismissed entries in `current`; an empty list clears all acknowledgements.
     */
    readonly prune: (
      current: ReadonlyArray<AttentionKey>,
    ) => Effect.Effect<void, EnginePersistenceError>;
  }
>()("@usine/engine/AttentionAcknowledgements") {
  /**
   * Persists dismissals in the supplied runtime database; changes invalidate operator projections.
   */
  static readonly layer = Layer.effect(
    AttentionAcknowledgements,
    Effect.gen(function* () {
      const database = yield* RunDatabase;
      return {
        list: Effect.fn("AttentionAcknowledgements.list")(function* () {
          const rows = yield* database.select().from(attentionAcknowledgements).execute();
          return yield* decodeRows(rows, { onExcessProperty: "error" });
        }, persistence("read attention acknowledgements")),
        prune: Effect.fn("AttentionAcknowledgements.prune")(function* (
          current: ReadonlyArray<AttentionKey>,
        ) {
          yield* Effect.annotateCurrentSpan({ currentEntries: current.length });
          const removed = yield* database
            .delete(attentionAcknowledgements)
            .where(sql`not exists (
              select 1 from json_each(${JSON.stringify(current)}) as current
              where json_extract(current.value, '$.id') = ${attentionAcknowledgements.id}
                and json_extract(current.value, '$.revision') = ${attentionAcknowledgements.revision}
            )`)
            .returning({ id: attentionAcknowledgements.id })
            .execute();
          if (removed.length === 0) {
            yield* Effect.logDebug("Attention acknowledgements match current entries", {
              currentEntries: current.length,
            });
            return;
          }
          const fields = {
            currentEntries: current.length,
            prunedEntries: removed.length,
            needIds: removed.map(({ id }) => id),
          };
          yield* Effect.annotateCurrentSpan(fields);
          yield* Effect.logInfo("Pruned obsolete attention acknowledgements", fields);
        }, persistence("prune attention acknowledgements")),
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
