import { canonicalRepositoryName, type RepositoryName } from "@usine/core/repository";
import { type CycleBudgetReset, CycleBudgets } from "@usine/engine/cycle-budget";
import { ItemProjectionReader } from "@usine/engine/item-projection";
import { type ChangedItem, ChangedIssue, ChangedPullRequest } from "@usine/github/polling";
import { Effect, Option, Schema } from "effect";
import { gitHubItemKey } from "./repository-sync.ts";
import type { UnfetchedItem } from "./unfetched-items.ts";

/** The part of a stored Item payload needed to fetch the Item again. */
const decodeStoredItem = Schema.decodeUnknownOption(
  Schema.Struct({ updatedAt: Schema.DateTimeUtcFromString }),
);

/**
 * How a poll cycle refreshes the Items of its repository's pending cycle-budget resets. `Targeted`
 * keeps the stored cursor; `FromScratch` polls from an empty cursor because polling never stored a
 * reset's Item.
 */
interface ResetRefresh {
  readonly _tag: "Targeted" | "FromScratch";
  readonly resets: ReadonlyArray<CycleBudgetReset>;
  /** The reset Items to fetch on top of the detected changes; empty for `FromScratch`. */
  readonly items: ReadonlyArray<ChangedItem>;
}

/** Returns the detection entry that fetches a reset's Item, or `None` if polling never stored it. */
const resetItem = Effect.fn("PollingTriggers.resetItem")(function* (reset: CycleBudgetReset) {
  yield* Effect.annotateCurrentSpan({ itemKey: reset.itemKey });
  const projections = yield* ItemProjectionReader;
  const projection = yield* projections.get(reset.itemKey);
  return Option.flatMap(projection, ({ source, number, payload }) =>
    Option.flatMap(decodeStoredItem(payload), ({ updatedAt }) =>
      source === "issue"
        ? Option.some<ChangedItem>(ChangedIssue.make({ number, updatedAt }))
        : source === "pr"
          ? Option.some<ChangedItem>(ChangedPullRequest.make({ number, updatedAt }))
          : Option.none(),
    ),
  );
});

/** Returns how this cycle refreshes the Items of `repository`'s pending cycle-budget resets. */
export const planResetRefresh = Effect.fn("PollingTriggers.planResetRefresh")(function* (
  repository: RepositoryName,
) {
  yield* Effect.annotateCurrentSpan({ repository });
  const budgets = yield* CycleBudgets;
  const resets = (yield* budgets.pendingResets()).filter(
    (reset) => canonicalRepositoryName(reset.repository) === canonicalRepositoryName(repository),
  );
  const items = Option.all(yield* Effect.forEach(resets, resetItem));
  if (Option.isNone(items)) {
    yield* Effect.logInfo(
      "Cycle budget reset names an Item polling never stored; re-polling the repository from scratch",
      { repository, itemKeys: resets.map(({ itemKey }) => itemKey).join(", ") },
    );
    return { _tag: "FromScratch", resets, items: [] } satisfies ResetRefresh;
  }
  if (items.value.length > 0) {
    yield* Effect.logInfo("Cycle budget reset refreshes its Items", {
      repository,
      items: items.value.map(({ number }) => number).join(", "),
    });
  }
  return { _tag: "Targeted", resets, items: items.value } satisfies ResetRefresh;
});

/**
 * Acknowledges the resets whose Items this cycle evaluated. A reset whose Item is in `unfetched`
 * stays pending, so the next cycle refreshes the Item again.
 */
export const acknowledgeResets = Effect.fn("PollingTriggers.acknowledgeResets")(function* (
  repository: RepositoryName,
  resets: ReadonlyArray<CycleBudgetReset>,
  unfetched: ReadonlyArray<UnfetchedItem>,
) {
  yield* Effect.annotateCurrentSpan({ repository, resets: resets.length });
  const budgets = yield* CycleBudgets;
  const deferred = new Map(
    unfetched.map(({ number }) => [gitHubItemKey(repository, number), number] as const),
  );
  const pending = resets.flatMap(({ itemKey }) =>
    Option.toArray(Option.fromNullishOr(deferred.get(itemKey))),
  );
  if (pending.length > 0) {
    yield* Effect.logInfo("Cycle budget reset stays pending until its Item is fetched", {
      repository,
      items: pending.join(", "),
    });
  }
  yield* Effect.forEach(
    resets.filter(({ itemKey }) => !deferred.has(itemKey)),
    budgets.acknowledgeReset,
    { discard: true },
  );
});
