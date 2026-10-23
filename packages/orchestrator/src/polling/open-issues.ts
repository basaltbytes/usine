import type { ManagedRepo } from "@usine/config/factory";
import { ItemProjectionReader } from "@usine/engine/item-projection";
import { GitHubPolling } from "@usine/github/polling";
import { DateTime, Duration, Effect, Option, Result } from "effect";
import type { ResolvedLoop } from "../trigger-submission.ts";
import { RepositoryPollFailure, repositoryFailureLogFields } from "./cycle.ts";
import { revokeMissingItem } from "./loop-evaluation.ts";
import { markItemGone } from "./repository-sync.ts";

/** The minimum time between open issue checks of a repository. */
export const OPEN_ISSUE_CHECK_INTERVAL = Duration.minutes(10);

/** The result of one open issue check in a poll cycle. */
interface OpenIssueCheck {
  readonly revokedRuns: number;
  readonly failures: ReadonlyArray<RepositoryPollFailure>;
  readonly nextPollAt: Option.Option<DateTime.Utc>;
}

export const NO_OPEN_ISSUE_CHECK: OpenIssueCheck = {
  revokedRuns: 0,
  failures: [],
  nextPollAt: Option.none(),
};

/**
 * Marks each issue stored as open in `repository` that GitHub no longer has as gone, and revokes
 * its unstarted Runs. Reports GitHub request failures without failing the cycle; fails on
 * persistence errors.
 */
export const checkOpenIssues = Effect.fn("PollingTriggers.checkOpenIssues")(function* (
  repository: ManagedRepo,
  loops: ReadonlyArray<ResolvedLoop>,
) {
  yield* Effect.annotateCurrentSpan({ repository: repository.name });
  const items = yield* ItemProjectionReader;
  const github = yield* GitHubPolling;
  const open = yield* items.openIssues(repository.name);
  if (open.length === 0) {
    yield* Effect.logDebug("No open issues to check against GitHub", {
      repository: repository.name,
    });
    return NO_OPEN_ISSUE_CHECK;
  }
  const result = yield* Effect.result(github.missingIssues(repository.name, open));
  if (Result.isFailure(result)) {
    const error = result.failure;
    if (error._tag === "GitHubRateLimitError") {
      yield* Effect.logWarning("Open-issue check rate-limited; checking again in 10 minutes", {
        repository: repository.name,
        openIssues: open.length,
        operation: error.operation,
        retryAt: DateTime.formatIso(error.retryAt),
      });
      return { ...NO_OPEN_ISSUE_CHECK, nextPollAt: Option.some(error.retryAt) };
    }
    yield* Effect.logError("Open-issue check failed; checking again in 10 minutes", {
      repository: repository.name,
      openIssues: open.length,
      ...repositoryFailureLogFields(error),
    });
    return {
      ...NO_OPEN_ISSUE_CHECK,
      failures: [
        new RepositoryPollFailure({
          repository: repository.name,
          errorTag: error._tag,
          message: error.message,
        }),
      ],
    };
  }
  let revokedRuns = 0;
  for (const number of result.success) {
    const revoked = yield* revokeMissingItem(repository, loops, "issue", number);
    const projectionMarkedGone = yield* markItemGone(repository.name, number);
    revokedRuns += revoked;
    yield* Effect.logInfo("GitHub no longer has an open issue; it leaves the open lanes", {
      repository: repository.name,
      item: number,
      revokedRuns: revoked,
      projectionMarkedGone,
    });
  }
  yield* Effect.logDebug("Checked open issues against GitHub", {
    repository: repository.name,
    openIssues: open.length,
    missingIssues: result.success.length,
  });
  return { ...NO_OPEN_ISSUE_CHECK, revokedRuns } satisfies OpenIssueCheck;
});
