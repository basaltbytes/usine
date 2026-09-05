/**
 * Why an attempt failed — the typed taxonomy the retry law dispatches on
 * (ADR 0002, ADR 0013). Four classes, deliberately distinct:
 *
 * - `InfraFailure` — the only class the engine may retry on its own, capped.
 * - `AgentFailure` — always waits for the operator.
 * - `RunawayFailure` — never auto-retried; only the operator restarts it.
 * - `ChildSessionBudgetFailure` — a parent exhausted its per-Attempt spawn allowance.
 */
import { Schema } from "effect";
import { ChildSessionBudget, ChildSessionCount } from "../agent/session.ts";

/**
 * Infrastructure failed around the agent — worker unreachable, checkout
 * failed, run host died. Auto-retryable, capped.
 */
export class InfraFailure extends Schema.TaggedError<InfraFailure>("AttemptFailure/InfraFailure")(
  "InfraFailure",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/**
 * The agent ran and failed the work itself. Never auto-retried — an agent that
 * failed once would fail the same way again; the operator decides what changes
 * before the next attempt.
 */
export class AgentFailure extends Schema.TaggedError<AgentFailure>("AttemptFailure/AgentFailure")(
  "AgentFailure",
  {
    message: Schema.String,
  },
) {}

/** Which per-attempt ceiling the runaway guard tripped. */
export const RunawayCeiling = Schema.Literals(["wall-clock", "tokens"]);
export type RunawayCeiling = typeof RunawayCeiling.Type;

/**
 * The runaway guard interrupted an attempt burning without progress. Its own
 * class so auto-retry can never touch it (ADR 0013).
 */
export class RunawayFailure extends Schema.TaggedError<RunawayFailure>(
  "AttemptFailure/RunawayFailure",
)("RunawayFailure", {
  ceiling: RunawayCeiling,
}) {}

/**
 * The Pi parent tried to spawn more child sessions than this Attempt permits.
 * Never auto-retried because the same parent would exhaust the same budget
 * again.
 */
export class ChildSessionBudgetFailure extends Schema.TaggedError<ChildSessionBudgetFailure>(
  "AttemptFailure/ChildSessionBudgetFailure",
)("ChildSessionBudgetFailure", {
  maxChildren: ChildSessionBudget,
  attemptedChildren: ChildSessionCount,
}) {}

export const AttemptFailure = Schema.Union([
  InfraFailure,
  AgentFailure,
  RunawayFailure,
  ChildSessionBudgetFailure,
]);
export type AttemptFailure = typeof AttemptFailure.Type;

/**
 * The class half of the auto-retry law (ADR 0002): only infra failures are
 * ever auto-retried. This deliberately ignores the attempt cap — the full
 * capped decision is `shouldAutoRetry` in `attempt.ts`.
 */
export const isAutoRetryableFailure = Schema.is(InfraFailure);
