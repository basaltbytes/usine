import {
  type Brand,
  DateTime,
  Duration,
  Effect,
  Option,
  type Predicate,
  Result,
  Schema,
} from "effect";
import { githubSignature } from "../agent/agent.ts";
import { type AttemptWindow, AttemptWindows, windowHolds } from "../attempt/attempt.ts";
import type { RunSpec } from "../attempt/channel.ts";
import {
  BranchNotAtHead,
  type CiHandoff,
  describeUnverifiedHandoff,
  GitHubReadFailed,
  GitReadFailed,
  HeadMismatch,
  PullRequestNotFound,
  PullRequestNotOpen,
  RepositoryMismatch,
  type UnverifiedHandoff,
  VerificationTimedOut,
} from "../ci.ts";
import { ItemNumber } from "../item.ts";
import {
  CommitSha,
  RepositoryName,
  RepositoryRevision,
  splitRepositoryName,
} from "../repository.ts";
import { retryTransient } from "../retry.ts";
import { Comment, type CommentKind, Commit, PullRequest, type StepResultFact } from "./result.ts";

/** The fields of `RunSpec` that harvesting reads. */
export type HarvestSpec = Pick<
  RunSpec,
  | "attemptId"
  | "repository"
  | "revision"
  | "baseCommit"
  | "payload"
  | "preparedAt"
  | "botLogin"
  | "agent"
  | "requiresCi"
>;

/** The facts from a finished Attempt's checkout. */
export interface Harvest {
  readonly facts: ReadonlyArray<StepResultFact>;
  /** Why harvesting couldn't verify the pull request that CI waits on, or `None`. */
  readonly unverifiedHandoff: Option.Option<UnverifiedHandoff>;
}

/**
 * An effect that reads the harvested Attempt's `AttemptWindows`. Harvesting runs it after
 * GitHub lists the comments, so the result includes Attempts that started during the harvest.
 */
export type AttemptWindowsRead<W> = Effect.Effect<AttemptWindows, W>;

/**
 * A function that runs a read-only `git` or `gh` command in the checkout and returns its
 * stdout lines. Fails with `E` on a non-zero exit.
 */
export type HarvestCommand<E> = (
  command: "git" | "gh",
  args: ReadonlyArray<string>,
) => Effect.Effect<ReadonlyArray<string>, E>;

/** An error for invalid `git` or GitHub output, or for Attempt windows that can't be read. */
export class HarvestError extends Schema.TaggedError<
  HarvestError,
  Brand.Brand<"@usine/core/step/harvest/HarvestError">
>("@usine/core/HarvestError")("HarvestError", {
  /** The source of the invalid output or failed window read. */
  stage: Schema.Literals(["git", "github", "windows"]),
  /** The diagnostic describing which harvest input could not be read. */
  message: Schema.NonEmptyString,
  /** The original decoding or storage failure preserved for diagnosis. */
  cause: Schema.Defect(),
}) {}

// GitHub follows a renamed repository's redirect, so repositories are compared by ID.
const PullRequestResponse = Schema.Struct({
  number: PullRequest.fields.number,
  url: Schema.URLFromString,
  state: Schema.Literals(["open", "closed"]),
  /** When the pull request was merged; `null` if it is open or was closed without merging. */
  mergedAt: Schema.NullOr(Schema.String),
  head: Schema.Struct({
    sha: CommitSha,
    ref: Schema.NonEmptyString,
    repo: Schema.NullOr(Schema.Struct({ id: Schema.Int, full_name: RepositoryName })),
  }),
  base: Schema.Struct({ repo: Schema.Struct({ id: Schema.Int }) }),
}).pipe(Schema.encodeKeys({ url: "html_url", mergedAt: "merged_at" }));
type PullRequestResponse = typeof PullRequestResponse.Type;
const decodePullRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(PullRequestResponse));
const decodePullRequests = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(PullRequestResponse)),
);
const decodePullRequestPages = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.Array(PullRequestResponse))),
);
const decodeCommit = Schema.decodeUnknownEffect(CommitSha);

/** Decodes the Item `number` and `url` from a payload. Returns `None` for a schedule payload. */
const decodePayloadItem = Schema.decodeUnknownOption(
  Schema.Struct({ number: ItemNumber, url: Schema.URLFromString }),
);

/** The GraphQL query for the credential's login, used only if the `RunSpec` has no bot login. */
const VIEWER_QUERY = "query=query { viewer { login } }";
const decodeViewer = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({ viewer: Schema.Struct({ login: Schema.NonEmptyString }) }),
    }),
  ),
);

const Author = Schema.NullOr(Schema.Struct({ login: Schema.String }));
// GitHub's schema has an optional body for issue comments and a required body for reviews and
// review comments; a review without text has an empty body.
const IssueCommentResponse = Schema.Struct({
  url: Schema.URLFromString,
  user: Author,
  body: Schema.optionalKey(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
}).pipe(Schema.encodeKeys({ url: "html_url", createdAt: "created_at", updatedAt: "updated_at" }));
const decodeIssueCommentPages = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.Array(IssueCommentResponse))),
);
const ReviewResponse = Schema.Struct({
  id: Schema.Int,
  url: Schema.URLFromString,
  user: Author,
  body: Schema.String,
  state: Schema.String,
  submittedAt: Schema.optionalKey(Schema.NullOr(Schema.DateTimeUtcFromString)),
}).pipe(Schema.encodeKeys({ url: "html_url", submittedAt: "submitted_at" }));
const decodeReviewPages = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.Array(ReviewResponse))),
);
const ReviewCommentResponse = Schema.Struct({
  url: Schema.URLFromString,
  user: Author,
  body: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  reviewId: Schema.NullOr(Schema.Int),
}).pipe(
  Schema.encodeKeys({
    url: "html_url",
    createdAt: "created_at",
    updatedAt: "updated_at",
    reviewId: "pull_request_review_id",
  }),
);
const decodeReviewCommentPages = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.Array(ReviewCommentResponse))),
);

/** Runs a `gh` command and decodes its output. Fails with a `github` `HarvestError` if the output is invalid. */
const askGitHub = <A, E, D>(
  run: HarvestCommand<E>,
  args: ReadonlyArray<string>,
  decode: (output: string) => Effect.Effect<A, D>,
  what: string,
) =>
  run("gh", args).pipe(
    Effect.flatMap((lines) =>
      decode(lines.join("\n")).pipe(
        Effect.mapError((cause) =>
          HarvestError.make({
            stage: "github",
            message: `GitHub returned invalid ${what}`,
            cause,
          }),
        ),
      ),
    ),
  );

/** Returns the commits from the checkout's base to its final HEAD, oldest first. */
const harvestCommits = Effect.fn("StepResult.harvestCommits")(function* <E>(
  spec: HarvestSpec,
  run: HarvestCommand<E>,
) {
  yield* Effect.annotateCurrentSpan({ attemptId: spec.attemptId, repository: spec.repository });
  // The first space ends the commit ID.
  const lines = yield* run("git", [
    "log",
    "--reverse",
    "--format=%H %s",
    `${spec.baseCommit}..HEAD`,
  ]);
  return yield* Effect.forEach(lines, (line) =>
    Effect.gen(function* () {
      const separator = line.indexOf(" ");
      const sha = yield* decodeCommit(separator < 0 ? line : line.slice(0, separator)).pipe(
        Effect.mapError((cause) =>
          HarvestError.make({ stage: "git", message: "Git returned an invalid commit ID", cause }),
        ),
      );
      const summary = separator < 0 ? "" : line.slice(separator + 1).trim();
      if (summary.length === 0) {
        return yield* HarvestError.make({
          stage: "git",
          message: `Commit ${sha} has no summary`,
          cause: new Error("empty commit summary"),
        });
      }
      return Commit.make({ sha, summary });
    }),
  );
});

/** The time limit for each of pull request and comment discovery. */
const DISCOVERY_BUDGET = Duration.seconds(10);

/**
 * Runs `discovery` within the discovery budget. If it fails or times out, logs a warning that
 * ends with `retaining` and returns `nothing`.
 */
const enrichment = <A, E extends { readonly _tag: string; readonly message: string }>(
  spec: HarvestSpec,
  subject: "Pull request" | "Comment",
  discovery: Effect.Effect<A, E>,
  nothing: A,
  retaining = "retaining the completed agent result",
) =>
  discovery.pipe(
    Effect.timeout(DISCOVERY_BUDGET),
    Effect.catch((error) =>
      Effect.logWarning(
        error._tag === "TimeoutError"
          ? `${subject} discovery timed out; ${retaining}`
          : `${subject} discovery failed; ${retaining}`,
        {
          attemptId: spec.attemptId,
          repository: spec.repository,
          errorTag: error._tag,
          message: error.message,
        },
      ).pipe(Effect.as(nothing)),
    ),
  );

/** The checkout's final commit, on a named branch or detached. */
type CheckoutHead =
  | { readonly _tag: "Named"; readonly head: CommitSha; readonly branch: string }
  | { readonly _tag: "Detached"; readonly head: CommitSha };

/** Returns the checkout's final commit and, unless HEAD is detached, its branch. */
const checkoutHead = Effect.fn("StepResult.checkoutHead")(function* <E>(run: HarvestCommand<E>) {
  const head = yield* decodeCommit((yield* run("git", ["rev-parse", "HEAD"])).join("")).pipe(
    Effect.mapError((cause) =>
      HarvestError.make({ stage: "git", message: "Git returned an invalid final HEAD", cause }),
    ),
  );
  const branch = (yield* run("git", ["branch", "--show-current"])).join("");
  const checkout: CheckoutHead =
    branch === "" ? { _tag: "Detached", head } : { _tag: "Named", head, branch };
  return checkout;
});

/**
 * Returns whether a detached checkout at `head` has no pull request candidate. Checkouts start
 * detached at the base commit, so an unchanged one has nothing to push, unless its revision is
 * that fixed commit.
 */
const unchangedDetached = (spec: HarvestSpec, head: CommitSha): boolean =>
  head === spec.baseCommit && spec.revision !== RepositoryRevision.make(spec.baseCommit);

/** Returns the commit of each branch and pull request head ref on origin, by ref name. */
const originRefs = Effect.fn("StepResult.originRefs")(function* <E>(run: HarvestCommand<E>) {
  const lines = yield* run("git", ["ls-remote", "origin", "refs/heads/*", "refs/pull/*/head"]);
  const refs = yield* Effect.forEach(lines, (line) => {
    const [commit, ref = ""] = line.split("\t");
    return decodeCommit(commit).pipe(
      Effect.mapBoth({
        onSuccess: (sha) => [ref, sha] as const,
        onFailure: (cause) =>
          HarvestError.make({ stage: "git", message: "Git returned an invalid remote ref", cause }),
      }),
    );
  });
  const byRef: ReadonlyMap<string, CommitSha> = new Map(refs);
  return byRef;
});

const branchHeadOn = (refs: ReadonlyMap<string, CommitSha>, branch: string) =>
  Option.fromUndefinedOr(refs.get(`refs/heads/${branch}`));

const pullRequestAt = (spec: HarvestSpec, number: number, url: URL, head: CommitSha) =>
  PullRequest.make({ number, url, base: Option.some(spec.baseCommit), head: Option.some(head) });

const fromRunRepository = (pr: PullRequestResponse): boolean =>
  pr.head.repo !== null && pr.head.repo.id === pr.base.repo.id;

const headRepositoryOf = (pr: PullRequestResponse) =>
  Option.fromNullOr(pr.head.repo).pipe(Option.map(({ full_name }) => full_name));

/** Returns `open`, `closed`, or `merged`; GitHub reports a merged pull request as `closed`. */
const lifecycleOf = (pr: PullRequestResponse) => (pr.mergedAt === null ? pr.state : "merged");

const openFromRunRepository = (pr: PullRequestResponse): boolean =>
  lifecycleOf(pr) === "open" && fromRunRepository(pr);

/**
 * Returns the pull requests whose head is `head` in GitHub's commit-to-pull-request index,
 * without duplicates.
 */
const indexedPullRequests = Effect.fn("StepResult.indexedPullRequests")(function* <E>(
  spec: HarvestSpec,
  run: HarvestCommand<E>,
  head: CommitSha,
) {
  const pages = yield* askGitHub(
    run,
    ["api", `repos/${spec.repository}/commits/${head}/pulls?per_page=100`, "--paginate", "--slurp"],
    decodePullRequestPages,
    "pull request results",
  );
  // The response also has pull requests that contain the commit as an ancestor.
  const atHead = new Map<number, PullRequestResponse>();
  for (const pr of pages.flat()) {
    if (pr.head.sha === head) atHead.set(pr.number, pr);
  }
  yield* Effect.logInfo("Collected Attempt pull request results", {
    attemptId: spec.attemptId,
    head,
    base: spec.baseCommit,
    pullRequests: [...atHead.keys()],
  });
  return [...atHead.values()];
});

/**
 * Returns the pull requests whose head is the checkout's pushed final commit, from GitHub's
 * index. Harvesting uses it when it has no CI handoff and the Loop doesn't require CI.
 */
const findPullRequests = Effect.fn("StepResult.findPullRequests")(function* <E>(
  spec: HarvestSpec,
  run: HarvestCommand<E>,
) {
  yield* Effect.annotateCurrentSpan({ attemptId: spec.attemptId, repository: spec.repository });
  const { _tag, head } = yield* checkoutHead(run);
  if (_tag === "Detached" && unchangedDetached(spec, head)) {
    yield* Effect.logDebug("No pull request candidate in the Attempt checkout", {
      attemptId: spec.attemptId,
    });
    return [];
  }
  // GitHub returns HTTP 422 for a commit that was never pushed, so first check that a branch or
  // `refs/pull/<n>/head` points at it.
  if (head !== spec.baseCommit) {
    const refs = yield* originRefs(run);
    if (![...refs.values()].includes(head)) {
      yield* Effect.logDebug("No remote branch or pull request has the Attempt's final commit", {
        attemptId: spec.attemptId,
        head,
      });
      return [];
    }
  }
  const indexed = yield* indexedPullRequests(spec, run, head);
  return indexed.map(({ number, url }) => pullRequestAt(spec, number, url, head));
});

/** A `git` or `gh` failure from the runner, or invalid output from either. */
type ReadError = { readonly _tag: string; readonly message: string };

const describeReadError = (error: ReadError) => `${error._tag}: ${error.message}`;

const gitReadFailed = (error: ReadError) =>
  GitReadFailed.make({ message: describeReadError(error), cause: error });

/** Accepts every failed read or invalid output for a retry. */
const everyFailure: Predicate.Predicate<unknown> = () => true;

/** Accepts no failure for a retry. */
const noFailure: Predicate.Predicate<unknown> = () => false;

/**
 * Runs a `gh` read and decodes its output. Retries a failed read or invalid output that
 * `retryable` accepts on the polling reads' schedule and logs each retry. Fails with
 * `GitHubReadFailed` after the last try.
 */
const readGitHub = <A, E extends ReadError, D>(
  spec: HarvestSpec,
  run: HarvestCommand<E>,
  args: ReadonlyArray<string>,
  decode: (output: string) => Effect.Effect<A, D>,
  what: string,
  retryable: Predicate.Predicate<E | HarvestError>,
) =>
  askGitHub(run, args, decode, what).pipe(
    retryTransient(retryable, ({ error, retry, delay }) =>
      Effect.logWarning(`Could not read ${what} on GitHub; retrying`, {
        attemptId: spec.attemptId,
        repository: spec.repository,
        errorTag: error._tag,
        message: error.message,
        retry,
        delayMs: Duration.toMillis(delay),
      }),
    ),
    Effect.mapError((error) =>
      GitHubReadFailed.make({ message: describeReadError(error), cause: error }),
    ),
  );

/**
 * Reads pull request `number`, retrying the failures that `retryable` accepts, then logs its
 * branch's commit on origin against its head on GitHub.
 */
const readPullRequest = <E extends ReadError>(
  spec: HarvestSpec,
  run: HarvestCommand<E>,
  number: ItemNumber,
  refs: ReadonlyMap<string, CommitSha>,
  retryable: Predicate.Predicate<E | HarvestError>,
) =>
  readGitHub(
    spec,
    run,
    ["api", `repos/${spec.repository}/pulls/${number}`],
    decodePullRequest,
    `pull request #${number}`,
    retryable,
  ).pipe(
    Effect.tap((pr) =>
      Effect.logInfo("Read the pull request that CI would wait on", {
        attemptId: spec.attemptId,
        pullRequest: number,
        state: lifecycleOf(pr),
        branch: pr.head.ref,
        branchHead: Option.getOrNull(branchHeadOn(refs, pr.head.ref)),
        pullRequestHead: pr.head.sha,
      }),
    ),
  );

/**
 * Reads the handoff's pull request. Retries a failed read while origin has the pull request's
 * `refs/pull/<n>/head`; without that ref, fails with `PullRequestNotFound`.
 */
const readHandoffPullRequest = <E extends ReadError>(
  spec: HarvestSpec,
  run: HarvestCommand<E>,
  { pullRequest, head }: CiHandoff,
  refs: ReadonlyMap<string, CommitSha>,
) => {
  const onOrigin = refs.has(`refs/pull/${pullRequest}/head`);
  return readPullRequest(spec, run, pullRequest, refs, onOrigin ? everyFailure : noFailure).pipe(
    Effect.mapError((error) =>
      onOrigin
        ? error
        : PullRequestNotFound.make({
            pullRequest: Option.some(pullRequest),
            branch: Option.none(),
            head,
          }),
    ),
  );
};

/**
 * Returns the handoff's pull request if it's open, the checkout's HEAD is the handed-off head,
 * and HEAD is on the pull request's branch on origin, even when GitHub's pull request head lags.
 * Fails with the reason otherwise.
 */
const verifyHandoff = Effect.fn("StepResult.verifyHandoff")(function* <E extends ReadError>(
  spec: HarvestSpec,
  run: HarvestCommand<E>,
  handoff: CiHandoff,
) {
  const { pullRequest } = handoff;
  yield* Effect.annotateCurrentSpan({
    attemptId: spec.attemptId,
    repository: spec.repository,
    pullRequest,
  });
  const { head } = yield* checkoutHead(run).pipe(Effect.mapError(gitReadFailed));
  if (handoff.head !== head) {
    return yield* Effect.fail(HeadMismatch.make({ pullRequest, handedOff: handoff.head, head }));
  }
  const refs = yield* originRefs(run).pipe(Effect.mapError(gitReadFailed));
  const pr = yield* readHandoffPullRequest(spec, run, handoff, refs);
  const lifecycle = lifecycleOf(pr);
  if (lifecycle !== "open") {
    return yield* Effect.fail(PullRequestNotOpen.make({ pullRequest, state: lifecycle }));
  }
  if (!fromRunRepository(pr)) {
    return yield* Effect.fail(
      RepositoryMismatch.make({ pullRequest, headRepository: headRepositoryOf(pr) }),
    );
  }
  const branchHead = branchHeadOn(refs, pr.head.ref);
  if (!Option.contains(branchHead, head)) {
    return yield* Effect.fail(
      BranchNotAtHead.make({
        pullRequest: Option.some(pullRequest),
        branch: pr.head.ref,
        branchHead,
        head,
      }),
    );
  }
  return [pullRequestAt(spec, pr.number, pr.url, head)];
});

/**
 * Runs `read` for each candidate, four at a time, and returns the successes and, with their
 * candidates, the failures.
 */
const readCandidates = Effect.fn("StepResult.readCandidates")(function* <C, A>(
  candidates: ReadonlyArray<C>,
  read: (candidate: C) => Effect.Effect<A, GitHubReadFailed>,
) {
  const results = yield* Effect.forEach(candidates, (candidate) => Effect.result(read(candidate)), {
    concurrency: 4,
  });
  const succeeded = results.flatMap((result) => (Result.isSuccess(result) ? [result.success] : []));
  const failed = results.flatMap((result, index) =>
    Result.isFailure(result) ? [{ candidate: candidates[index], failure: result.failure }] : [],
  );
  return { succeeded, failed };
});

/** Logs a warning for each candidate whose read failed while another verified a pull request. */
const logUnreadCandidates = <C>(
  spec: HarvestSpec,
  failed: ReadonlyArray<{ readonly candidate: C; readonly failure: GitHubReadFailed }>,
) =>
  Effect.forEach(
    failed,
    ({ candidate, failure }) =>
      Effect.logWarning(
        "Could not read one candidate's pull requests; CI waits on the other candidates' open pull requests",
        {
          attemptId: spec.attemptId,
          repository: spec.repository,
          candidate: String(candidate),
          message: failure.message,
        },
      ),
    { discard: true },
  );

/**
 * Returns the open pull requests whose head is one of `branches`. A branch whose read fails is
 * skipped if another has an open pull request. Fails with the first read failure if none has
 * one and a read failed, or with `PullRequestNotFound`.
 */
const branchPullRequests = Effect.fn("StepResult.branchPullRequests")(function* <
  E extends ReadError,
>(
  spec: HarvestSpec,
  run: HarvestCommand<E>,
  head: CommitSha,
  branches: ReadonlyArray<string>,
  named: Option.Option<string>,
) {
  yield* Effect.logInfo("Reading open pull requests for origin branches at the checkout's HEAD", {
    attemptId: spec.attemptId,
    head,
    branches,
  });
  const { owner } = splitRepositoryName(spec.repository);
  const { succeeded, failed } = yield* readCandidates(branches, (candidate) =>
    readGitHub(
      spec,
      run,
      [
        "api",
        `repos/${spec.repository}/pulls?head=${owner}:${encodeURIComponent(candidate)}&state=open&per_page=100`,
      ],
      decodePullRequests,
      `the pull requests of branch ${candidate}`,
      everyFailure,
    ),
  );
  const open = [...new Map(succeeded.flat().map((pr) => [pr.number, pr])).values()];
  const [unread] = failed;
  if (open.length === 0) {
    return yield* Effect.fail(
      unread?.failure ??
        PullRequestNotFound.make({ pullRequest: Option.none(), branch: named, head }),
    );
  }
  yield* logUnreadCandidates(spec, failed);
  return open.map(({ number, url }) => pullRequestAt(spec, number, url, head));
});

/**
 * Returns the open pull requests among `numbers` whose head is `head` on GitHub and whose head
 * repository is the Run's. A pull request whose read fails is skipped if another verifies. Fails
 * with the first read failure if none verifies and a read failed, with `RepositoryMismatch` for
 * the first open pull request from another repository, or with `PullRequestNotFound`.
 */
const numberedPullRequests = Effect.fn("StepResult.numberedPullRequests")(function* <
  E extends ReadError,
>(
  spec: HarvestSpec,
  run: HarvestCommand<E>,
  head: CommitSha,
  numbers: ReadonlyArray<ItemNumber>,
  refs: ReadonlyMap<string, CommitSha>,
) {
  yield* Effect.logInfo("Reading the pull requests whose origin head ref is the checkout's HEAD", {
    attemptId: spec.attemptId,
    head,
    pullRequests: numbers,
  });
  const { succeeded, failed } = yield* readCandidates(numbers, (number) =>
    readPullRequest(spec, run, number, refs, everyFailure),
  );
  const open = succeeded.filter((pr) => lifecycleOf(pr) === "open");
  const own = succeeded.filter((pr) => openFromRunRepository(pr) && pr.head.sha === head);
  if (own.length > 0) {
    yield* logUnreadCandidates(spec, failed);
    return own.map(({ number, url }) => pullRequestAt(spec, number, url, head));
  }
  const [unread] = failed;
  if (unread !== undefined) return yield* Effect.fail(unread.failure);
  const foreign = open.find((pr) => !fromRunRepository(pr));
  if (foreign !== undefined) {
    return yield* Effect.fail(
      RepositoryMismatch.make({
        pullRequest: ItemNumber.make(foreign.number),
        headRepository: headRepositoryOf(foreign),
      }),
    );
  }
  return yield* Effect.fail(
    PullRequestNotFound.make({ pullRequest: Option.none(), branch: Option.none(), head }),
  );
});

const decodePullRef = Schema.decodeUnknownOption(ItemNumber);

/**
 * Returns the open pull requests at a detached checkout's HEAD: those of the origin branches at
 * HEAD, or else those whose `refs/pull/<n>/head` is HEAD, read by number. Fails with
 * `PullRequestNotFound` without reading origin if the checkout is unchanged, and with the reason
 * otherwise.
 */
const verifyDetached = Effect.fn("StepResult.verifyDetached")(function* <E extends ReadError>(
  spec: HarvestSpec,
  run: HarvestCommand<E>,
  head: CommitSha,
) {
  const notFound = PullRequestNotFound.make({
    pullRequest: Option.none(),
    branch: Option.none(),
    head,
  });
  if (unchangedDetached(spec, head)) return yield* Effect.fail(notFound);
  const refs = yield* originRefs(run).pipe(Effect.mapError(gitReadFailed));
  const atHead = [...refs].flatMap(([ref, commit]) => (commit === head ? [ref] : []));
  const branches = atHead.flatMap((ref) =>
    ref.startsWith("refs/heads/") ? [ref.slice("refs/heads/".length)] : [],
  );
  if (branches.length > 0) {
    return yield* branchPullRequests(spec, run, head, branches, Option.none());
  }
  const numbers = atHead.flatMap((ref) => {
    const number = /^refs\/pull\/(\d+)\/head$/u.exec(ref)?.[1];
    return number === undefined ? [] : Option.toArray(decodePullRef(Number(number)));
  });
  if (numbers.length === 0) return yield* Effect.fail(notFound);
  return yield* numberedPullRequests(spec, run, head, numbers, refs);
});

/**
 * Returns the open pull requests whose head is the checkout's `branch`, if that branch is at
 * `head` on origin. Fails with the reason otherwise.
 */
const verifyNamed = Effect.fn("StepResult.verifyNamed")(function* <E extends ReadError>(
  spec: HarvestSpec,
  run: HarvestCommand<E>,
  head: CommitSha,
  branch: string,
) {
  const refs = yield* originRefs(run).pipe(Effect.mapError(gitReadFailed));
  const branchHead = branchHeadOn(refs, branch);
  if (!Option.contains(branchHead, head)) {
    return yield* Effect.fail(
      BranchNotAtHead.make({ pullRequest: Option.none(), branch, branchHead, head }),
    );
  }
  return yield* branchPullRequests(spec, run, head, [branch], Option.some(branch));
});

/**
 * Returns the open pull requests at the checkout's HEAD, as `verifyNamed` finds them for a
 * checkout on a branch and `verifyDetached` for a detached one. Fails with the reason otherwise.
 */
const verifyBranch = Effect.fn("StepResult.verifyBranch")(function* <E extends ReadError>(
  spec: HarvestSpec,
  run: HarvestCommand<E>,
) {
  yield* Effect.annotateCurrentSpan({ attemptId: spec.attemptId, repository: spec.repository });
  const checkout = yield* checkoutHead(run).pipe(Effect.mapError(gitReadFailed));
  return yield* checkout._tag === "Named"
    ? verifyNamed(spec, run, checkout.head, checkout.branch)
    : verifyDetached(spec, run, checkout.head);
});

/** The pull requests at the checkout's final commit, or why the one that CI waits on isn't verified. */
type PullRequestHarvest = Result.Result<ReadonlyArray<PullRequest>, UnverifiedHandoff>;

/**
 * Runs `verification` within the discovery budget, fails with `VerificationTimedOut` if it
 * doesn't finish, and logs the outcome.
 */
const verificationOutcome = Effect.fn("StepResult.verificationOutcome")(function* (
  spec: HarvestSpec,
  verification: Effect.Effect<ReadonlyArray<PullRequest>, UnverifiedHandoff>,
): Effect.fn.Return<PullRequestHarvest> {
  yield* Effect.annotateCurrentSpan({
    attemptId: spec.attemptId,
    repository: spec.repository,
    item: Option.getOrNull(Option.map(decodePayloadItem(spec.payload), ({ number }) => number)),
  });
  return yield* verification.pipe(
    Effect.timeoutOrElse({
      duration: DISCOVERY_BUDGET,
      orElse: () =>
        Effect.fail(VerificationTimedOut.make({ seconds: Duration.toSeconds(DISCOVERY_BUDGET) })),
    }),
    Effect.result,
    Effect.tap(
      Result.match({
        onSuccess: (pullRequests) =>
          Effect.logInfo("Verified the pull request that CI waits on", {
            attemptId: spec.attemptId,
            repository: spec.repository,
            pullRequests: pullRequests.map(({ number }) => number),
          }),
        onFailure: (reason) =>
          Effect.logInfo("Could not verify the pull request that CI waits on", {
            attemptId: spec.attemptId,
            repository: spec.repository,
            reason: reason._tag,
            detail: describeUnverifiedHandoff(reason),
          }),
      }),
    ),
  );
});

/**
 * Returns `verified` followed by the other open pull requests from the Run's repository at `head`
 * in GitHub's commit-to-pull-request index. If the index read fails or times out, returns
 * `verified`.
 */
const withIndexedAtHead = <E extends ReadError>(
  spec: HarvestSpec,
  run: HarvestCommand<E>,
  head: CommitSha,
  verified: ReadonlyArray<PullRequest>,
) =>
  enrichment(
    spec,
    "Pull request",
    indexedPullRequests(spec, run, head),
    [],
    "keeping only the CI handoff's pull request",
  ).pipe(
    Effect.flatMap((indexed) => {
      const known = new Set(verified.map(({ number }) => number));
      const others = indexed.filter(({ number }) => !known.has(number));
      const left = others.filter((pr) => !openFromRunRepository(pr));
      return (
        left.length === 0
          ? Effect.void
          : Effect.logInfo(
              "Left out the indexed pull requests at the handoff's head that aren't open or come from another repository",
              {
                attemptId: spec.attemptId,
                repository: spec.repository,
                pullRequests: left.map(({ number }) => number),
              },
            )
      ).pipe(
        Effect.as([
          ...verified,
          ...others
            .filter(openFromRunRepository)
            .map(({ number, url }) => pullRequestAt(spec, number, url, head)),
        ]),
      );
    }),
  );

/**
 * Returns the pull requests at the checkout's final commit, or why the one that CI waits on isn't
 * verified. With a CI handoff, verifies the pull request it names and adds the other open pull
 * requests from the Run's repository at its head in GitHub's commit-to-pull-request index. If the
 * Loop requires CI, verifies the pull request of the checkout's branch. Otherwise asks the index,
 * and a failure or timeout leaves no pull request.
 */
const harvestPullRequests = Effect.fn("StepResult.harvestPullRequests")(function* <
  E extends ReadError,
>(
  spec: HarvestSpec,
  run: HarvestCommand<E>,
  handoff: Option.Option<CiHandoff>,
): Effect.fn.Return<PullRequestHarvest> {
  yield* Effect.annotateCurrentSpan({
    attemptId: spec.attemptId,
    repository: spec.repository,
    item: Option.getOrNull(Option.map(decodePayloadItem(spec.payload), ({ number }) => number)),
  });
  return yield* Option.match(handoff, {
    onSome: (request) =>
      Effect.gen(function* () {
        const verified = yield* verificationOutcome(spec, verifyHandoff(spec, run, request));
        if (Result.isFailure(verified)) return verified;
        const withOthers = yield* withIndexedAtHead(spec, run, request.head, verified.success);
        return Result.succeed<ReadonlyArray<PullRequest>>(withOthers);
      }),
    onNone: () =>
      spec.requiresCi
        ? verificationOutcome(spec, verifyBranch(spec, run))
        : enrichment(spec, "Pull request", findPullRequests(spec, run), []).pipe(
            Effect.map((pullRequests) => Result.succeed(pullRequests)),
          ),
  });
});

/** The login whose comments harvesting keeps, and its source. */
interface Author {
  readonly login: string;
  readonly source: "run-spec" | "viewer";
}

/** Returns the login of the Attempt's credential, as reported by GitHub. */
const credentialLogin = Effect.fn("StepResult.credentialLogin")(function* <E>(
  spec: HarvestSpec,
  item: ItemNumber,
  run: HarvestCommand<E>,
) {
  yield* Effect.logInfo(
    "The RunSpec names no bot login, so harvesting asks GitHub for the login of the Attempt's credential",
    { attemptId: spec.attemptId, repository: spec.repository, item },
  );
  const { data } = yield* askGitHub(
    run,
    ["api", "graphql", "-f", VIEWER_QUERY],
    decodeViewer,
    "the credential's login",
  );
  return { login: data.viewer.login, source: "viewer" } satisfies Author;
});

/** A signed comment or review by the Attempt's bot login, with its GitHub post time. */
interface Posted {
  readonly fact: Comment;
  readonly at: DateTime.Utc;
}

/**
 * The comments by the Attempt's bot login on the Run's Item, before windows are applied.
 *
 * - `signed`: posted since preparation and ending with the Agent's signature.
 * - `unsigned`: the number posted since preparation without the signature.
 * - `edited`: the number posted before preparation and edited since.
 */
interface Listing {
  readonly item: ItemNumber;
  readonly author: Author;
  readonly since: string;
  readonly signed: ReadonlyArray<Posted>;
  readonly unsigned: number;
  readonly edited: number;
}

/**
 * Lists the comments, and for a pull request the submitted reviews and diff comments, that the
 * bot login posted on the Run's Item since preparation. Returns `None` if the Run has no Item
 * or no preparation time.
 */
const listComments = Effect.fn("StepResult.listComments")(function* <E>(
  spec: HarvestSpec,
  run: HarvestCommand<E>,
) {
  yield* Effect.annotateCurrentSpan({ attemptId: spec.attemptId, repository: spec.repository });
  const item = decodePayloadItem(spec.payload);
  if (Option.isNone(item)) {
    yield* Effect.logDebug("The Run has no GitHub Item, so no comment is collected", {
      attemptId: spec.attemptId,
    });
    return Option.none<Listing>();
  }
  const { number, url } = item.value;
  if (Option.isNone(spec.preparedAt)) {
    yield* Effect.logInfo(
      "The Attempt was prepared before preparation times were recorded, so no comment is collected",
      { attemptId: spec.attemptId, repository: spec.repository, item: number },
    );
    return Option.none<Listing>();
  }
  // GitHub records times to the second, and `since` takes YYYY-MM-DDTHH:MM:SSZ.
  const prepared = DateTime.toEpochMillis(spec.preparedAt.value);
  const since = prepared - (prepared % 1_000);
  const sinceParameter = `${DateTime.formatIso(DateTime.makeUnsafe(since)).slice(0, 19)}Z`;
  const author: Author = Option.isSome(spec.botLogin)
    ? { login: spec.botLogin.value, source: "run-spec" }
    : yield* credentialLogin(spec, number, run);
  const { login } = author;
  yield* Effect.annotateCurrentSpan({
    item: number,
    author: login,
    authorSource: author.source,
    agent: spec.agent.name,
  });
  const list = (path: string) => [
    "api",
    `repos/${spec.repository}/${path}`,
    "--paginate",
    "--slurp",
  ];
  // GitHub's pull request URLs are /<owner>/<repo>/pull/<number>; an issue's use `issues`.
  const pullRequest = url.pathname.split("/")[3] === "pull";
  const [conversation, reviews, diffComments] = yield* Effect.all(
    [
      askGitHub(
        run,
        list(`issues/${number}/comments?since=${sinceParameter}&per_page=100`),
        decodeIssueCommentPages,
        "issue comments",
      ),
      pullRequest
        ? askGitHub(
            run,
            list(`pulls/${number}/reviews?per_page=100`),
            decodeReviewPages,
            "pull request reviews",
          )
        : Effect.succeed([]),
      pullRequest
        ? askGitHub(
            run,
            list(`pulls/${number}/comments?since=${sinceParameter}&per_page=100`),
            decodeReviewCommentPages,
            "review comments",
          )
        : Effect.succeed([]),
    ],
    { concurrency: "unbounded" },
  );
  const byLogin = (user: typeof Author.Type) => user !== null && user.login === login;
  const sincePrepared = (at: DateTime.Utc) => DateTime.toEpochMillis(at) >= since;
  // A pending review and its comments are a draft visible only to its author.
  const pending = new Set(
    reviews.flat().flatMap(({ id, state }) => (state === "PENDING" ? [id] : [])),
  );
  // A comment's post time is its creation time and a review's is its submission time. The
  // reviews endpoint ignores `since`, so reviews are filtered by submission time.
  const written = [
    ...conversation.flat().flatMap(({ url, user, body, createdAt }) =>
      byLogin(user)
        ? [
            {
              body,
              at: createdAt,
              fact: Comment.make({ url, kind: "issue-comment", at: Option.some(createdAt) }),
            },
          ]
        : [],
    ),
    ...reviews.flat().flatMap(({ url, user, body, state, submittedAt }) =>
      state !== "PENDING" &&
      submittedAt !== undefined &&
      submittedAt !== null &&
      byLogin(user) &&
      sincePrepared(submittedAt)
        ? [
            {
              body,
              at: submittedAt,
              fact: Comment.make({ url, kind: "review", at: Option.some(submittedAt) }),
            },
          ]
        : [],
    ),
    ...diffComments.flat().flatMap(({ url, user, body, createdAt, reviewId }) =>
      (reviewId === null || !pending.has(reviewId)) && byLogin(user)
        ? [
            {
              body,
              at: createdAt,
              fact: Comment.make({ url, kind: "review-comment", at: Option.some(createdAt) }),
            },
          ]
        : [],
    ),
  ];
  // `since` filters by update time, so it also returns comments created before preparation and
  // edited later; those are dropped (#429).
  const posted = written.filter(({ at }) => sincePrepared(at));
  // Attempts that write as the same bot login are distinguished by the Agent's signature
  // (ADR 0006, #394). Trailing whitespace is ignored.
  const signature = githubSignature(spec.agent.name);
  const signed = posted.filter(
    ({ body }) => body !== undefined && body.trimEnd().endsWith(signature),
  );
  return Option.some<Listing>({
    item: number,
    author,
    since: sinceParameter,
    signed,
    unsigned: posted.length - signed.length,
    edited: written.length - posted.length,
  });
});

/** Formats `window` as an ISO interval for logs, with the end `open` while running. Returns `unrecorded` for `None`. */
const describeWindow = (window: Option.Option<AttemptWindow>) =>
  Option.match(window, {
    onNone: () => "unrecorded",
    onSome: ({ startedAt, endedAt }) => {
      const end = Option.match(endedAt, { onNone: () => "open", onSome: DateTime.formatIso });
      return `${DateTime.formatIso(startedAt)}/${end}`;
    },
  });

/**
 * Returns the signed comments in `listing` that are inside the Attempt's own window and outside
 * the overlapping windows (#429). Reads `windows` only if a comment is signed. Fails with a
 * `windows` `HarvestError` if the read fails.
 */
const attributeComments = Effect.fn("StepResult.attributeComments")(function* <W>(
  spec: HarvestSpec,
  listing: Listing,
  windows: AttemptWindowsRead<W>,
) {
  yield* Effect.annotateCurrentSpan({
    attemptId: spec.attemptId,
    repository: spec.repository,
    item: listing.item,
  });
  // Read after the listing so the result includes every Attempt that could have posted a comment.
  const { own, overlapping } =
    listing.signed.length === 0
      ? AttemptWindows.make({ own: Option.none(), overlapping: [] })
      : yield* windows.pipe(
          Effect.mapError((cause) =>
            HarvestError.make({
              stage: "windows",
              message:
                "Can't read the windows of this attempt and of the agent's other attempts on the item",
              cause,
            }),
          ),
        );
  const placed = listing.signed.map(({ at, fact }) => ({
    at,
    fact,
    inside: Option.exists(own, (window) => windowHolds(window, at)),
    others: overlapping.filter((window) => windowHolds(window, at)),
  }));
  const outside = placed.filter(({ inside }) => !inside);
  const ambiguous = placed.filter(({ inside, others }) => inside && others.length > 0);
  const posted = placed.flatMap(({ inside, others, fact }) =>
    inside && others.length === 0 ? [fact] : [],
  );
  yield* Effect.forEach(
    outside,
    ({ at, fact }) =>
      Effect.logInfo("Left out a comment posted outside the Attempt's own window on the Item", {
        attemptId: spec.attemptId,
        window: describeWindow(own),
        postedAt: DateTime.formatIso(at),
        comment: fact.url.href,
        kind: fact.kind,
      }),
    { discard: true },
  );
  yield* Effect.forEach(
    ambiguous,
    ({ fact, others }) =>
      Effect.logInfo(
        "Left out a comment that another open Attempt of the Agent on the Item could have posted",
        {
          attemptId: spec.attemptId,
          overlapping: others.map(({ attemptId }) => attemptId),
          comment: fact.url.href,
          kind: fact.kind,
        },
      ),
    { discard: true },
  );
  const counted = (kind: CommentKind) => posted.filter((comment) => comment.kind === kind).length;
  yield* Effect.logInfo("Collected the comments and reviews the Attempt posted on its Item", {
    attemptId: spec.attemptId,
    repository: spec.repository,
    item: listing.item,
    author: listing.author.login,
    authorSource: listing.author.source,
    agent: spec.agent.name,
    since: listing.since,
    issueComments: counted("issue-comment"),
    reviews: counted("review"),
    reviewComments: counted("review-comment"),
    // Posted since preparation without the Agent's signature.
    unsigned: listing.unsigned,
    // Posted before preparation and edited since.
    edited: listing.edited,
    // Signed, but posted outside the Attempt's own window, for example after a cancel.
    outside: outside.length,
    // Signed, but posted while another Attempt of the Agent was open on the Item.
    ambiguous: ambiguous.length,
    // Empty if no listed comment is signed.
    overlapping: overlapping.map(({ attemptId }) => attemptId),
  });
  return posted;
});

/**
 * Returns the comments and reviews attributed to the Attempt. If GitHub discovery fails, returns
 * an empty list. Fails with `HarvestError` if the windows can't be read.
 */
const harvestComments = <E extends { readonly _tag: string; readonly message: string }, W>(
  spec: HarvestSpec,
  run: HarvestCommand<E>,
  windows: AttemptWindowsRead<W>,
  retaining?: string,
) =>
  enrichment(spec, "Comment", listComments(spec, run), Option.none<Listing>(), retaining).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed<ReadonlyArray<Comment>>([]),
        onSome: (listing) => attributeComments(spec, listing, windows),
      }),
    ),
  );

/** Logs a warning that the windows couldn't be read, ending with `outcome`. */
const windowsUnread = (spec: HarvestSpec, outcome: string) => (error: HarvestError) =>
  Effect.logWarning(
    `Could not read the Attempt's window and those of the Agent's other Attempts on the Item, so the Attempt's comments cannot be told from theirs; ${outcome}`,
    {
      attemptId: spec.attemptId,
      repository: spec.repository,
      cause: String(error.cause),
    },
  );

/**
 * Returns the facts from a finished Attempt's checkout: new commits, the pull requests at the
 * final commit, and the comments and reviews attributed to the Attempt. A GitHub failure or
 * 10-second timeout drops only the GitHub facts. Fails with `HarvestError` if git output is
 * invalid or the windows can't be read.
 *
 * A CI handoff, or a Loop that requires CI, verifies the pull request on origin even when
 * GitHub's pull request head lags; `unverifiedHandoff` says why verification failed.
 */
export const harvestFacts = Effect.fn("StepResult.harvest")(function* <
  E extends { readonly _tag: string; readonly message: string },
  W,
>(
  spec: HarvestSpec,
  run: HarvestCommand<E>,
  windows: AttemptWindowsRead<W>,
  handoff: Option.Option<CiHandoff>,
) {
  yield* Effect.annotateCurrentSpan({ attemptId: spec.attemptId, repository: spec.repository });
  const commits = yield* harvestCommits(spec, run);
  const pullRequests = yield* harvestPullRequests(spec, run, handoff);
  const comments = yield* harvestComments(spec, run, windows).pipe(
    Effect.tapError(windowsUnread(spec, "the harvest fails")),
  );
  return {
    facts: [...commits, ...Result.getOrElse(pullRequests, () => []), ...comments],
    unverifiedHandoff: Result.getFailure(pullRequests),
  } satisfies Harvest;
});

/**
 * Returns the comments and reviews that an unsuccessful Attempt posted on the Run's Item,
 * attributed as in `harvestFacts`. Never fails; on any error, returns an empty list.
 */
export const harvestPostedComments = Effect.fn("StepResult.harvestPostedComments")(function* <
  E extends { readonly _tag: string; readonly message: string },
  W,
>(spec: HarvestSpec, run: HarvestCommand<E>, windows: AttemptWindowsRead<W>) {
  yield* Effect.annotateCurrentSpan({ attemptId: spec.attemptId, repository: spec.repository });
  const outcome = "the Attempt that ended without success records no comment";
  const comments: ReadonlyArray<Comment> = yield* harvestComments(spec, run, windows, outcome).pipe(
    Effect.catch((error) =>
      windowsUnread(spec, outcome)(error).pipe(Effect.as<ReadonlyArray<Comment>>([])),
    ),
  );
  return comments;
});
