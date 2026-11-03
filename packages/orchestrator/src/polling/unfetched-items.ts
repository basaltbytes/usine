import { ItemNumber } from "@usine/core/item";
import type { RepositoryName } from "@usine/core/repository";
import type { GitHubServerError } from "@usine/github/github-app";
import type { ChangedItem } from "@usine/github/polling";
import { Effect, Schema } from "effect";
import { changedItem, FailingItem } from "./evaluation-failures.ts";
import { RepositoryPollFailure, repositoryFailureLogFields } from "./cycle.ts";

/**
 * An Item that GitHub couldn't return in a cycle because of a server error. The poll cursor keeps
 * it, and the next cycle fetches it again.
 */
export class UnfetchedItem extends Schema.Class<UnfetchedItem>("@usine/orchestrator/UnfetchedItem")(
  {
    stream: FailingItem.fields.stream,
    number: ItemNumber,
    updatedAt: Schema.DateTimeUtcFromString,
  },
) {}

/** The outcome of an Item deferred to the next cycle by a GitHub server error. */
interface Unfetched {
  readonly _tag: "Unfetched";
  readonly unfetched: UnfetchedItem;
  readonly failure: RepositoryPollFailure;
}

/** Logs `error` and returns the cursor entry that fetches `item` again in the next cycle. */
export const deferItem = Effect.fn("PollingTriggers.deferItem")(function* (
  repository: RepositoryName,
  item: ChangedItem,
  error: GitHubServerError,
) {
  yield* Effect.annotateCurrentSpan({ repository, item: item.number });
  yield* Effect.logWarning(
    "GitHub returned a server error for an Item; the next cycle fetches it again",
    {
      repository,
      item: item.number,
      operation: error.operation,
      status: error.status.value,
      message: error.message,
    },
  );
  return {
    _tag: "Unfetched",
    failure: RepositoryPollFailure.make({
      repository,
      errorTag: error._tag,
      message: `${repositoryFailureLogFields(error).message} (item ${item.number})`,
    }),
    unfetched: UnfetchedItem.make({
      stream: item._tag === "ChangedIssue" ? "issue" : "pr",
      number: ItemNumber.make(item.number),
      updatedAt: item.updatedAt,
    }),
  } satisfies Unfetched;
});

/** Returns the detection entries that fetch the Items deferred by the last cycle again. */
export const retryUnfetchedItems = Effect.fn("PollingTriggers.retryUnfetchedItems")(function* (
  repository: RepositoryName,
  unfetched: ReadonlyArray<UnfetchedItem>,
) {
  yield* Effect.annotateCurrentSpan({ repository, items: unfetched.length });
  if (unfetched.length > 0) {
    yield* Effect.logInfo("Fetching Items again after a GitHub server error", {
      repository,
      items: unfetched.map(({ number }) => number).join(", "),
    });
  }
  return unfetched.map(changedItem);
});
