import type { ItemKey } from "@usine/core/item";
import { and, asc, eq, gte } from "drizzle-orm";
import { Context, type DateTime, Effect, Layer, Schema } from "effect";
import { RunDatabase } from "../database/database.ts";
import { boardMoves } from "../database/schema.ts";
import { EnginePersistenceError } from "../engine/error.ts";
import { encodeDateTime } from "../store/codec.ts";
import { BoardMoveRecord } from "./model.ts";

const BoardMoveRow = Schema.Struct({
  repository: BoardMoveRecord.fields.repository,
  itemKey: BoardMoveRecord.fields.itemKey,
  at: Schema.DateTimeUtcFromString,
  fromLane: BoardMoveRecord.fields.fromLane,
  toLane: BoardMoveRecord.fields.toLane,
  added: BoardMoveRecord.fields.added,
  removed: BoardMoveRecord.fields.removed,
});

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(BoardMoveRow));
const encodeAdded = Schema.encodeSync(BoardMoveRecord.fields.added);
const encodeRemoved = Schema.encodeSync(BoardMoveRecord.fields.removed);

const persistence =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, EnginePersistenceError, R> =>
    Effect.mapError(effect, (cause) => new EnginePersistenceError({ operation, cause }));

const makeBoardMoves = Effect.gen(function* () {
  const database = yield* RunDatabase;
  return {
    record: Effect.fn("BoardMoves.record")(function* (move: BoardMoveRecord) {
      yield* Effect.annotateCurrentSpan({ repository: move.repository, itemKey: move.itemKey });
      yield* database
        .insert(boardMoves)
        .values({
          repository: move.repository,
          itemKey: move.itemKey,
          movedAt: encodeDateTime(move.at),
          fromLane: move.fromLane,
          toLane: move.toLane,
          addedJson: encodeAdded(move.added),
          removedJson: encodeRemoved(move.removed),
        })
        .execute();
      yield* Effect.logDebug("Recorded a Board move before writing its labels", {
        repository: move.repository,
        itemKey: move.itemKey,
        at: encodeDateTime(move.at),
        fromLane: move.fromLane,
        toLane: move.toLane,
      });
    }, persistence("record board move")),
    onItem: Effect.fn("BoardMoves.onItem")(function* (itemKey: ItemKey, since: DateTime.Utc) {
      yield* Effect.annotateCurrentSpan({ itemKey });
      const rows = yield* database
        .select({
          repository: boardMoves.repository,
          itemKey: boardMoves.itemKey,
          at: boardMoves.movedAt,
          fromLane: boardMoves.fromLane,
          toLane: boardMoves.toLane,
          added: boardMoves.addedJson,
          removed: boardMoves.removedJson,
        })
        .from(boardMoves)
        .where(and(eq(boardMoves.itemKey, itemKey), gte(boardMoves.movedAt, encodeDateTime(since))))
        .orderBy(asc(boardMoves.movedAt), asc(boardMoves.moveId))
        .execute();
      return (yield* decodeRows(rows, { onExcessProperty: "error" })).map(
        (row) => new BoardMoveRecord(row),
      );
    }, persistence("read board moves")),
  } as const;
});

/**
 * The service that records the operator's Board moves, so their label changes aren't attributed
 * to an Agent. Each move is recorded before its labels are sent.
 */
export class BoardMoves extends Context.Service<
  BoardMoves,
  {
    /** Records a move before it's sent to GitHub. If recording fails, nothing was sent. */
    readonly record: (move: BoardMoveRecord) => Effect.Effect<void, EnginePersistenceError>;
    /** Returns the Item's moves at or after `since`, oldest first. */
    readonly onItem: (
      itemKey: ItemKey,
      since: DateTime.Utc,
    ) => Effect.Effect<ReadonlyArray<BoardMoveRecord>, EnginePersistenceError>;
  }
>()("@usine/engine/BoardMoves") {
  static readonly layer = Layer.effect(BoardMoves, makeBoardMoves);
}

export { BoardMoveRecord } from "./model.ts";
