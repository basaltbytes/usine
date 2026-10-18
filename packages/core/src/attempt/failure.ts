import { Schema } from "effect";
import { ChildSessionBudget, ChildSessionCount } from "../agent/session.ts";

/**
 * Infrastructure failed around the agent: worker unreachable, checkout failed,
 * parent task lost. The only class the engine retries on its own, capped.
 */
export class InfraFailure extends Schema.TaggedError<InfraFailure>("AttemptFailure/InfraFailure")(
  "InfraFailure",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** A programmer defect captured at the durable execution boundary. Retains its cause for diagnosis and requires an operator retry. */
export class DefectFailure extends Schema.TaggedError<DefectFailure>(
  "AttemptFailure/DefectFailure",
)("DefectFailure", { message: Schema.String, cause: Schema.Defect() }) {}

/**
 * The agent ran and failed the work itself. Never auto-retried, since the same
 * agent would fail the same way; the operator decides what changes first.
 */
export class AgentFailure extends Schema.TaggedError<AgentFailure>("AttemptFailure/AgentFailure")(
  "AgentFailure",
  {
    message: Schema.String,
  },
) {}

/**
 * The agent stopped because it needs an operator decision it cannot make
 * itself, and `question` is what it asks. Never auto-retried: the Loop holds
 * the Item until the operator answers or the Item changes again (ADR 0017).
 */
export class QuestionFailure extends Schema.TaggedError<QuestionFailure>(
  "AttemptFailure/QuestionFailure",
)("QuestionFailure", {
  question: Schema.NonEmptyString,
}) {}

/** Which per-attempt ceiling the runaway guard tripped. */
export const RunawayCeiling = Schema.Literals(["wall-clock", "tokens"]);
export type RunawayCeiling = typeof RunawayCeiling.Type;

/** The runaway guard interrupted an attempt that burned without progress. Never auto-retried (ADR 0013). */
export class RunawayFailure extends Schema.TaggedError<RunawayFailure>(
  "AttemptFailure/RunawayFailure",
)("RunawayFailure", {
  ceiling: RunawayCeiling,
}) {}

/**
 * The parent tried to spawn more child sessions than the Attempt allows. Never
 * auto-retried, since the same parent would exhaust the same budget again.
 */
export class ChildSessionBudgetFailure extends Schema.TaggedError<ChildSessionBudgetFailure>(
  "AttemptFailure/ChildSessionBudgetFailure",
)("ChildSessionBudgetFailure", {
  maxChildren: ChildSessionBudget,
  attemptedChildren: ChildSessionCount,
}) {}

export const AttemptFailure = Schema.Union([
  InfraFailure,
  DefectFailure,
  AgentFailure,
  QuestionFailure,
  RunawayFailure,
  ChildSessionBudgetFailure,
]);
export type AttemptFailure = typeof AttemptFailure.Type;

/** The class half of the auto-retry law: only infra failures qualify. `shouldAutoRetry` adds the attempt cap. */
export const isAutoRetryableFailure = Schema.is(InfraFailure);
