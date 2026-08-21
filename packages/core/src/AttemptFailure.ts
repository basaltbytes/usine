/**
 * Why an attempt failed — the typed taxonomy the retry law dispatches on
 * (ADR 0002, ADR 0013). Three classes, deliberately distinct:
 *
 * - `InfraFailure` — the only class the engine may retry on its own, capped.
 * - `AgentFailure` — always waits for the operator.
 * - `RunawayFailure` — never auto-retried; only the operator restarts it.
 */
import { Schema } from "effect";

/**
 * Infrastructure failed around the agent — worker unreachable, checkout
 * failed, run host died. Auto-retryable, capped.
 */
export class InfraFailure extends Schema.TaggedError<InfraFailure>()("InfraFailure", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/**
 * The agent ran and failed the work itself. Never auto-retried — an agent that
 * failed once would fail the same way again; the operator decides what changes
 * before the next attempt.
 */
export class AgentFailure extends Schema.TaggedError<AgentFailure>()("AgentFailure", {
  message: Schema.String,
}) {}

/** Which per-attempt ceiling the runaway guard tripped. */
export const RunawayCeiling = Schema.Literals(["wall-clock", "tokens"]);
export type RunawayCeiling = typeof RunawayCeiling.Type;

/**
 * The runaway guard interrupted an attempt burning without progress. Its own
 * class so auto-retry can never touch it (ADR 0013).
 */
export class RunawayFailure extends Schema.TaggedError<RunawayFailure>()("RunawayFailure", {
  ceiling: RunawayCeiling,
}) {}

export const AttemptFailure = Schema.Union([InfraFailure, AgentFailure, RunawayFailure]);
export type AttemptFailure = typeof AttemptFailure.Type;

/**
 * Auto-retry applies only to typed infra errors — agent failures and runaways
 * always wait for the operator (ADR 0002).
 */
export const isAutoRetryable = (failure: AttemptFailure): failure is InfraFailure =>
  failure._tag === "InfraFailure";
