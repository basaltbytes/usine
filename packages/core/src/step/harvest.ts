import { DateTime, Effect, Option, Schema } from "effect";
import { githubSignature } from "../agent/agent.ts";
import { type AttemptWindow, windowHolds } from "../attempt/attempt.ts";
import type { RunSpec } from "../attempt/channel.ts";
import { ItemNumber } from "../item.ts";
import { CommitSha, RepositoryRevision } from "../repository.ts";
import { Comment, type CommentKind, Commit, PullRequest, type StepResultFact } from "./result.ts";

/**
 * The part of an Attempt's RunSpec that harvesting reads: where its checkout
 * started, what it was given, when the Worker prepared it, the bot login it
 * writes to GitHub as, and the Agent whose signature its comments end with.
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
>;

/**
 * Reads, from the orchestrator's records, the windows of the other Attempts
 * of the harvested Attempt's Agent that overlap its own on its Run's Item.
 * The harvest runs it once GitHub has listed the Attempt's comments, so it
 * reads every Attempt that could have posted one of them, including one that
 * started while the harvest ran.
 */
export type OverlappingWindows<W> = Effect.Effect<ReadonlyArray<AttemptWindow>, W>;

/**
 * Runs one read-only `git` or `gh` command in the Attempt's checkout and returns
 * its stdout lines. A non-zero exit is the runner's own failure.
 */
export type HarvestCommand<E> = (
  command: "git" | "gh",
  args: ReadonlyArray<string>,
) => Effect.Effect<ReadonlyArray<string>, E>;

/**
 * The harvest could not use what it read: git or GitHub answered a harvesting
 * command with output that is not a valid result (`git`, `github`), or the
 * windows of the Agent's other Attempts on the Item could not be read
 * (`windows`), so the Attempt's comments cannot be told from theirs.
 */
export class HarvestError extends Schema.TaggedError<HarvestError>("@usine/core/HarvestError")(
  "HarvestError",
  {
    stage: Schema.Literals(["git", "github", "windows"]),
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

/** A signed comment or review the Attempt's bot login posted, and the time GitHub records it was posted. */
interface Posted {
  readonly fact: Comment;
  readonly at: DateTime.Utc;
}

/**
 * What GitHub lists on a Run's Item for the Attempt's bot login, before the
 * windows of the Agent's other Attempts are read: `signed`, the comments and
 * reviews the login posted since the Worker prepared the checkout and ended
 * with the Agent's signature; `unsigned`, how many it posted then without that
 * signature; and `edited`, how many comments it posted before then and edited
 * since.
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
 * Lists what the Attempt posted on its Run's Item: the Item's conversation
 * comments and, on a pull request, its submitted reviews and their diff
 * comments, written by the RunSpec's bot login, or else by the login GitHub
 * reports for the Attempt's credential, posted since the Worker prepared the
 * checkout, and ending with the Attempt's Agent's signature. A comment is
 * posted when it is created, even when it is edited later, and a review when
 * it is submitted. None for a Run without an Item or a preparation time.
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
  // A pending review and its comments are a draft only their author sees.
  const pending = new Set(
    reviews.flat().flatMap(({ id, state }) => (state === "PENDING" ? [id] : [])),
  );
  // What GitHub lists that the login wrote, each with its body and the time
  // it was posted: a comment's creation, even when edited later, or a
  // review's submission. GitHub lists every review, so only those submitted
  // since preparation are kept.
  const written = [
    ...conversation.flat().flatMap(({ url, user, body, createdAt }) =>
      byLogin(user)
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
      byLogin(user) &&
      sincePrepared(submittedAt)
        ? [
            {
              body,
              at: submittedAt,
              fact: new Comment({ url, kind: "review", at: Option.some(submittedAt) }),
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
              fact: new Comment({ url, kind: "review-comment", at: Option.some(createdAt) }),
            },
          ]
        : [],
    ),
  ];
  // `since` lists the comments updated since preparation, so it also lists
  // one the login posted before then and edited since. Only what the login
  // posted inside the Attempt's own window can be the Attempt's (#429): that
  // comment was posted before the window opened, and the edit could be any
  // Attempt's, so no Attempt records it.
  const posted = written.filter(({ at }) => sincePrepared(at));
  // All Attempts that write as one bot login share it, such as two Loops' Runs
  // on one pull request, so the login alone does not tell their comments apart.
  // The Attempt prompt asks the Agent to end each comment and review with its
  // signature, and only those that do are the Attempt's (ADR 0006, #394).
  // A body often ends with a newline, so trailing whitespace is ignored.
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

/**
 * The comments and reviews in `listing` that are the Attempt's: those whose
 * time none of the windows `overlapping` reads holds. Two Attempts of one
 * Agent open on one Item at once sign alike, so a comment posted while another
 * of them was open could be either's and is neither's (#429), the rule the Run
 * reader applies to the App's changes. The windows are read only once GitHub
 * has listed the comments, and not at all when none is signed. A read that
 * fails is a `HarvestError` at the `windows` stage.
 */
const attributeComments = Effect.fn("StepResult.attributeComments")(function* <W>(
  spec: HarvestSpec,
  listing: Listing,
  overlapping: OverlappingWindows<W>,
) {
  yield* Effect.annotateCurrentSpan({
    attemptId: spec.attemptId,
    repository: spec.repository,
    item: listing.item,
  });
  // An Attempt that posted a listed comment had started before GitHub listed
  // it, so a read made now has its window, even when it started while this
  // harvest ran. A read made before the listing could miss it.
  const windows: ReadonlyArray<AttemptWindow> =
    listing.signed.length === 0
      ? []
      : yield* overlapping.pipe(
          Effect.mapError(
            (cause) =>
              new HarvestError({
                stage: "windows",
                message: "Could not read the windows of the Agent's other Attempts on the Item",
                cause,
              }),
          ),
        );
  const placed = listing.signed.map(({ at, fact }) => ({
    fact,
    others: windows.filter((window) => windowHolds(window, at)),
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
    item: listing.item,
    author: listing.author.login,
    authorSource: listing.author.source,
    agent: spec.agent.name,
    since: listing.since,
    issueComments: counted("issue-comment"),
    reviews: counted("review"),
    reviewComments: counted("review-comment"),
    // Written by the login since preparation without the Agent's signature:
    // another Agent's, or one this Agent left unsigned.
    unsigned: listing.unsigned,
    // Posted by the login before preparation and edited since: not posted by this Attempt.
    edited: listing.edited,
    // Signed, but posted while another Attempt of the Agent was open on the Item.
    ambiguous: listing.signed.length - posted.length,
    // The windows read, none when no listed comment was signed.
    overlapping: windows.map(({ attemptId }) => attemptId),
  });
  return posted;
});

/**
 * GitHub discovery is read-only enrichment of a finished Attempt: a failure or
 * a ten-second stall records nothing it looked for and keeps the other facts.
 * `nothing` is what the discovery then gives, and `retaining` says what the
 * Attempt keeps, for the warning.
 */
const enrichment = <A, E extends { readonly _tag: string; readonly message: string }>(
  spec: HarvestSpec,
  subject: "Pull request" | "Comment",
  discovery: Effect.Effect<A, E>,
  nothing: A,
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
      ).pipe(Effect.as(nothing)),
    ),
  );

/**
 * The comments and reviews the Attempt posted on its Run's Item
 * (`listComments`) that no other Attempt of its Agent open on the Item could
 * have posted (`attributeComments`). Listing them is GitHub discovery
 * (`enrichment`), and the `HarvestError` this fails with is a failure to read
 * the windows. `retaining` says what the Attempt keeps when the discovery fails.
 */
const harvestComments = <E extends { readonly _tag: string; readonly message: string }, W>(
  spec: HarvestSpec,
  run: HarvestCommand<E>,
  overlapping: OverlappingWindows<W>,
  retaining?: string,
) =>
  enrichment(spec, "Comment", listComments(spec, run), Option.none<Listing>(), retaining).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed<ReadonlyArray<Comment>>([]),
        onSome: (listing) => attributeComments(spec, listing, overlapping),
      }),
    ),
  );

/** Warns that the windows of the Agent's other Attempts could not be read, and what the harvest does without them. */
const windowsUnread = (spec: HarvestSpec, outcome: string) => (error: HarvestError) =>
  Effect.logWarning(
    `Could not read the windows of the Agent's other Attempts on the Item, so the Attempt's comments cannot be told from theirs; ${outcome}`,
    {
      attemptId: spec.attemptId,
      repository: spec.repository,
      cause: String(error.cause),
    },
  );

/**
 * The facts an Attempt's checkout holds once its agent has finished: new
 * commits, then the pull requests at its final commit, then the comments and
 * reviews the Attempt posted on its Run's Item. A new final commit that no
 * remote branch or pull request ref points at was never pushed, so it has no
 * pull request and GitHub is not asked. Comments are those GitHub lists for
 * the bot login the Attempt writes as, the factory's App or a Worker's GitHub
 * integration, posted since the Worker prepared the checkout, that end with
 * the signature of the Attempt's Agent (`githubSignature`), leaving out those
 * posted in a window `overlapping` reads, which could be another Attempt's of
 * that Agent. Both GitHub discoveries are read-only enrichment, so a GitHub
 * failure or a ten-second stall keeps the commits and records none of what it
 * looked for rather than failing completed work. Windows that cannot be read
 * fail the harvest, as an invalid git result does, since its comments cannot
 * be told from the other Attempts'.
 */
export const harvestFacts = Effect.fn("StepResult.harvest")(function* <
  E extends { readonly _tag: string; readonly message: string },
  W,
>(spec: HarvestSpec, run: HarvestCommand<E>, overlapping: OverlappingWindows<W>) {
  yield* Effect.annotateCurrentSpan({ attemptId: spec.attemptId, repository: spec.repository });
  const commits = yield* harvestCommits(spec, run);
  const pullRequests = yield* enrichment(spec, "Pull request", harvestPullRequests(spec, run), []);
  const comments = yield* harvestComments(spec, run, overlapping).pipe(
    Effect.tapError(windowsUnread(spec, "the harvest fails")),
  );
  const facts: ReadonlyArray<StepResultFact> = [...commits, ...pullRequests, ...comments];
  return facts;
});

/**
 * The comments and reviews an Attempt that ended without success posted on its
 * Run's Item, found as `harvestFacts` finds them. Its commits and pull requests
 * are not collected, since the Attempt delivered no result. A GitHub failure, a
 * ten-second stall, or windows `overlapping` cannot read records none and
 * never fails.
 */
export const harvestPostedComments = Effect.fn("StepResult.harvestPostedComments")(function* <
  E extends { readonly _tag: string; readonly message: string },
  W,
>(spec: HarvestSpec, run: HarvestCommand<E>, overlapping: OverlappingWindows<W>) {
  yield* Effect.annotateCurrentSpan({ attemptId: spec.attemptId, repository: spec.repository });
  const outcome = "the Attempt that ended without success records no comment";
  const comments: ReadonlyArray<Comment> = yield* harvestComments(
    spec,
    run,
    overlapping,
    outcome,
  ).pipe(
    Effect.catch((error) =>
      windowsUnread(spec, outcome)(error).pipe(Effect.as<ReadonlyArray<Comment>>([])),
    ),
  );
  return comments;
});
