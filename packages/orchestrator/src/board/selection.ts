import { canonicalRepositoryName, type RepositoryName } from "@usine/core/repository";
import * as RunState from "@usine/core/run/state";
import type { ItemProjectionReader } from "@usine/engine/item-projection";
import type { RunSummary } from "@usine/engine/run-reader";
import { Array as EffectArray, Effect, Option } from "effect";

const BOARD_HISTORY_ITEMS = 500;

/** Adds stored items with open runs to the bounded history before task grouping. */
export const readBoardItems = Effect.fn("Board.readItems")(function* (
  reader: ItemProjectionReader["Service"],
  repository: RepositoryName,
  runs: ReadonlyArray<RunSummary>,
) {
  yield* Effect.annotateCurrentSpan({ repository });
  const history = yield* reader.list(repository, { limit: BOARD_HISTORY_ITEMS });
  const included = new Set(history.map(({ itemKey }) => itemKey));
  const missing = new Set(
    runs.flatMap(({ itemKey, repository: runRepository, run }) =>
      canonicalRepositoryName(runRepository) === canonicalRepositoryName(repository) &&
      RunState.isOpen(run.state) &&
      !included.has(itemKey)
        ? [itemKey]
        : [],
    ),
  );
  const additional = EffectArray.getSomes(
    yield* Effect.forEach(
      missing,
      (itemKey) =>
        reader
          .get(itemKey)
          .pipe(
            Effect.tap((item) =>
              Option.isNone(item)
                ? Effect.logInfo("Open run has no stored board item", { repository, itemKey })
                : Effect.void,
            ),
          ),
      { concurrency: 4 },
    ),
  );
  yield* Effect.logDebug("Selected board items", {
    repository,
    history: history.length,
    additional: additional.length,
    missing: missing.size - additional.length,
  });
  return [...history, ...additional].sort((left, right) => right.number - left.number);
});
