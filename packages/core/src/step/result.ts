import { Schema } from "effect";
import { CommitSha } from "../repository.ts";

/** A commit between the workspace base and the final HEAD. */
export class Commit extends Schema.TaggedClass<Commit>("StepResult/Commit")("Commit", {
  /** The full commit ID found between the checkout base and final HEAD. */
  sha: CommitSha,
  /** The commit subject recorded by Git. */
  summary: Schema.NonEmptyString,
}) {}

/** A pull request the agent created or updated during the Attempt. */
export class PullRequest extends Schema.TaggedClass<PullRequest>("StepResult/PullRequest")(
  "PullRequest",
  {
    /** The pull request number within the attempt's repository. */
    number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    /** The GitHub pull request URL, encoded as a string for storage. */
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
  /** The GitHub URL of the comment or submitted review, encoded as a string for storage. */
  url: Schema.URLFromString,
  /** Whether this is a conversation comment, submitted review, or diff comment. */
  kind: CommentKind,
  /** The creation time of a comment or submission time of a review, or `None` for older records. */
  at: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString),
}) {}

/** A commit, pull request, comment, or review recorded as evidence of an attempt's work. */
export const StepResultFact = Schema.Union([Commit, PullRequest, Comment]);
export type StepResultFact = typeof StepResultFact.Type;

/** The agent's final message and the facts kept after workspace cleanup. */
export class StepResult extends Schema.Class<StepResult>("StepResult")({
  /** The agent's final response for the completed step. */
  message: Schema.NonEmptyString,
  /** The commits and GitHub writes retained as evidence after checkout cleanup. */
  facts: Schema.Array(StepResultFact),
}) {}
