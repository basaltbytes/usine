import { Schema } from "effect";
import { CommitSha } from "../repository.ts";

/** A commit the executor found between the workspace base and final HEAD. */
export class Commit extends Schema.TaggedClass<Commit>("StepResult/Commit")("Commit", {
  sha: CommitSha,
  summary: Schema.NonEmptyString,
}) {}

/** A pull request the agent created or updated during the Attempt. */
export class PullRequest extends Schema.TaggedClass<PullRequest>("StepResult/PullRequest")(
  "PullRequest",
  {
    number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    url: Schema.URLFromString,
  },
) {}

/**
 * Where a comment sits on GitHub: `issue-comment` in the conversation of an
 * issue or pull request, `review` a submitted pull request review, and
 * `review-comment` on a line of a pull request's diff, a reply in a review
 * thread included.
 */
export const CommentKind = Schema.Literals(["issue-comment", "review", "review-comment"]);
export type CommentKind = typeof CommentKind.Type;

/**
 * A GitHub comment or review the agent created or updated on the Run's Item during the Attempt.
 * `at` is when GitHub says it was posted: a comment's creation, a review's submission. None for a
 * comment harvested before these times were recorded.
 */
export class Comment extends Schema.TaggedClass<Comment>("StepResult/Comment")("Comment", {
  url: Schema.URLFromString,
  kind: CommentKind,
  at: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString),
}) {}

/** A commit or GitHub artifact recorded as an outcome of the Agent's work. */
export const StepResultFact = Schema.Union([Commit, PullRequest, Comment]);
export type StepResultFact = typeof StepResultFact.Type;

/** The agent's final message plus the facts that survive workspace cleanup. */
export class StepResult extends Schema.Class<StepResult>("StepResult")({
  message: Schema.NonEmptyString,
  facts: Schema.Array(StepResultFact),
}) {}
