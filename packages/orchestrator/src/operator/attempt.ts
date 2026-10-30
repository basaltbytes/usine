import { BrainSpec } from "@usine/core/agent/brain";
import { ChildSessionBudget, ChildSessionCount } from "@usine/core/agent/session";
import { AttemptNumber, AttemptId, AttemptTask, OutOfMemoryKills } from "@usine/core/attempt";
import { AgentName } from "@usine/core/agent";
import { RunawayCeiling } from "@usine/core/attempt/failure";
import { AttemptSalvage } from "@usine/core/attempt/salvage";
import { AttemptStart } from "@usine/core/attempt/start";
import { MachineProvider, SshDestination, SshPort, WorkerName } from "@usine/core/worker";
import { Effect, Schema } from "effect";

/** A GitHub push refusal with its repository, ref, and token scope in the message. */
export class GitHubPushFailureView extends Schema.TaggedClass<GitHubPushFailureView>(
  "@usine/orchestrator/GitHubPushFailureView",
)("GitHubPushFailure", {
  /** The diagnostic text to show to the operator. */
  message: Schema.String,
}) {}

/** An infra failure without its defect cause. */
export class InfraFailureView extends Schema.TaggedClass<InfraFailureView>(
  "@usine/orchestrator/InfraFailureView",
)("InfraFailure", {
  /** The diagnostic text to show to the operator. */
  message: Schema.String,
}) {}

/** A temporary model provider capacity refusal. */
export class ProviderCapacityFailureView extends Schema.TaggedClass<ProviderCapacityFailureView>(
  "@usine/orchestrator/ProviderCapacityFailureView",
)("ProviderCapacityFailure", {
  /** The diagnostic text to show to the operator. */
  message: Schema.String,
}) {}

/** A captured programmer defect that needs operator intervention, without the original cause. */
export class DefectFailureView extends Schema.TaggedClass<DefectFailureView>(
  "@usine/orchestrator/DefectFailureView",
)("DefectFailure", {
  /** The diagnostic text to show to the operator. */
  message: Schema.String,
}) {}

/** An agent failure message that is safe to show to the operator. */
export class AgentFailureView extends Schema.TaggedClass<AgentFailureView>(
  "@usine/orchestrator/AgentFailureView",
)("AgentFailure", {
  /** The diagnostic text to show to the operator. */
  message: Schema.String,
}) {}

/**
 * The blocker an Agent reported when it stopped. The Item's next state opens no Run of the Loop
 * (ADR 0017).
 */
export class BlockedFailureView extends Schema.TaggedClass<BlockedFailureView>(
  "@usine/orchestrator/BlockedFailureView",
)("BlockedFailure", {
  /** The diagnostic text to show to the operator. */
  message: Schema.String,
}) {}

/**
 * The question an Agent asked the operator when it stopped. The Item's next state opens no Run of
 * the Loop (ADR 0017).
 */
export class QuestionFailureView extends Schema.TaggedClass<QuestionFailureView>(
  "@usine/orchestrator/QuestionFailureView",
)("QuestionFailure", {
  /** The question the agent requires the operator to answer before work can continue. */
  question: Schema.String,
}) {}

/** The wall-clock or token ceiling that stopped an Attempt. */
export class RunawayFailureView extends Schema.TaggedClass<RunawayFailureView>(
  "@usine/orchestrator/RunawayFailureView",
)("RunawayFailure", {
  /** The wall-clock or token limit exceeded by the attempt. */
  ceiling: RunawayCeiling,
}) {}

/** The configured child-session budget and the spawn count that exceeded it. */
export class ChildSessionBudgetFailureView extends Schema.TaggedClass<ChildSessionBudgetFailureView>(
  "@usine/orchestrator/ChildSessionBudgetFailureView",
)("ChildSessionBudgetFailure", {
  /** The configured maximum child sessions per attempt. */
  maxChildren: ChildSessionBudget,
  /** The child-session count requested when the budget was exceeded. */
  attemptedChildren: ChildSessionCount,
}) {}

/** An Attempt failure with only the details shown to the operator. */
export const FailureView = Schema.Union([
  GitHubPushFailureView,
  InfraFailureView,
  ProviderCapacityFailureView,
  DefectFailureView,
  AgentFailureView,
  BlockedFailureView,
  QuestionFailureView,
  RunawayFailureView,
  ChildSessionBudgetFailureView,
]);
/** An attempt failure with only the details shown to the operator. */
export type FailureView = typeof FailureView.Type;

/** An Attempt that succeeded. */
export class SucceededAttemptView extends Schema.TaggedClass<SucceededAttemptView>(
  "@usine/orchestrator/SucceededAttemptView",
)("Succeeded", {}) {}

/** An Attempt that failed. */
export class FailedAttemptView extends Schema.TaggedClass<FailedAttemptView>(
  "@usine/orchestrator/FailedAttemptView",
)("Failed", {
  /** The failure details safe to return to operator clients. */
  failure: FailureView,
}) {}

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
/** The terminal outcome of an attempt. A running attempt has none. */
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
)("Ssh", {
  /** The SSH host, optionally including the user. */
  destination: SshDestination,
  /** The configured SSH port, or null to use the SSH client default. */
  port: Schema.NullOr(SshPort),
}) {}

/**
 * A provisioned Worker, which created a machine for each Attempt at `provider` and deletes it
 * once the Attempt's slot is released, so `usine.yaml` has no address for it.
 */
export class ProvisionedWorkerAccess extends Schema.TaggedClass<ProvisionedWorkerAccess>(
  "@usine/orchestrator/ProvisionedWorkerAccess",
)("Provisioned", {
  /** The provider that creates one machine per attempt. */
  provider: MachineProvider,
}) {}

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
/** How the operator accesses a worker's machine, from its `usine.yaml` entry. */
export type WorkerAccess = typeof WorkerAccess.Type;

/** One Attempt with its Worker, effective brain, start, end, outcome, and salvaged work. */
export class AttemptView extends Schema.Class<AttemptView>("@usine/orchestrator/AttemptView")({
  /** The persistent attempt identity. */
  id: AttemptId,
  /** The one-based attempt number within its run. */
  number: AttemptNumber,
  /** The configured worker name. */
  worker: WorkerName,
  /** How the operator accesses `worker`, or null if `usine.yaml` no longer declares it. */
  workerAccess: Schema.NullOr(WorkerAccess),
  /** The effective harness, model, and reasoning effort used for the attempt. */
  brain: BrainSpec,
  /** The task text supplied when this attempt started. */
  task: AttemptTask,
  /** The referenced agent name. */
  agent: AgentName,
  /** Whether an operator intervention was recorded for this attempt. */
  operatorIntervened: Schema.Boolean,
  /** The attempt start time as an ISO 8601 timestamp. */
  startedAt: Schema.String,
  /** The recorded terminal outcome, or null while the attempt is open. */
  outcome: Schema.NullOr(AttemptOutcomeView),
  /**
   * When the outcome was recorded. Null while the Attempt runs and for Attempts closed before end
   * times were recorded.
   */
  endedAt: Schema.NullOr(Schema.String),
  /** The retained checkout or pushed salvage branch, or null without retained work. */
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
