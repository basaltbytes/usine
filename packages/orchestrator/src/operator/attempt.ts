import { BrainSpec } from "@usine/core/agent/brain";
import { ChildSessionBudget, ChildSessionCount } from "@usine/core/agent/session";
import { AttemptNumber, AttemptId } from "@usine/core/attempt";
import { RunawayCeiling } from "@usine/core/attempt/failure";
import { WorkerName } from "@usine/core/worker";
import { Schema } from "effect";

/** An infra failure as the operator sees it; the defect cause stays behind this boundary. */
export class InfraFailureView extends Schema.TaggedClass<InfraFailureView>(
  "@usine/orchestrator/InfraFailureView",
)("InfraFailure", { message: Schema.String }) {}

/** An agent failure message safe to display to the operator. */
export class AgentFailureView extends Schema.TaggedClass<AgentFailureView>(
  "@usine/orchestrator/AgentFailureView",
)("AgentFailure", { message: Schema.String }) {}

/** The wall-clock or token ceiling that stopped an Attempt. */
export class RunawayFailureView extends Schema.TaggedClass<RunawayFailureView>(
  "@usine/orchestrator/RunawayFailureView",
)("RunawayFailure", { ceiling: RunawayCeiling }) {}

/** The configured child-session budget and the spawn count that exceeded it. */
export class ChildSessionBudgetFailureView extends Schema.TaggedClass<ChildSessionBudgetFailureView>(
  "@usine/orchestrator/ChildSessionBudgetFailureView",
)("ChildSessionBudgetFailure", {
  maxChildren: ChildSessionBudget,
  attemptedChildren: ChildSessionCount,
}) {}

/** An Attempt failure with only the details the operator can inspect. */
export const FailureView = Schema.Union([
  InfraFailureView,
  AgentFailureView,
  RunawayFailureView,
  ChildSessionBudgetFailureView,
]);
export type FailureView = typeof FailureView.Type;

/** An Attempt that completed successfully. */
export class SucceededAttemptView extends Schema.TaggedClass<SucceededAttemptView>(
  "@usine/orchestrator/SucceededAttemptView",
)("Succeeded", {}) {}

/** An Attempt that ended with a failure the operator can inspect. */
export class FailedAttemptView extends Schema.TaggedClass<FailedAttemptView>(
  "@usine/orchestrator/FailedAttemptView",
)("Failed", { failure: FailureView }) {}

/** An Attempt that ended after cancellation. */
export class CanceledAttemptView extends Schema.TaggedClass<CanceledAttemptView>(
  "@usine/orchestrator/CanceledAttemptView",
)("Canceled", {}) {}

/** The terminal outcome displayed for an Attempt; a live Attempt has no outcome. */
export const AttemptOutcomeView = Schema.Union([
  SucceededAttemptView,
  FailedAttemptView,
  CanceledAttemptView,
]);
export type AttemptOutcomeView = typeof AttemptOutcomeView.Type;

/** One Attempt's identity, Worker, effective brain, start time, and optional terminal outcome. */
export class AttemptView extends Schema.Class<AttemptView>("@usine/orchestrator/AttemptView")({
  id: AttemptId,
  number: AttemptNumber,
  worker: WorkerName,
  brain: BrainSpec,
  startedAt: Schema.String,
  outcome: Schema.NullOr(AttemptOutcomeView),
}) {}
