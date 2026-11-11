import { type Brand, Effect, Schema } from "effect";
import { ChildSessionBudget, ChildSessionCount } from "../agent/session.ts";
import { RepositoryName } from "../repository.ts";

/** A push refused with HTTP 403 for the attempt's single-repository installation token. */
export class GitHubPushFailure extends Schema.TaggedError<
  GitHubPushFailure,
  Brand.Brand<"@usine/core/attempt/failure/GitHubPushFailure">
>("AttemptFailure/GitHubPushFailure")("GitHubPushFailure", {
  /** The managed repo whose installation token could not push. */
  repository: RepositoryName,
  /** The Git ref that the remote refused to update. */
  ref: Schema.NonEmptyString,
  /** The push diagnostic explaining the HTTP 403 refusal. */
  message: Schema.String,
}) {}

/**
 * An infrastructure failure outside the agent, such as an unreachable Worker or failed checkout.
 * The engine retries a failed attempt with it automatically, up to the attempt cap. A CI wait that
 * times out or ends with partly run CI also records it, and needs the operator: CI settlement sets
 * the attempt and run outcome directly, without the automatic retry.
 */
export class InfraFailure extends Schema.TaggedError<
  InfraFailure,
  Brand.Brand<"@usine/core/attempt/failure/InfraFailure">
>("AttemptFailure/InfraFailure")("InfraFailure", {
  /** The infrastructure failure diagnostic shown to the operator. */
  message: Schema.String,
  /** The original infrastructure error, encoded for durable storage. */
  cause: Schema.Defect(),
}) {}

/** A programmer defect caught at the durable execution boundary; not retried automatically. */
export class DefectFailure extends Schema.TaggedError<
  DefectFailure,
  Brand.Brand<"@usine/core/attempt/failure/DefectFailure">
>("AttemptFailure/DefectFailure")("DefectFailure", {
  /** The diagnostic describing the programming defect. */
  message: Schema.String,
  /** The original defect preserved at the durable execution boundary. */
  cause: Schema.Defect(),
}) {}

/** A temporary refusal because the model provider has no capacity or the usage limit is reached. */
export class ProviderCapacityFailure extends Schema.TaggedError<
  ProviderCapacityFailure,
  Brand.Brand<"@usine/core/attempt/failure/ProviderCapacityFailure">
>("AttemptFailure/ProviderCapacityFailure")("ProviderCapacityFailure", {
  /** The provider's temporary capacity refusal used in the retry notice. */
  message: Schema.NonEmptyString,
  /** The time the provider's usage limit resets, or `None` if the provider didn't report one. */
  resetsAt: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString).pipe(
    Schema.withConstructorDefault(Effect.succeedNone),
  ),
}) {}

/** A task failure reported by the agent; not retried automatically. */
export class AgentFailure extends Schema.TaggedError<
  AgentFailure,
  Brand.Brand<"@usine/core/attempt/failure/AgentFailure">
>("AttemptFailure/AgentFailure")("AgentFailure", {
  /** The agent's explanation of why it could not complete the task. */
  message: Schema.String,
}) {}

/**
 * A blocker the agent can't resolve, described in `message` with the remaining work. The Loop
 * opens no new Run for the Item until the operator retries or resolves the Run, or the Item
 * changes (ADR 0017).
 */
export class BlockedFailure extends Schema.TaggedError<
  BlockedFailure,
  Brand.Brand<"@usine/core/attempt/failure/BlockedFailure">
>("AttemptFailure/BlockedFailure")("BlockedFailure", {
  /** The exact blocker and the work that remains incomplete. */
  message: Schema.NonEmptyString,
}) {}

/**
 * A question that needs an operator decision. The Loop opens no new Run for the Item until the
 * operator answers or the Item changes (ADR 0017).
 */
export class QuestionFailure extends Schema.TaggedError<
  QuestionFailure,
  Brand.Brand<"@usine/core/attempt/failure/QuestionFailure">
>("AttemptFailure/QuestionFailure")("QuestionFailure", {
  /** The decision the operator must make before work can continue. */
  question: Schema.NonEmptyString,
}) {}

/** The runaway guard limit that was exceeded. */
export const RunawayCeiling = Schema.Literals(["wall-clock", "tokens"]);
export type RunawayCeiling = typeof RunawayCeiling.Type;

/** A stop by the runaway guard after the Attempt exceeded `ceiling`; not retried automatically (ADR 0013). */
export class RunawayFailure extends Schema.TaggedError<
  RunawayFailure,
  Brand.Brand<"@usine/core/attempt/failure/RunawayFailure">
>("AttemptFailure/RunawayFailure")("RunawayFailure", {
  /** The wall-clock or token limit that stopped the attempt. */
  ceiling: RunawayCeiling,
}) {}

/** A parent request for more child sessions than `maxChildren`; not retried automatically. */
export class ChildSessionBudgetFailure extends Schema.TaggedError<
  ChildSessionBudgetFailure,
  Brand.Brand<"@usine/core/attempt/failure/ChildSessionBudgetFailure">
>("AttemptFailure/ChildSessionBudgetFailure")("ChildSessionBudgetFailure", {
  /** The maximum child sessions allowed for the attempt, including sequential starts. */
  maxChildren: ChildSessionBudget,
  /** The count including the child request that exceeded the budget. */
  attemptedChildren: ChildSessionCount,
}) {}

/** The recorded reasons an attempt can fail, including failures that require an operator decision. */
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
