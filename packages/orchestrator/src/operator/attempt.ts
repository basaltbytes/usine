import { BrainSpec } from "@usine/core/agent/brain";
import { ChildSessionBudget, ChildSessionCount } from "@usine/core/agent/session";
import { AttemptNumber, AttemptId, AttemptTask, OutOfMemoryKills } from "@usine/core/attempt";
import { AgentName } from "@usine/core/agent";
import { RunawayCeiling } from "@usine/core/attempt/failure";
import { AttemptSalvage } from "@usine/core/attempt/salvage";
import { AttemptStart } from "@usine/core/attempt/start";
import { MachineProvider, SshDestination, SshPort, WorkerName } from "@usine/core/worker";
import { Effect, Schema } from "effect";

/** An infra failure without its defect cause. */
export class InfraFailureView extends Schema.TaggedClass<InfraFailureView>(
  "@usine/orchestrator/InfraFailureView",
)("InfraFailure", { message: Schema.String }) {}

/** A captured programmer defect that needs operator intervention, without the original cause. */
export class DefectFailureView extends Schema.TaggedClass<DefectFailureView>(
  "@usine/orchestrator/DefectFailureView",
)("DefectFailure", { message: Schema.String }) {}

/** An agent failure message that is safe to show to the operator. */
export class AgentFailureView extends Schema.TaggedClass<AgentFailureView>(
  "@usine/orchestrator/AgentFailureView",
)("AgentFailure", { message: Schema.String }) {}

/**
 * The blocker an Agent reported when it stopped. The Item's next state opens no Run of the Loop
 * (ADR 0017).
 */
export class BlockedFailureView extends Schema.TaggedClass<BlockedFailureView>(
  "@usine/orchestrator/BlockedFailureView",
)("BlockedFailure", { message: Schema.String }) {}

/**
 * The question an Agent asked the operator when it stopped. The Item's next state opens no Run of
 * the Loop (ADR 0017).
 */
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

/** An Attempt failure with only the details shown to the operator. */
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

/** An Attempt that succeeded. */
export class SucceededAttemptView extends Schema.TaggedClass<SucceededAttemptView>(
  "@usine/orchestrator/SucceededAttemptView",
)("Succeeded", {}) {}

/** An Attempt that failed. */
export class FailedAttemptView extends Schema.TaggedClass<FailedAttemptView>(
  "@usine/orchestrator/FailedAttemptView",
)("Failed", { failure: FailureView }) {}

/** An Attempt that ended after cancellation. */
export class CanceledAttemptView extends Schema.TaggedClass<CanceledAttemptView>(
  "@usine/orchestrator/CanceledAttemptView",
)("Canceled", {}) {}

/** The terminal outcome of an Attempt. A running Attempt has none. */
export const AttemptOutcomeView = Schema.Union([
  SucceededAttemptView,
  FailedAttemptView,
  CanceledAttemptView,
]);
export type AttemptOutcomeView = typeof AttemptOutcomeView.Type;

/** A Worker on the orchestrator's machine, so its paths are local paths. */
export class LocalWorkerAccess extends Schema.TaggedClass<LocalWorkerAccess>(
  "@usine/orchestrator/LocalWorkerAccess",
)("Local", {}) {}

/**
 * A Worker on another machine, accessed with `ssh` at `destination`. `port` is null if `usine.yaml`
 * sets none, which uses the client's default.
 */
export class SshWorkerAccess extends Schema.TaggedClass<SshWorkerAccess>(
  "@usine/orchestrator/SshWorkerAccess",
)("Ssh", { destination: SshDestination, port: Schema.NullOr(SshPort) }) {}

/**
 * A provisioned Worker, which created a machine for each Attempt at `provider` and deletes it
 * once the Attempt's slot is released, so `usine.yaml` has no address for it.
 */
export class ProvisionedWorkerAccess extends Schema.TaggedClass<ProvisionedWorkerAccess>(
  "@usine/orchestrator/ProvisionedWorkerAccess",
)("Provisioned", { provider: MachineProvider }) {}

/**
 * A Worker that runs each Attempt in its own Cloudflare sandbox, which accepts no operator terminal
 * and is destroyed when the Attempt ends.
 */
export class SandboxWorkerAccess extends Schema.TaggedClass<SandboxWorkerAccess>(
  "@usine/orchestrator/SandboxWorkerAccess",
)("Sandbox", {}) {}

/** How the operator accesses a Worker's machine, from its `usine.yaml` entry. */
export const WorkerAccess = Schema.Union([
  LocalWorkerAccess,
  SshWorkerAccess,
  ProvisionedWorkerAccess,
  SandboxWorkerAccess,
]);
export type WorkerAccess = typeof WorkerAccess.Type;

/** One Attempt with its Worker, effective brain, start, end, outcome, and salvaged work. */
export class AttemptView extends Schema.Class<AttemptView>("@usine/orchestrator/AttemptView")({
  id: AttemptId,
  number: AttemptNumber,
  worker: WorkerName,
  /** How the operator accesses `worker`, or null if `usine.yaml` no longer declares it. */
  workerAccess: Schema.NullOr(WorkerAccess),
  brain: BrainSpec,
  task: AttemptTask,
  agent: AgentName,
  operatorIntervened: Schema.Boolean,
  startedAt: Schema.String,
  outcome: Schema.NullOr(AttemptOutcomeView),
  /**
   * When the outcome was recorded. Null while the Attempt runs and for Attempts closed before end
   * times were recorded.
   */
  endedAt: Schema.NullOr(Schema.String),
  salvage: Schema.NullOr(AttemptSalvage),
  /** Why the Attempt began, or null for a later Attempt begun before this was recorded. */
  start: Schema.NullOr(AttemptStart).pipe(Schema.withConstructorDefault(Effect.succeed(null))),
  /** When an orchestrator restart last reattached the Attempt, or null if none did. */
  reattachedAt: Schema.NullOr(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /** The processes the kernel killed in the Attempt's container for memory, or null if none. */
  outOfMemory: Schema.NullOr(OutOfMemoryKills).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
}) {}
