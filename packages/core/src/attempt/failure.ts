import { Schema } from "effect";
import { ChildSessionBudget, ChildSessionCount } from "../agent/session.ts";
import { RepositoryName } from "../repository.ts";

/** A push refused with HTTP 403 for the attempt's single-repository installation token. */
export class GitHubPushFailure extends Schema.TaggedError<GitHubPushFailure>(
  "AttemptFailure/GitHubPushFailure",
)("GitHubPushFailure", {
  repository: RepositoryName,
  ref: Schema.NonEmptyString,
  message: Schema.String,
}) {}

/**
 * An infrastructure failure outside the agent, such as an unreachable Worker or failed checkout.
 * The engine retries it automatically, up to the attempt cap.
 */
export class InfraFailure extends Schema.TaggedError<InfraFailure>("AttemptFailure/InfraFailure")(
  "InfraFailure",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** A programmer defect caught at the durable execution boundary; not retried automatically. */
export class DefectFailure extends Schema.TaggedError<DefectFailure>(
  "AttemptFailure/DefectFailure",
)("DefectFailure", { message: Schema.String, cause: Schema.Defect() }) {}

/** A temporary refusal because the model provider has no capacity. */
export class ProviderCapacityFailure extends Schema.TaggedError<ProviderCapacityFailure>(
  "AttemptFailure/ProviderCapacityFailure",
)("ProviderCapacityFailure", { message: Schema.NonEmptyString }) {}

/** A task failure reported by the agent; not retried automatically. */
export class AgentFailure extends Schema.TaggedError<AgentFailure>("AttemptFailure/AgentFailure")(
  "AgentFailure",
  {
    message: Schema.String,
  },
) {}

/**
 * A blocker the agent can't resolve, described in `message` with the remaining work. The Loop
 * opens no new Run for the Item until the operator retries or resolves the Run, or the Item
 * changes (ADR 0017).
 */
export class BlockedFailure extends Schema.TaggedError<BlockedFailure>(
  "AttemptFailure/BlockedFailure",
)("BlockedFailure", {
  message: Schema.NonEmptyString,
}) {}

/**
 * A question that needs an operator decision. The Loop opens no new Run for the Item until the
 * operator answers or the Item changes (ADR 0017).
 */
export class QuestionFailure extends Schema.TaggedError<QuestionFailure>(
  "AttemptFailure/QuestionFailure",
)("QuestionFailure", {
  question: Schema.NonEmptyString,
}) {}

/** The runaway guard limit that was exceeded. */
export const RunawayCeiling = Schema.Literals(["wall-clock", "tokens"]);
export type RunawayCeiling = typeof RunawayCeiling.Type;

/** A stop by the runaway guard after the Attempt exceeded `ceiling`; not retried automatically (ADR 0013). */
export class RunawayFailure extends Schema.TaggedError<RunawayFailure>(
  "AttemptFailure/RunawayFailure",
)("RunawayFailure", {
  ceiling: RunawayCeiling,
}) {}

/** A parent request for more child sessions than `maxChildren`; not retried automatically. */
export class ChildSessionBudgetFailure extends Schema.TaggedError<ChildSessionBudgetFailure>(
  "AttemptFailure/ChildSessionBudgetFailure",
)("ChildSessionBudgetFailure", {
  maxChildren: ChildSessionBudget,
  attemptedChildren: ChildSessionCount,
}) {}

export const AttemptFailure = Schema.Union([
  GitHubPushFailure,
  InfraFailure,
  ProviderCapacityFailure,
  DefectFailure,
  AgentFailure,
  BlockedFailure,
  QuestionFailure,
  RunawayFailure,
  ChildSessionBudgetFailure,
]);
export type AttemptFailure = typeof AttemptFailure.Type;

/** Returns whether infrastructure or provider capacity permits an automatic retry; the attempt cap also applies. */
export const isAutoRetryableFailure = Schema.is(
  Schema.Union([InfraFailure, ProviderCapacityFailure]),
);
