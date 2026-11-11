import { type Brand, Match, Option, Result, Schema } from "effect";
import { AgentFailure, InfraFailure } from "./attempt/failure.ts";
import { ItemNumber } from "./item.ts";
import { LoopName } from "./loop.ts";
import { RunId } from "./run/id.ts";
import { CommitSha, RepositoryName } from "./repository.ts";

/** The final-answer marker that transfers CI waiting to the orchestrator. */
export const AWAITING_CI_MARKER = "[usine:awaiting-ci]";

const Labels = Schema.Array(Schema.NonEmptyString).check(Schema.isUnique());

/** Labels to change on one item in the run's repository after CI passes. */
export class CiLabelMutation extends Schema.Class<
  CiLabelMutation,
  Brand.Brand<"@usine/core/ci/CiLabelMutation">
>("CiLabelMutation")({
  item: ItemNumber,
  add: Labels,
  remove: Labels,
}) {}

/** The CI requirement configured on a loop and saved when its event matches. */
export class CiPolicy extends Schema.Class<CiPolicy, Brand.Brand<"@usine/core/ci/CiPolicy">>(
  "CiPolicy",
)({
  fixLoop: LoopName,
  timeoutSeconds: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(86400)),
}) {}

/** The pushed head, fix loop, deadline, and completion actions recorded by an agent. */
export class CiHandoff extends Schema.Class<CiHandoff, Brand.Brand<"@usine/core/ci/CiHandoff">>(
  "CiHandoff",
)({
  pullRequest: ItemNumber,
  head: CommitSha,
  ...CiPolicy.fields,
  onGreen: Schema.Array(CiLabelMutation),
}) {}

const HandoffFromJson = Schema.fromJsonString(
  CiHandoff.pipe(
    Schema.encodeKeys({
      pullRequest: "pull_request",
      fixLoop: "fix_loop",
      timeoutSeconds: "timeout_seconds",
      onGreen: "on_green",
    }),
  ),
);

/** Decodes a handoff following the marker, or returns `None` for an ordinary final answer. */
export const ciHandoff = (
  message: string,
): Result.Result<Option.Option<CiHandoff>, AgentFailure> => {
  const answer = message.trim();
  if (!answer.startsWith(AWAITING_CI_MARKER)) return Result.succeed(Option.none());
  return Schema.decodeResult(HandoffFromJson)(answer.slice(AWAITING_CI_MARKER.length).trim(), {
    onExcessProperty: "error",
  }).pipe(
    Result.map(Option.some),
    Result.mapError((error) =>
      AgentFailure.make({ message: `Invalid CI handoff: ${error.message}` }),
    ),
  );
};

/** CI passed for the recorded head. */
export class CiPassed extends Schema.TaggedClass<
  CiPassed,
  Brand.Brand<"@usine/core/ci/CiPassed">
>()("CiPassed", {}) {}

/** CI failed without an admitted fix. */
export class CiFailed extends Schema.TaggedClass<
  CiFailed,
  Brand.Brand<"@usine/core/ci/CiFailed">
>()("CiFailed", {
  message: Schema.NonEmptyString,
}) {}

/** CI remained pending past its deadline because infrastructure did not finish. */
export class CiTimedOut extends Schema.TaggedClass<
  CiTimedOut,
  Brand.Brand<"@usine/core/ci/CiTimedOut">
>()("CiTimedOut", {
  message: Schema.NonEmptyString,
}) {}

/**
 * A workflow run on the recorded head failed or was canceled although none of its jobs failed,
 * so CI never ran in full. The operator reruns the named workflow runs.
 */
export class CiIncomplete extends Schema.TaggedClass<
  CiIncomplete,
  Brand.Brand<"@usine/core/ci/CiIncomplete">
>()("CiIncomplete", {
  message: Schema.NonEmptyString,
}) {}

/** Failed CI accepted by a fix run. */
export class CiHandedOff extends Schema.TaggedClass<
  CiHandedOff,
  Brand.Brand<"@usine/core/ci/CiHandedOff">
>()("CiHandedOff", {
  reason: Schema.NonEmptyString,
  fixRunId: RunId,
}) {}

/** A different head replaced the recorded push. */
export class CiSuperseded extends Schema.TaggedClass<
  CiSuperseded,
  Brand.Brand<"@usine/core/ci/CiSuperseded">
>()("CiSuperseded", {
  head: CommitSha,
}) {}

/** A terminal observation of the recorded head's CI. */
export const CiResolution = Schema.Union([
  CiPassed,
  CiFailed,
  CiTimedOut,
  CiIncomplete,
  CiHandedOff,
  CiSuperseded,
]);
export type CiResolution = typeof CiResolution.Type;

/** The checkout's HEAD isn't the head that the CI handoff names. */
export class HeadMismatch extends Schema.TaggedClass<
  HeadMismatch,
  Brand.Brand<"@usine/core/ci/HeadMismatch">
>()("HeadMismatch", {
  pullRequest: ItemNumber,
  /** The head that the handoff names. */
  handedOff: CommitSha,
  head: CommitSha,
}) {}

/** Origin has no pull request that the handoff names or that the checkout's branch heads. */
export class PullRequestNotFound extends Schema.TaggedClass<
  PullRequestNotFound,
  Brand.Brand<"@usine/core/ci/PullRequestNotFound">
>()("PullRequestNotFound", {
  /** The pull request that the handoff names, or `None` for a success without a handoff. */
  pullRequest: Schema.OptionFromOptionalKey(ItemNumber),
  /** The checkout's branch, or `None` for a handoff or a detached checkout. */
  branch: Schema.OptionFromOptionalKey(Schema.NonEmptyString),
  head: CommitSha,
}) {}

/** The handoff's pull request comes from a repository other than the Run's. */
export class RepositoryMismatch extends Schema.TaggedClass<
  RepositoryMismatch,
  Brand.Brand<"@usine/core/ci/RepositoryMismatch">
>()("RepositoryMismatch", {
  pullRequest: ItemNumber,
  /** The pull request's head repository, or `None` if it was deleted. */
  headRepository: Schema.OptionFromOptionalKey(RepositoryName),
}) {}

/** The pull request's branch on origin doesn't point at the checkout's HEAD. */
export class BranchNotAtHead extends Schema.TaggedClass<
  BranchNotAtHead,
  Brand.Brand<"@usine/core/ci/BranchNotAtHead">
>()("BranchNotAtHead", {
  /** The pull request that the handoff names, or `None` for a success without a handoff. */
  pullRequest: Schema.OptionFromOptionalKey(ItemNumber),
  branch: Schema.NonEmptyString,
  /** The branch's commit on origin, or `None` if origin has no such branch. */
  branchHead: Schema.OptionFromOptionalKey(CommitSha),
  head: CommitSha,
}) {}

/** A GitHub API read failed after retries, a git read failed, or verification timed out. */
export class GitHubReadFailed extends Schema.TaggedClass<
  GitHubReadFailed,
  Brand.Brand<"@usine/core/ci/GitHubReadFailed">
>()("GitHubReadFailed", {
  message: Schema.NonEmptyString,
}) {}

/** The reason harvesting couldn't verify the pull request that CI waits on. */
export const UnverifiedHandoff = Schema.Union([
  HeadMismatch,
  PullRequestNotFound,
  RepositoryMismatch,
  BranchNotAtHead,
  GitHubReadFailed,
]);
export type UnverifiedHandoff = typeof UnverifiedHandoff.Type;

const ofPullRequest = (pullRequest: Option.Option<ItemNumber>) =>
  Option.match(pullRequest, {
    onNone: () => "",
    onSome: (number) => ` of pull request #${number}`,
  });

/** Returns an operator-facing sentence fragment that explains `reason`. */
export const describeUnverifiedHandoff = (reason: UnverifiedHandoff): string =>
  Match.valueTags(reason, {
    HeadMismatch: ({ pullRequest, handedOff, head }) =>
      `the handoff names head ${handedOff} for pull request #${pullRequest}, but the checkout's HEAD is ${head}`,
    PullRequestNotFound: ({ pullRequest, branch, head }) =>
      Option.isSome(pullRequest)
        ? `origin has no pull request #${pullRequest.value}`
        : Option.isSome(branch)
          ? `no open pull request has branch ${branch.value} as its head`
          : `no open pull request has the checkout's HEAD ${head} as its head`,
    RepositoryMismatch: ({ pullRequest, headRepository }) =>
      `pull request #${pullRequest} comes from ${Option.getOrElse(headRepository, () => "a deleted repository")}, not from the Run's repository`,
    BranchNotAtHead: ({ pullRequest, branch, branchHead, head }) =>
      Option.match(branchHead, {
        onNone: () => `branch ${branch}${ofPullRequest(pullRequest)} isn't on origin`,
        onSome: (commit) =>
          `branch ${branch}${ofPullRequest(pullRequest)} is at ${commit} on origin, not at the checkout's HEAD ${head}`,
      }),
    GitHubReadFailed: ({ message }) => `GitHub couldn't be read: ${message}`,
  });

/**
 * Returns the Attempt failure for `reason`. A GitHub read failure is a retryable `InfraFailure`.
 * The other reasons are agent mistakes that a new Attempt would repeat, so they're `AgentFailure`s.
 */
export const unverifiedHandoffFailure = (
  reason: UnverifiedHandoff,
): AgentFailure | InfraFailure => {
  const message = `CI can't wait on the pushed pull request: ${describeUnverifiedHandoff(reason)}`;
  return reason._tag === "GitHubReadFailed"
    ? InfraFailure.make({ message, cause: reason })
    : AgentFailure.make({ message });
};
