import { type Brand, DateTime, Duration, Effect, Option, Result, Schema } from "effect";
import { githubSignature } from "../agent/agent.ts";
import { type AttemptWindow, AttemptWindows, windowHolds } from "../attempt/attempt.ts";
import type { RunSpec } from "../attempt/channel.ts";
import {
  BranchNotAtHead,
  type CiHandoff,
  describeUnverifiedHandoff,
  GitHubReadFailed,
  HeadMismatch,
  PullRequestNotFound,
  RepositoryMismatch,
  UnverifiedHandoff,
} from "../ci.ts";
import { ItemNumber } from "../item.ts";
import {
  canonicalRepositoryName,
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

const PullRequestResponse = Schema.Struct({
  number: PullRequest.fields.number,
  url: Schema.URLFromString,
  head: Schema.Struct({ sha: CommitSha }),
}).pipe(Schema.encodeKeys({ url: "html_url" }));
const decodePullRequestPages = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.Array(PullRequestResponse))),
);
const decodeBranchPullRequests = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({ number: PullRequest.fields.number, url: Schema.URLFromString }).pipe(
        Schema.encodeKeys({ url: "html_url" }),
      ),
    ),
  ),
);
const decodeHandoffPullRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      number: PullRequest.fields.number,
      url: Schema.URLFromString,
      head: Schema.Struct({
        sha: CommitSha,
        ref: Schema.NonEmptyString,
        repo: Schema.NullOr(Schema.Struct({ full_name: RepositoryName })),
      }),
    }).pipe(Schema.encodeKeys({ url: "html_url" })),
  ),
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
const DISCOVERY_BUDGET = "10 seconds";

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

/** Returns the checkout's final commit and its branch, which is empty if HEAD is detached. */
const checkoutHead = Effect.fn("StepResult.checkoutHead")(function* <E>(run: HarvestCommand<E>) {
  const head = yield* decodeCommit((yield* run("git", ["rev-parse", "HEAD"])).join("")).pipe(
    Effect.mapError((cause) =>
      HarvestError.make({ stage: "git", message: "Git returned an invalid final HEAD", cause }),
    ),
  );
  const branch = (yield* run("git", ["branch", "--show-current"])).join("");
  return { head, branch };
});

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

/** Returns the pull requests whose head is `head` in GitHub's commit-to-pull-request index. */
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
  const facts = new Map<number, PullRequest>();
  for (const pr of pages.flat()) {
    if (pr.head.sha === head) facts.set(pr.number, pullRequestAt(spec, pr.number, pr.url, head));
  }
  yield* Effect.logInfo("Collected Attempt pull request results", {
    attemptId: spec.attemptId,
    head,
    base: spec.baseCommit,
    pullRequests: [...facts.keys()],
  });
  return [...facts.values()];
});

/** Returns the pull requests whose head is the checkout's pushed final commit, from GitHub's index. */
const findPullRequests = Effect.fn("StepResult.findPullRequests")(function* <E>(
  spec: HarvestSpec,
  run: HarvestCommand<E>,
) {
  yield* Effect.annotateCurrentSpan({ attemptId: spec.attemptId, repository: spec.repository });
  const { head, branch } = yield* checkoutHead(run);
  // Checkouts start detached. There's no candidate if HEAD is unchanged, no branch was created,
  // and the revision isn't a fixed commit.
  if (
    head === spec.baseCommit &&
    spec.revision !== RepositoryRevision.make(spec.baseCommit) &&
    branch === ""
  ) {
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
  return yield* indexedPullRequests(spec, run, head);
});

const isHarvestError = Schema.is(HarvestError);

/**
 * Retries a failed `gh` read on the polling reads' schedule while `retryable` is true, and logs
 * each retry. Invalid output isn't retried.
 */
const retryRead = <E extends { readonly _tag: string; readonly message: string }>(
  spec: HarvestSpec,
  what: string,
  retryable = true,
) =>
  retryTransient<E | HarvestError>(
    (error) => retryable && !isHarvestError(error),
    ({ error, retry, delay }) =>
      Effect.logWarning(`Could not read ${what} on GitHub; retrying`, {
        attemptId: spec.attemptId,
        repository: spec.repository,
        errorTag: error._tag,
        message: error.message,
        retry,
        delayMs: Duration.toMillis(delay),
      }),
  );

/**
 * Reads the handoff's pull request and logs its branch's commit on origin against its head on
 * GitHub after each read. Retries a failed read while origin has the pull request's
 * `refs/pull/<n>/head`; without that ref, fails with `PullRequestNotFound`.
 */
const readHandoffPullRequest = <E extends { readonly _tag: string; readonly message: string }>(
  spec: HarvestSpec,
  run: HarvestCommand<E>,
  { pullRequest, head }: CiHandoff,
  refs: ReadonlyMap<string, CommitSha>,
) => {
  const onOrigin = refs.has(`refs/pull/${pullRequest}/head`);
  return askGitHub(
    run,
    ["api", `repos/${spec.repository}/pulls/${pullRequest}`],
    decodeHandoffPullRequest,
    "CI handoff pull request",
  ).pipe(
    Effect.tap((pr) =>
      Effect.logInfo("Read the CI handoff's pull request", {
        attemptId: spec.attemptId,
        pullRequest,
        branch: pr.head.ref,
        branchHead: Option.getOrNull(branchHeadOn(refs, pr.head.ref)),
        pullRequestHead: pr.head.sha,
      }),
    ),
    retryRead<E>(spec, `pull request #${pullRequest}`, onOrigin),
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
 * Returns the handoff's pull request if the checkout's HEAD is the handed-off head and is on the
 * pull request's branch on origin, even when GitHub's pull request head lags. Fails with the
 * reason otherwise.
 */
const verifyHandoff = Effect.fn("StepResult.verifyHandoff")(function* <
  E extends { readonly _tag: string; readonly message: string },
>(spec: HarvestSpec, run: HarvestCommand<E>, handoff: CiHandoff) {
  const { pullRequest } = handoff;
  yield* Effect.annotateCurrentSpan({
    attemptId: spec.attemptId,
    repository: spec.repository,
    pullRequest,
  });
  const { head } = yield* checkoutHead(run);
  if (handoff.head !== head) {
    return yield* Effect.fail(HeadMismatch.make({ pullRequest, handedOff: handoff.head, head }));
  }
  const refs = yield* originRefs(run);
  const pr = yield* readHandoffPullRequest(spec, run, handoff, refs);
  const headRepository = Option.fromNullOr(pr.head.repo).pipe(
    Option.map(({ full_name }) => full_name),
  );
  if (
    !Option.exists(
      headRepository,
      (repository) =>
        canonicalRepositoryName(repository) === canonicalRepositoryName(spec.repository),
    )
  ) {
    return yield* Effect.fail(RepositoryMismatch.make({ pullRequest, headRepository }));
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
 * Returns the open pull requests whose head is the checkout's branch, if that branch is at the
 * checkout's HEAD on origin. A detached checkout asks GitHub's commit-to-pull-request index
 * instead. Fails with the reason no pull request verifies.
 */
const verifyBranch = Effect.fn("StepResult.verifyBranch")(function* <
  E extends { readonly _tag: string; readonly message: string },
>(spec: HarvestSpec, run: HarvestCommand<E>) {
  yield* Effect.annotateCurrentSpan({ attemptId: spec.attemptId, repository: spec.repository });
  const { head, branch } = yield* checkoutHead(run);
  const refs = yield* originRefs(run);
  if (branch === "") {
    const indexed = [...refs.values()].includes(head)
      ? yield* indexedPullRequests(spec, run, head).pipe(
          retryRead<E>(spec, "the final commit's pull requests"),
        )
      : [];
    if (indexed.length === 0) {
      return yield* Effect.fail(
        PullRequestNotFound.make({ pullRequest: Option.none(), branch: Option.none(), head }),
      );
    }
    return indexed;
  }
  const branchHead = branchHeadOn(refs, branch);
  if (!Option.contains(branchHead, head)) {
    return yield* Effect.fail(
      BranchNotAtHead.make({ pullRequest: Option.none(), branch, branchHead, head }),
    );
  }
  const { owner } = splitRepositoryName(spec.repository);
  const open = yield* askGitHub(
    run,
    [
      "api",
      `repos/${spec.repository}/pulls?head=${owner}:${encodeURIComponent(branch)}&state=open&per_page=100`,
    ],
    decodeBranchPullRequests,
    "branch pull requests",
  ).pipe(retryRead<E>(spec, `the pull requests of branch ${branch}`));
  if (open.length === 0) {
    return yield* Effect.fail(
      PullRequestNotFound.make({ pullRequest: Option.none(), branch: Option.some(branch), head }),
    );
  }
  return open.map(({ number, url }) => pullRequestAt(spec, number, url, head));
});

/** The pull requests at the checkout's final commit, or why the one that CI waits on isn't verified. */
type PullRequestHarvest = Result.Result<ReadonlyArray<PullRequest>, UnverifiedHandoff>;

const isUnverifiedHandoff = Schema.is(UnverifiedHandoff);

/**
 * Runs `verification` within the discovery budget, turns a failed or timed-out read into
 * `GitHubReadFailed`, and logs the outcome.
 */
const verificationOutcome = <E extends { readonly _tag: string; readonly message: string }>(
  spec: HarvestSpec,
  verification: Effect.Effect<ReadonlyArray<PullRequest>, E | HarvestError | UnverifiedHandoff>,
): Effect.Effect<PullRequestHarvest> =>
  verification.pipe(
    Effect.timeout(DISCOVERY_BUDGET),
    Effect.mapError((error) =>
      isUnverifiedHandoff(error)
        ? error
        : GitHubReadFailed.make({
            message:
              error._tag === "TimeoutError"
                ? `the reads didn't finish within ${DISCOVERY_BUDGET}`
                : `${error._tag}: ${error.message}`,
          }),
    ),
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

/**
 * Returns the pull requests at the checkout's final commit, or why the one that CI waits on isn't
 * verified. With a CI handoff, verifies the pull request it names. If the Loop requires CI,
 * verifies the pull request of the checkout's branch. Otherwise asks GitHub's
 * commit-to-pull-request index, and a failure or timeout leaves no pull request.
 */
const harvestPullRequests = <E extends { readonly _tag: string; readonly message: string }>(
  spec: HarvestSpec,
  run: HarvestCommand<E>,
  handoff: Option.Option<CiHandoff>,
): Effect.Effect<PullRequestHarvest> =>
  Option.match(handoff, {
    onSome: (request) => verificationOutcome(spec, verifyHandoff(spec, run, request)),
    onNone: () =>
      spec.requiresCi
        ? verificationOutcome(spec, verifyBranch(spec, run))
        : enrichment(spec, "Pull request", findPullRequests(spec, run), []).pipe(
            Effect.map((pullRequests) => Result.succeed(pullRequests)),
          ),
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
  handoff: Option.Option<CiHandoff> = Option.none(),
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
