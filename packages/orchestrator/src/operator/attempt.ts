import { BrainSpec } from "@usine/core/agent/brain";
import { ChildSessionBudget, ChildSessionCount } from "@usine/core/agent/session";
import { AttemptNumber, AttemptId, AttemptTask } from "@usine/core/attempt";
import { AgentName } from "@usine/core/agent";
import { RunawayCeiling } from "@usine/core/attempt/failure";
import { AttemptSalvage } from "@usine/core/attempt/salvage";
import { AttemptStart } from "@usine/core/attempt/start";
import { WorkerName } from "@usine/core/worker";
import { Effect, Schema } from "effect";

/** An infra failure as the operator sees it; the defect cause stays behind this boundary. */
export class InfraFailureView extends Schema.TaggedClass<InfraFailureView>(
  "@usine/orchestrator/InfraFailureView",
)("InfraFailure", { message: Schema.String }) {}

/** A captured programmer defect requiring operator intervention; the original cause stays behind this boundary. */
export class DefectFailureView extends Schema.TaggedClass<DefectFailureView>(
  "@usine/orchestrator/DefectFailureView",
)("DefectFailure", { message: Schema.String }) {}

/** An agent failure message safe to display to the operator. */
export class AgentFailureView extends Schema.TaggedClass<AgentFailureView>(
  "@usine/orchestrator/AgentFailureView",
)("AgentFailure", { message: Schema.String }) {}

/** The blocker an Agent reported when it stopped; its Loop holds the Item until the operator acts or the Item changes. */
export class BlockedFailureView extends Schema.TaggedClass<BlockedFailureView>(
  "@usine/orchestrator/BlockedFailureView",
)("BlockedFailure", { message: Schema.String }) {}

/** The question an Agent asked the operator when it stopped; its Loop holds the Item until the operator answers. */
export class QuestionFailureView extends Schema.TaggedClass<QuestionFailureView>(
  "@usine/orchestrator/QuestionFailureView",
)("QuestionFailure", { question: Schema.String }) {}

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
  DefectFailureView,
  AgentFailureView,
  BlockedFailureView,
  QuestionFailureView,
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

/**
 * One Attempt's identity, Worker, effective brain, why and when it started,
 * its end time, optional terminal outcome, and salvaged work.
 */
export class AttemptView extends Schema.Class<AttemptView>("@usine/orchestrator/AttemptView")({
  id: AttemptId,
  number: AttemptNumber,
  worker: WorkerName,
  brain: BrainSpec,
  task: AttemptTask,
  agent: AgentName,
  operatorIntervened: Schema.Boolean,
  startedAt: Schema.String,
  outcome: Schema.NullOr(AttemptOutcomeView),
  /** When the outcome was recorded; null while the Attempt runs and for Attempts closed before end times were recorded. */
  endedAt: Schema.NullOr(Schema.String),
  salvage: Schema.NullOr(AttemptSalvage),
  /** Why the Attempt began; null for a later Attempt begun before usine recorded it. */
  start: Schema.NullOr(AttemptStart).pipe(Schema.withConstructorDefault(Effect.succeed(null))),
  /** When an orchestrator restart last reattached the Attempt; null if none did. */
  reattachedAt: Schema.NullOr(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
}) {}
