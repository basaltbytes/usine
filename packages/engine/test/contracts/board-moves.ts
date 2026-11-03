import { assert, describe, it } from "@effect/vitest";
import { ItemKey } from "@usine/core/item";
import { DateTime, Effect } from "effect";

import { BoardMoveRecord, BoardMoves } from "../../src/board-moves/board-moves.ts";
import { RunReader } from "../../src/run-reader/run-reader.ts";
import { lifecycleSubmission } from "../store/fixtures.ts";
import { type PersistenceAdapter, withPersistence } from "./adapter.ts";

export const boardMovesContract = (adapter: PersistenceAdapter) => {
  describe(`${adapter.name} BoardMoves contract`, () => {
    it.effect("orders moves by time and insertion, filters items and includes the cutoff", () =>
      withPersistence(
        adapter,
        Effect.gen(function* () {
          const moves = yield* BoardMoves;
          const reader = yield* RunReader;
          const revision = yield* reader.revision;
          const first = BoardMoveRecord.make({
            repository: lifecycleSubmission.repository,
            itemKey: lifecycleSubmission.itemKey,
            at: lifecycleSubmission.event.receivedAt,
            fromLane: "Ready",
            toLane: "Review",
            added: ["review"],
            removed: ["ready"],
          });
          const second = BoardMoveRecord.make({
            ...first,
            fromLane: "Review",
            toLane: "Done",
            added: ["done"],
            removed: ["review"],
          });
          const earlier = BoardMoveRecord.make({
            ...first,
            at: DateTime.subtract(first.at, { seconds: 1 }),
          });
          yield* moves.record(first);
          yield* moves.record(second);
          yield* moves.record(earlier);
          yield* moves.record(
            BoardMoveRecord.make({ ...first, itemKey: ItemKey.make("other-item") }),
          );
          assert.deepStrictEqual(yield* moves.onItem(first.itemKey, first.at), [first, second]);
          assert.deepStrictEqual(yield* moves.onItem(first.itemKey, earlier.at), [
            earlier,
            first,
            second,
          ]);
          assert.deepStrictEqual(yield* reader.revision, revision);
        }),
      ),
    );
  });
};
