import type { ManagedRepo } from "@usine/config/factory";
import { isServerError } from "@usine/github/github-app";
import type { ChangedItem, GitHubItemNotFoundError } from "@usine/github/polling";
import { Effect, type Option } from "effect";
import type { ResolvedLoop } from "../trigger-submission.ts";
import { type FailingItem, failingItem, logItemEvaluation } from "./evaluation-failures.ts";
import { evaluateItem, revokeMissingItem } from "./loop-evaluation.ts";
import { markItemGone, observeItem } from "./repository-sync.ts";
import { deferItem } from "./unfetched-items.ts";

/** What the poll cursor knows about a changed Item before this cycle fetches it. */
export interface KeptItem {
  /** The Loop failures an earlier cycle recorded for the Item. */
  readonly recorded: Option.Option<FailingItem>;
  /** Whether only the cursor or a reset, not change detection, made this cycle fetch the Item. */
  readonly cursorOnly: boolean;
  /** Whether the cursor records the Item as an open pull request. */
  readonly openPullRequest: boolean;
}

/**
 * Drops an Item that only the cursor kept and that GitHub no longer has: revokes its unstarted Runs
 * and marks its Board projection gone.
 */
const dropMissingItem = Effect.fn("PollingTriggers.dropMissingItem")(function* (
  repository: ManagedRepo,
  loops: ReadonlyArray<ResolvedLoop>,
  item: ChangedItem,
  kept: KeptItem,
  error: GitHubItemNotFoundError,
) {
  yield* Effect.annotateCurrentSpan({ repository: repository.name, item: item.number });
  const revokedRuns = yield* revokeMissingItem(
    repository,
    loops,
    item._tag === "ChangedIssue" ? "issue" : "pr",
    item.number,
  );
  const projectionMarkedGone = yield* markItemGone(repository.name, item.number);
  yield* Effect.logWarning(
    "GitHub no longer has an Item the poll cursor kept; it is dropped from the cursor",
    {
      repository: repository.name,
      item: item.number,
      openPullRequest: kept.openPullRequest,
      revokedRuns,
      projectionMarkedGone,
      errorTag: error._tag,
      message: error.message,
    },
  );
  return { _tag: "Missing", revokedRuns } as const;
});

/**
 * Fetches one changed Item and evaluates its Loops. A GitHub server error defers the Item to the
 * next cycle. An Item that only the cursor kept and that GitHub no longer has is dropped. Other
 * failures fail the repository's cycle.
 */
export const evaluateChangedItem = Effect.fn("PollingTriggers.evaluateChangedItem")(
  function* (
    repository: ManagedRepo,
    loops: ReadonlyArray<ResolvedLoop>,
    item: ChangedItem,
    kept: KeptItem,
  ) {
    yield* Effect.annotateCurrentSpan({ repository: repository.name, item: item.number });
    const observation = yield* observeItem(repository.name, item);
    const cycle = yield* evaluateItem(repository, loops, observation);
    const failing = failingItem(item, observation.projection.contentHash, cycle.failures);
    yield* logItemEvaluation(repository.name, item.number, kept.recorded, failing);
    return { _tag: "Evaluated", item, observation, cycle, failing } as const;
  },
  (effect, repository, loops, item, kept) =>
    effect.pipe(
      Effect.catchIf(isServerError, (error) => deferItem(repository.name, item, error)),
      // An Item kept only by the cursor may have been deleted or transferred, and must not stall
      // the repository. Other failures still interrupt the cycle, which retries next time.
      Effect.catchTag("GitHubItemNotFoundError", (error) =>
        Effect.gen(function* () {
          if (!kept.cursorOnly) return yield* error;
          return yield* dropMissingItem(repository, loops, item, kept, error);
        }),
      ),
    ),
);
