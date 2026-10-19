import { Effect, Schema } from "effect";
import type { RunSpec } from "../attempt/channel.ts";
import { CommitSha, RepositoryRevision } from "../repository.ts";
import { Commit, PullRequest, type StepResultFact } from "./result.ts";

/** The part of an Attempt's RunSpec that harvesting reads: where its checkout started and what it was given. */
export type HarvestSpec = Pick<RunSpec, "attemptId" | "repository" | "revision" | "baseCommit">;

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
  const output = yield* run("gh", [
    "api",
    `repos/${spec.repository}/commits/${head}/pulls?per_page=100`,
    "--paginate",
    "--slurp",
  ]);
  const pages = yield* decodePullRequestPages(output.join("\n")).pipe(
    Effect.mapError(
      (cause) =>
        new HarvestError({
          stage: "github",
          message: "GitHub returned invalid pull request results",
          cause,
        }),
    ),
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

/**
 * The facts an Attempt's checkout holds once its agent has finished: new
 * commits, then the pull requests at its final commit. A new final commit
 * that no remote branch or pull request ref points at was never pushed, so it
 * has no pull request and GitHub is not asked. Pull request discovery is
 * read-only enrichment, so a GitHub failure or a ten-second stall keeps the
 * commits and records no pull request rather than failing completed work.
 */
export const harvestFacts = Effect.fn("StepResult.harvest")(function* <
  E extends { readonly _tag: string; readonly message: string },
>(spec: HarvestSpec, run: HarvestCommand<E>) {
  yield* Effect.annotateCurrentSpan({ attemptId: spec.attemptId, repository: spec.repository });
  const commits = yield* harvestCommits(spec, run);
  const pullRequests = yield* harvestPullRequests(spec, run).pipe(
    Effect.timeout("10 seconds"),
    Effect.catch((error) =>
      Effect.logWarning(
        error._tag === "TimeoutError"
          ? "Pull request discovery timed out; retaining the completed agent result"
          : "Pull request discovery failed; retaining the completed agent result",
        {
          attemptId: spec.attemptId,
          repository: spec.repository,
          errorTag: error._tag,
          message: error.message,
        },
      ).pipe(Effect.as<ReadonlyArray<PullRequest>>([])),
    ),
  );
  const facts: ReadonlyArray<StepResultFact> = [...commits, ...pullRequests];
  return facts;
});
