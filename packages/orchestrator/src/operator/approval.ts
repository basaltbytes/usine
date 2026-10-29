import type { ItemKey } from "@usine/core/item";
import { ItemProjectionReader } from "@usine/engine/item-projection";
import { Array as EffectArray, Effect, Option } from "effect";
import { projectedItem } from "../board/items.ts";
import { BoardItemLink } from "./board.ts";
import type { RunView } from "./run.ts";

/** Reads the stored items of waiting runs that have no board card. */
export const readApprovalItems = Effect.fn("Operator.readApprovalItems")(function* (
  runs: ReadonlyArray<RunView>,
  cardedItems: ReadonlyMap<ItemKey, BoardItemLink>,
) {
  const reader = yield* ItemProjectionReader;
  const missing = new Set(
    runs.flatMap((run) =>
      run.state === "Waiting" && !cardedItems.has(run.itemKey) ? [run.itemKey] : [],
    ),
  );
  const read = Effect.fn("Operator.readApprovalItem")(function* (itemKey: ItemKey) {
    yield* Effect.annotateCurrentSpan({ itemKey });
    const stored = yield* reader.get(itemKey);
    if (Option.isNone(stored)) {
      yield* Effect.logInfo("Approval has no stored item", { itemKey });
      return Option.none<BoardItemLink>();
    }
    return yield* projectedItem(stored.value).pipe(
      Effect.map((item) => Option.some(new BoardItemLink(item))),
      Effect.tap(() =>
        Effect.logDebug("Read approval item outside the board", {
          itemKey,
          repository: stored.value.repository,
        }),
      ),
      Effect.catchTag("BoardProjectionError", (error) =>
        Effect.logWarning("Approval item projection failed; other approvals continue", {
          itemKey,
          repository: error.repository,
          errorTag: error._tag,
          message: error.message,
        }).pipe(Effect.as(Option.none<BoardItemLink>())),
      ),
    );
  });
  const storedItems = EffectArray.getSomes(
    yield* Effect.forEach(missing, read, { concurrency: 4 }),
  );
  return new Map([...cardedItems, ...storedItems.map((item) => [item.itemKey, item] as const)]);
});
