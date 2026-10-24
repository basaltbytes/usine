import { canonicalRepositoryName, type RepositoryName } from "@usine/core/repository";
import { CycleBudgets } from "@usine/engine/cycle-budget";
import { Effect, Option } from "effect";
import { settledItemState } from "../board/items.ts";

/**
 * Closes each open cycle-budget Ask of `repository` whose stored Item is closed, merged, or gone
 * from GitHub, with the reason `ItemClosed`. The Items keep their cycle budgets.
 */
export const closeAsksOfClosedItems = Effect.fn("PollingTriggers.closeAsksOfClosedItems")(
  function* (repository: RepositoryName) {
    yield* Effect.annotateCurrentSpan({ repository });
    const budgets = yield* CycleBudgets;
    const asks = (yield* budgets.asks()).filter(
      (ask) => canonicalRepositoryName(ask.repository) === canonicalRepositoryName(repository),
    );
    for (const ask of asks) {
      const fields = { askId: ask.id, itemKey: ask.itemKey, repository: ask.repository };
      const state = yield* settledItemState(ask.itemKey);
      if (Option.isNone(state)) {
        yield* Effect.logDebug(
          "Cycle-budget Ask stays open; its Item is open or not stored",
          fields,
        );
        continue;
      }
      const closed = yield* budgets.close(ask.id, "ItemClosed");
      if (closed)
        yield* Effect.logInfo("Item is closed; its cycle-budget Ask leaves Needs attention", {
          ...fields,
          itemState: state.value,
        });
    }
  },
);
