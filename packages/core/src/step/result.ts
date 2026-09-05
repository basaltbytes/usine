import { Schema } from "effect";
import { CommitSha } from "../repository.ts";

/** A commit the run host found between the workspace base and final HEAD. */
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

/** A GitHub comment the agent created or updated during the Attempt. */
export class Comment extends Schema.TaggedClass<Comment>("StepResult/Comment")("Comment", {
  url: Schema.URLFromString,
}) {}

/** A commit or GitHub artifact recorded as an outcome of the Agent's work. */
export const StepResultFact = Schema.Union([Commit, PullRequest, Comment]);
export type StepResultFact = typeof StepResultFact.Type;

/** The agent's final message plus the facts that survive workspace cleanup. */
export class StepResult extends Schema.Class<StepResult>("StepResult")({
  message: Schema.NonEmptyString,
  facts: Schema.Array(StepResultFact),
}) {}
