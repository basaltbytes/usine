import { DateTime, Effect, Option, Schema } from "effect";
import { githubSignature } from "../agent/agent.ts";
import { type AttemptWindow, windowHolds } from "../attempt/attempt.ts";
import type { RunSpec } from "../attempt/channel.ts";
import { ItemNumber } from "../item.ts";
import { CommitSha, RepositoryRevision } from "../repository.ts";
import { Comment, type CommentKind, Commit, PullRequest, type StepResultFact } from "./result.ts";

/**
 * What harvesting reads: from the Attempt's RunSpec, where its checkout
 * started, what it was given, when the Worker prepared it, the bot login it
 * writes to GitHub as, and the Agent whose signature its comments end with;
 * and, as `overlapping`, the windows of the other Attempts of that Agent that
 * overlap its own on its Run's Item, read from the orchestrator's records when
 * the harvest runs, so they include Attempts that started after it.
 */
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
> & { readonly overlapping: ReadonlyArray<AttemptWindow> };

/**
 * Runs one read-only `git` or `gh` command in the Attempt's checkout and returns
 * its stdout lines. A non-zero exit is the runner's own failure.
 */
export type HarvestCommand<E> = (
  command: "git" | "gh",
  args: ReadonlyArray<string>,
) => Effect.Effect<ReadonlyArray<string>, E>;

/** git or GitHub answered a harvesting command with output that is not a valid result. */
export class HarvestError extends Schema.TaggedError<HarvestError>("@usine/core/HarvestError")(
  "HarvestError",
  {
    stage: Schema.Literals(["git", "github"]),
    message: Schema.NonEmptyString,
    cause: Schema.Defect(),
  },
) {}

const PullRequestResponse = Schema.Struct({
  number: PullRequest.fields.number,
  url: Schema.URLFromString,
  head: Schema.Struct({ sha: CommitSha }),
}).pipe(Schema.encodeKeys({ url: "html_url" }));
const decodePullRequestPages = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.Array(PullRequestResponse))),
);
const decodeCommit = Schema.decodeUnknownEffect(CommitSha);

/**
 * The issue or pull request a Run's payload describes, by the `number` and
 * `url` of GitHub's issue and pull request payload slices. A schedule Run's
 * payload has neither.
 */
const decodePayloadItem = Schema.decodeUnknownOption(
  Schema.Struct({ number: ItemNumber, url: Schema.URLFromString }),
);

/**
 * Asks GitHub for the login of the credential the command runs with. GitHub
 * does not document what it returns for an installation token, so harvesting
 * asks only when the RunSpec names no bot login.
 */
const VIEWER_QUERY = "query=query { viewer { login } }";
const decodeViewer = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({ viewer: Schema.Struct({ login: Schema.NonEmptyString }) }),
    }),
  ),
);

const Author = Schema.NullOr(Schema.Struct({ login: Schema.String }));
// GitHub's schema makes an issue comment's body optional and a review's or a
// review comment's body required; a review submitted without text has "".
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

/** Runs one `gh` command and decodes its output as `what`. */
const askGitHub = <A, E, D>(
  run: HarvestCommand<E>,
  args: ReadonlyArray<string>,
  decode: (output: string) => Effect.Effect<A, D>,
  what: string,
) =>
  run("gh", args).pipe(
    Effect.flatMap((lines) =>
      decode(lines.join("\n")).pipe(
        Effect.mapError(
          (cause) =>
            new HarvestError({
              stage: "github",
              message: `GitHub returned invalid ${what}`,
              cause,
            }),
        ),
      ),
    ),
  );

/** The commits between the checkout's base and its final HEAD, oldest first. */
const harvestCommits = Effect.fn("StepResult.harvestCommits")(function* <E>(
  spec: HarvestSpec,
  run: HarvestCommand<E>,
) {
  yield* Effect.annotateCurrentSpan({ attemptId: spec.attemptId, repository: spec.repository });
  // A commit id never contains a space, so the first one ends it.
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
        Effect.mapError(
          (cause) =>
            new HarvestError({ stage: "git", message: "git returned an invalid commit id", cause }),
        ),
      );
      const summary = separator < 0 ? "" : line.slice(separator + 1).trim();
      if (summary.length === 0) {
        return yield* new HarvestError({
          stage: "git",
          message: `Commit ${sha} has no summary`,
          cause: new Error("empty commit summary"),
        });
      }
      return new Commit({ sha, summary });
    }),
  );
});

/** The pull requests whose head is the checkout's final commit, each once. */
const harvestPullRequests = Effect.fn("StepResult.harvestPullRequests")(function* <E>(
  spec: HarvestSpec,
  run: HarvestCommand<E>,
) {
  yield* Effect.annotateCurrentSpan({ attemptId: spec.attemptId, repository: spec.repository });
  const head = yield* decodeCommit((yield* run("git", ["rev-parse", "HEAD"])).join("")).pipe(
    Effect.mapError(
      (cause) =>
        new HarvestError({ stage: "git", message: "git returned an invalid final HEAD", cause }),
    ),
  );
  const branch = (yield* run("git", ["branch", "--show-current"])).join("");
  // Executors start detached. An unchanged default-branch Attempt has no
  // PR candidate; a fixed revision, changed HEAD, or agent-created branch does.
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
  // A pull request's head is the tip of its branch and of refs/pull/<n>/head;
  // GitHub answers HTTP 422 for a commit that was never pushed.
  if (head !== spec.baseCommit) {
    const refs = yield* run("git", ["ls-remote", "origin", "refs/heads/*", "refs/pull/*/head"]);
    if (!refs.some((ref) => ref.startsWith(`${head}\t`))) {
      yield* Effect.logDebug("No remote branch or pull request has the Attempt's final commit", {
        attemptId: spec.attemptId,
        head,
      });
      return [];
    }
  }
  const pages = yield* askGitHub(
    run,
    ["api", `repos/${spec.repository}/commits/${head}/pulls?per_page=100`, "--paginate", "--slurp"],
    decodePullRequestPages,
    "pull request results",
  );
  // Associated PRs can contain this commit as an ancestor. Record only
  // PRs whose head is the checkout's final commit, once across all pages.
  const facts = new Map<number, PullRequest>();
  for (const pr of pages.flat()) {
    if (pr.head.sha === head)
      facts.set(pr.number, new PullRequest({ number: pr.number, url: pr.url }));
  }
  yield* Effect.logInfo("Collected Attempt pull request results", {
    attemptId: spec.attemptId,
    head,
    pullRequests: [...facts.keys()],
  });
  return [...facts.values()];
});

/** The login whose comments harvesting keeps, and where it came from. */
interface Author {
  readonly login: string;
  readonly source: "run-spec" | "viewer";
}

/** The login GitHub reports for the Attempt's credential, for a RunSpec that names no bot login. */
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

/**
 * The comments and reviews the Attempt posted on its Run's Item: the Item's
 * conversation comments and, on a pull request, its submitted reviews and
 * their diff comments, written by the RunSpec's bot login, or else by the
 * login GitHub reports for the Attempt's credential, created or updated since
 * the Worker prepared the checkout, ending with the Attempt's Agent's
 * signature, and posted inside none of the `overlapping` windows.
 */
const harvestComments = Effect.fn("StepResult.harvestComments")(function* <E>(
  spec: HarvestSpec,
  run: HarvestCommand<E>,
) {
  yield* Effect.annotateCurrentSpan({ attemptId: spec.attemptId, repository: spec.repository });
  const item = decodePayloadItem(spec.payload);
  if (Option.isNone(item)) {
    yield* Effect.logDebug("The Run has no GitHub Item, so no comment is collected", {
      attemptId: spec.attemptId,
    });
    return [];
  }
  const { number, url } = item.value;
  if (Option.isNone(spec.preparedAt)) {
    yield* Effect.logInfo(
      "The Attempt was prepared before preparation times were recorded, so no comment is collected",
      { attemptId: spec.attemptId, repository: spec.repository, item: number },
    );
    return [];
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
  const written = (user: typeof Author.Type, at: DateTime.Utc) =>
    user !== null && user.login === login && DateTime.toEpochMillis(at) >= since;
  // A pending review and its comments are a draft only their author sees.
  const pending = new Set(
    reviews.flat().flatMap(({ id, state }) => (state === "PENDING" ? [id] : [])),
  );
  // What the login wrote since preparation, each with its body and the time
  // it was posted: a comment's creation, even when edited later, or a
  // review's submission.
  const candidates = [
    ...conversation.flat().flatMap(({ url, user, body, createdAt, updatedAt }) =>
      written(user, updatedAt)
        ? [
            {
              body,
              at: createdAt,
              fact: new Comment({ url, kind: "issue-comment", at: Option.some(createdAt) }),
            },
          ]
        : [],
    ),
    ...reviews.flat().flatMap(({ url, user, body, state, submittedAt }) =>
      state !== "PENDING" &&
      submittedAt !== undefined &&
      submittedAt !== null &&
      written(user, submittedAt)
        ? [
            {
              body,
              at: submittedAt,
              fact: new Comment({ url, kind: "review", at: Option.some(submittedAt) }),
            },
          ]
        : [],
    ),
    ...diffComments.flat().flatMap(({ url, user, body, createdAt, updatedAt, reviewId }) =>
      (reviewId === null || !pending.has(reviewId)) && written(user, updatedAt)
        ? [
            {
              body,
              at: createdAt,
              fact: new Comment({ url, kind: "review-comment", at: Option.some(createdAt) }),
            },
          ]
        : [],
    ),
  ];
  // All Attempts that write as one bot login share it, such as two Loops' Runs
  // on one pull request, so the login alone does not tell their comments apart.
  // The Attempt prompt asks the Agent to end each comment and review with its
  // signature, and only those that do are the Attempt's (ADR 0006, #394).
  // A body often ends with a newline, so trailing whitespace is ignored.
  const signature = githubSignature(spec.agent.name);
  const signed = candidates.filter(
    ({ body }) => body !== undefined && body.trimEnd().endsWith(signature),
  );
  // Two Attempts of one Agent open on one Item at once sign alike, so a
  // comment posted while another of them was open could be either's and is
  // neither's (#429), the rule the Run reader applies to the App's changes.
  const placed = signed.map(({ at, fact }) => ({
    fact,
    others: spec.overlapping.filter((window) => windowHolds(window, at)),
  }));
  const posted = placed.flatMap(({ fact, others }) => (others.length === 0 ? [fact] : []));
  yield* Effect.forEach(
    placed.filter(({ others }) => others.length > 0),
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
    item: number,
    author: login,
    authorSource: author.source,
    agent: spec.agent.name,
    since: sinceParameter,
    issueComments: counted("issue-comment"),
    reviews: counted("review"),
    reviewComments: counted("review-comment"),
    // Written by the login since preparation without the Agent's signature:
    // another Agent's, or one this Agent left unsigned.
    unsigned: candidates.length - signed.length,
    // Signed, but posted while another Attempt of the Agent was open on the Item.
    ambiguous: signed.length - posted.length,
    overlapping: spec.overlapping.map(({ attemptId }) => attemptId),
  });
  return posted;
});

/**
 * GitHub discovery is read-only enrichment of a finished Attempt: a failure or
 * a ten-second stall records nothing it looked for and keeps the other facts.
 * `retaining` says what the Attempt keeps, for the warning.
 */
const enrichment = <A, E extends { readonly _tag: string; readonly message: string }>(
  spec: HarvestSpec,
  subject: "Pull request" | "Comment",
  discovery: Effect.Effect<ReadonlyArray<A>, E>,
  retaining = "retaining the completed agent result",
) =>
  discovery.pipe(
    Effect.timeout("10 seconds"),
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
      ).pipe(Effect.as<ReadonlyArray<A>>([])),
    ),
  );

/**
 * The facts an Attempt's checkout holds once its agent has finished: new
 * commits, then the pull requests at its final commit, then the comments and
 * reviews the Attempt posted on its Run's Item. A new final commit that no
 * remote branch or pull request ref points at was never pushed, so it has no
 * pull request and GitHub is not asked. Comments are those GitHub lists for
 * the bot login the Attempt writes as, the factory's App or a Worker's GitHub
 * integration, since the Worker prepared the checkout, that end with the
 * signature of the Attempt's Agent (`githubSignature`), leaving out those
 * posted while another Attempt of that Agent was open on the Item
 * (`spec.overlapping`), which could be either's. Both GitHub discoveries
 * are read-only enrichment, so a GitHub failure or a ten-second stall keeps
 * the commits and records none of what it looked for rather than failing
 * completed work.
 */
export const harvestFacts = Effect.fn("StepResult.harvest")(function* <
  E extends { readonly _tag: string; readonly message: string },
>(spec: HarvestSpec, run: HarvestCommand<E>) {
  yield* Effect.annotateCurrentSpan({ attemptId: spec.attemptId, repository: spec.repository });
  const commits = yield* harvestCommits(spec, run);
  const pullRequests = yield* enrichment(spec, "Pull request", harvestPullRequests(spec, run));
  const comments = yield* enrichment(spec, "Comment", harvestComments(spec, run));
  const facts: ReadonlyArray<StepResultFact> = [...commits, ...pullRequests, ...comments];
  return facts;
});

/**
 * The comments and reviews an Attempt that ended without success posted on its
 * Run's Item, found as `harvestFacts` finds them. Its commits and pull requests
 * are not collected, since the Attempt delivered no result. A GitHub failure or
 * a ten-second stall records none and never fails.
 */
export const harvestPostedComments = Effect.fn("StepResult.harvestPostedComments")(function* <
  E extends { readonly _tag: string; readonly message: string },
>(spec: HarvestSpec, run: HarvestCommand<E>) {
  yield* Effect.annotateCurrentSpan({ attemptId: spec.attemptId, repository: spec.repository });
  const comments: ReadonlyArray<Comment> = yield* enrichment(
    spec,
    "Comment",
    harvestComments(spec, run),
    "the Attempt that ended without success records no comment",
  );
  return comments;
});
