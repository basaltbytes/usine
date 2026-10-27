import type { RepositoryName } from "@usine/core/repository";
import {
  type BaseRefHead,
  BaseRefName,
  type ChangedItem,
  ChangedPullRequest,
  GitHubPolling,
  type PayloadSnapshot,
} from "@usine/github/polling";
import { Array as Arr, Effect, Option, Result, Schema } from "effect";
import { repositoryFailureLogFields } from "./cycle.ts";

const BASE_REF_CONCURRENCY = 4;

/** An open pull request's last observed base branch, mergeability, and check refresh state. */
export class OpenPullRequest extends Schema.Class<OpenPullRequest>(
  "@usine/orchestrator/OpenPullRequest",
)({
  number: ChangedPullRequest.fields.number,
  updatedAt: Schema.DateTimeUtcFromString,
  /** `None` in a cursor written before polling recorded base branches. */
  baseRefName: Schema.OptionFromOptionalKey(BaseRefName),
  mergeable: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("UNKNOWN"))),
  /** Older cursors refresh once to learn whether checks have settled. */
  checksUnsettled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
}) {}

/** Returns the cursor entry for a fetched Item, or `None` unless the Item is an open pull request. */
export const openPullRequest = (
  item: ChangedItem,
  snapshot: PayloadSnapshot,
): Option.Option<OpenPullRequest> =>
  snapshot._tag === "PullRequestSnapshot" && snapshot.payload.state === "OPEN"
    ? Option.some(
        new OpenPullRequest({
          number: item.number,
          updatedAt: item.updatedAt,
          baseRefName: Option.some(snapshot.payload.baseRefName),
          mergeable: snapshot.payload.mergeable,
          checksUnsettled:
            snapshot.payload.statusCheckRollup?.state === "PENDING" ||
            snapshot.payload.statusCheckRollup?.state === "EXPECTED" ||
            (snapshot.payload.statusCheckRollup === null &&
              snapshot.payload.mergeStateStatus === "BLOCKED"),
        }),
      )
    : Option.none();

/** The result of reading one base branch head in a poll. */
type BaseRefRead =
  | { readonly _tag: "Unchanged"; readonly head: BaseRefHead }
  | { readonly _tag: "Moved"; readonly head: BaseRefHead }
  | { readonly _tag: "Unreadable"; readonly recorded: Option.Option<BaseRefHead> };

/** Why a poll fetches an open pull request that change detection didn't report. */
type RefreshReason =
  | "baseUnrecorded"
  | "baseMoved"
  | "baseUnreadable"
  | "mergeableUnknown"
  | "checksUnsettled";

/** The open pull requests that a poll fetches again, and the base branch heads to record. */
interface OpenPullRequestRefresh {
  readonly refreshed: ReadonlyArray<OpenPullRequest>;
  /** The heads read in this poll, and the recorded head of each branch that couldn't be read. */
  readonly baseRefHeads: ReadonlyArray<BaseRefHead>;
}

const readBaseRef = Effect.fn("PollingTriggers.readBaseRef")(function* (
  repository: RepositoryName,
  baseRefName: BaseRefName,
  recorded: Option.Option<BaseRefHead>,
  pullRequests: ReadonlyArray<number>,
) {
  yield* Effect.annotateCurrentSpan({ repository, baseRefName });
  const github = yield* GitHubPolling;
  const result = yield* Effect.result(github.baseRefHead(repository, baseRefName, recorded));
  if (Result.isFailure(result)) {
    const error = result.failure;
    // A rate limit interrupts the repository cycle, as for every other request, so the poll backs off.
    if (error._tag === "GitHubRateLimitError") return yield* error;
    yield* Effect.logWarning(
      "Could not read the base branch head; refreshing its open pull requests in this poll",
      {
        repository,
        baseRefName,
        pullRequests: pullRequests.join(", "),
        ...repositoryFailureLogFields(error),
      },
    );
    return { _tag: "Unreadable", recorded } satisfies BaseRefRead;
  }
  const head = result.success;
  if (Option.isNone(recorded)) {
    yield* Effect.logInfo("Base branch head recorded; refreshing its open pull requests once", {
      repository,
      baseRefName,
      head: head.sha,
      pullRequests: pullRequests.join(", "),
    });
    return { _tag: "Moved", head } satisfies BaseRefRead;
  }
  if (recorded.value.sha !== head.sha) {
    yield* Effect.logInfo("Base branch head moved; refreshing its open pull requests", {
      repository,
      baseRefName,
      previousHead: recorded.value.sha,
      head: head.sha,
      pullRequests: pullRequests.join(", "),
    });
    return { _tag: "Moved", head } satisfies BaseRefRead;
  }
  return { _tag: "Unchanged", head } satisfies BaseRefRead;
});

const refreshReason = (
  pullRequest: OpenPullRequest,
  reads: ReadonlyMap<BaseRefName, BaseRefRead>,
): Option.Option<RefreshReason> => {
  if (Option.isNone(pullRequest.baseRefName)) return Option.some("baseUnrecorded");
  const read = reads.get(pullRequest.baseRefName.value);
  if (read?._tag === "Moved") return Option.some("baseMoved");
  if (read?._tag === "Unreadable") return Option.some("baseUnreadable");
  if (pullRequest.mergeable === "UNKNOWN") return Option.some("mergeableUnknown");
  if (pullRequest.checksUnsettled) return Option.some("checksUnsettled");
  return Option.none();
};

/**
 * Reads the head of each base branch that `openPullRequests` target, with one conditional request
 * per branch, and returns the pull requests to fetch again: those whose base branch isn't recorded,
 * moved, or couldn't be read, and those whose mergeability or checks are unsettled. Leaves out the
 * numbers in `fetched`, which the poll fetches anyway. Fails only if GitHub rate-limits a read.
 */
export const openPullRequestRefresh = Effect.fn("PollingTriggers.openPullRequestRefresh")(
  function* (
    repository: RepositoryName,
    openPullRequests: ReadonlyArray<OpenPullRequest>,
    recordedHeads: ReadonlyArray<BaseRefHead>,
    fetched: ReadonlySet<number>,
  ) {
    yield* Effect.annotateCurrentSpan({ repository });
    if (openPullRequests.length === 0) {
      return { refreshed: [], baseRefHeads: [] } satisfies OpenPullRequestRefresh;
    }
    const byBaseRef = new Map<BaseRefName, Array<number>>();
    for (const { number, baseRefName } of openPullRequests) {
      if (Option.isNone(baseRefName)) continue;
      const numbers = byBaseRef.get(baseRefName.value) ?? [];
      numbers.push(number);
      byBaseRef.set(baseRefName.value, numbers);
    }
    const reads = new Map(
      yield* Effect.forEach(
        byBaseRef,
        ([baseRefName, pullRequests]) =>
          readBaseRef(
            repository,
            baseRefName,
            Option.fromNullishOr(recordedHeads.find((head) => head.baseRefName === baseRefName)),
            pullRequests,
          ).pipe(Effect.map((read) => [baseRefName, read] as const)),
        { concurrency: BASE_REF_CONCURRENCY },
      ),
    );
    const notFetched = openPullRequests.filter(({ number }) => !fetched.has(number));
    const refreshed = notFetched.flatMap((pullRequest) =>
      Option.toArray(
        Option.map(refreshReason(pullRequest, reads), (reason) => ({ pullRequest, reason })),
      ),
    );
    if (refreshed.length === 0) {
      yield* Effect.logDebug("No open pull request needs a refresh", {
        repository,
        openPullRequests: openPullRequests.length,
        baseRefReads: reads.size,
      });
    } else {
      const reasons = Arr.groupBy(refreshed, ({ reason }) => reason);
      yield* Effect.logInfo("Refreshing open pull requests", {
        repository,
        baseRefReads: reads.size,
        refreshed: refreshed.length,
        skipped: notFetched.length - refreshed.length,
        ...Object.fromEntries(
          Object.entries(reasons).map(([reason, entries]) => [
            reason,
            entries.map(({ pullRequest }) => pullRequest.number).join(", "),
          ]),
        ),
      });
    }
    return {
      refreshed: refreshed.map(({ pullRequest }) => pullRequest),
      baseRefHeads: [...reads.values()]
        .flatMap((read) =>
          read._tag === "Unreadable" ? Option.toArray(read.recorded) : [read.head],
        )
        .sort((left, right) => left.baseRefName.localeCompare(right.baseRefName)),
    } satisfies OpenPullRequestRefresh;
  },
);
