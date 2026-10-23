import { Schema } from "effect";
import { CommitSha } from "../repository.ts";

/** A commit between the workspace base and the final HEAD. */
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
 * - `issue-comment`: in an issue or pull request conversation.
 * - `review`: a submitted pull request review.
 * - `review-comment`: on a line of a pull request diff, including replies in a review thread.
 */
export const CommentKind = Schema.Literals(["issue-comment", "review", "review-comment"]);
export type CommentKind = typeof CommentKind.Type;

/**
 * A GitHub comment or review that the agent created or updated on the Run's Item. `at` is the
 * creation time of a comment or submission time of a review, or `None` for older records.
 */
export class Comment extends Schema.TaggedClass<Comment>("StepResult/Comment")("Comment", {
  url: Schema.URLFromString,
  kind: CommentKind,
  at: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString),
}) {}

export const StepResultFact = Schema.Union([Commit, PullRequest, Comment]);
export type StepResultFact = typeof StepResultFact.Type;

/** The agent's final message and the facts kept after workspace cleanup. */
export class StepResult extends Schema.Class<StepResult>("StepResult")({
  message: Schema.NonEmptyString,
  facts: Schema.Array(StepResultFact),
}) {}
