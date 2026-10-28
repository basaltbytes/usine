import type { AttemptRecovery, RecoverySink } from "@usine/core/attempt/salvage";
import { Agent } from "@usine/core/agent";
import { BrainSpec, Effort, ModelId } from "@usine/core/agent/brain";
import { ChildSessionBudget } from "@usine/core/agent/session";
import { AttemptTask, AttemptId, type StopReason } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AttemptFailure } from "@usine/core/attempt/failure";
import { LoopName, LoopPermissions } from "@usine/core/loop";
import { SalvagePushed, SalvageRef } from "@usine/core/attempt/salvage";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import {
  BotAccount,
  BotLogin,
  ContainerLimits,
  MachineId,
  MachineProvider,
  WorkerName,
  WorkerKind,
} from "@usine/core/worker";
import { StepResult } from "@usine/core/step/result";
import { Context, Effect, Option, Predicate, Redacted, type Result, Schema, Scope } from "effect";

export const ExecutorOperation = Schema.Literals([
  "preflight",
  "prepare",
  "launch",
  "cancel",
  "cleanup",
]);
export type ExecutorOperation = typeof ExecutorOperation.Type;

export const WorkerCapability = Schema.Literals([
  "machine",
  "toolchain",
  "memory",
  "harness-login",
  "credentials",
  "gateway",
  "container",
  "provider",
]);
export type WorkerCapability = typeof WorkerCapability.Type;

export class ExecutorOperationError extends Schema.TaggedError<ExecutorOperationError>(
  "@usine/executor/ExecutorOperationError",
)("ExecutorOperationError", {
  /** `cleanup` includes removing a checkout, its credential, or credentials left by an earlier process. */
  operation: ExecutorOperation,
  /** An operator-facing summary without the Worker name. Not part of the contract; branch on `operation`. */
  message: Schema.NonEmptyString,
  /** The underlying failure, for example an `Error` with the command's stderr, or a timeout. */
  cause: Schema.Defect(),
}) {}

/**
 * `refused` if a retry gets the same result: the installation doesn't cover the repository,
 * lacks a permission, or is suspended, or an exe.dev Worker has no integration for it.
 * `unreachable` if a retry can succeed: a GitHub outage or rate limit, or no response from a
 * Gateway or exe.dev command.
 */
export const CredentialUnavailableReason = Schema.Literals(["refused", "unreachable"]);
export type CredentialUnavailableReason = typeof CredentialUnavailableReason.Type;

export class CredentialUnavailableError extends Schema.TaggedError<CredentialUnavailableError>(
  "@usine/executor/CredentialUnavailableError",
)("CredentialUnavailableError", {
  repository: RepositoryName,
  reason: CredentialUnavailableReason,
  /** An operator-facing summary, including GitHub's reason for a refusal. */
  message: Schema.NonEmptyString,
  /** The underlying failure, for example the GitHub API error from minting the token. */
  cause: Schema.Defect(),
}) {}

/** The error when preflight finds a Worker capability missing or incompatible. */
export class WorkerCapabilityError extends Schema.TaggedError<WorkerCapabilityError>(
  "@usine/executor/WorkerCapabilityError",
)("WorkerCapabilityError", {
  worker: WorkerName,
  /**
   * - `machine`: the machine or VM is absent, stopped, or unreachable, or its Worker directory
   *   isn't writable.
   * - `toolchain`: Git or a brain's harness doesn't run.
   * - `memory`: less than 1.5 GiB per concurrent Attempt, no swap for more than one, or memory
   *   not reported.
   * - `harness-login`: a brain's harness isn't logged in.
   * - `credentials`: an exe.dev integration isn't ready, or the Worker kind can't issue a
   *   read-only credential for a `permissions: read` Loop.
   * - `gateway`: the Gateway doesn't respond or isn't reachable from the machine.
   * - `container`: the machine's Docker doesn't respond to the SSH user, the SSH user can use
   *   Docker's socket without the `docker` CLI, the Attempt image can't be pulled, or its user ID
   *   differs from the SSH user's.
   * - `provider`: a provisioned Worker's provider refuses its token, or its image, SSH key,
   *   network, server type, or location doesn't exist there.
   */
  capability: WorkerCapability,
  message: Schema.NonEmptyString,
  /** The observed value, for example unrecognized `git --version` output or the harness readiness report. */
  cause: Schema.Defect(),
}) {}

/**
 * `capacity` if the provider has no machine of the configured type now, `quota` if the account's
 * limits are reached, `refused` if the provider refuses the token or the request, `provider` for
 * an API error or rate limit, `unreachable` if the API doesn't respond, and `timeout` if the
 * machine didn't answer over SSH in time. Each is retried later.
 */
export const MachineUnavailableReason = Schema.Literals([
  "capacity",
  "quota",
  "refused",
  "provider",
  "unreachable",
  "timeout",
]);
export type MachineUnavailableReason = typeof MachineUnavailableReason.Type;

/**
 * The error when a provisioned Worker can't create a machine for an Attempt. The Run keeps
 * waiting, and the scheduler tries again later; it isn't an Attempt failure.
 */
export class MachineUnavailableError extends Schema.TaggedError<MachineUnavailableError>(
  "@usine/executor/MachineUnavailableError",
)("MachineUnavailableError", {
  worker: WorkerName,
  provider: MachineProvider,
  reason: MachineUnavailableReason,
  /** An operator-facing summary with the provider's own message. Contains no token. */
  message: Schema.NonEmptyString,
}) {}

export const ExecutorError = Schema.Union([
  ExecutorOperationError,
  CredentialUnavailableError,
  WorkerCapabilityError,
]);
export type ExecutorError = typeof ExecutorError.Type;

/** The outcome of a preflight that found every capability that Attempts need. */
export interface PreflightReport {
  /**
   * Why the Worker runs Attempts without a capability that keeps them apart, such as an SSH
   * Worker whose machine has no Docker. `None` if it has every such capability.
   */
  readonly degraded: Option.Option<string>;
  /**
   * When the brains are checked instead, if the preflight had no machine to check them on, as
   * for a provisioned Worker, which checks them on its first machine each day. `None` if the
   * preflight checked them.
   */
  readonly deferred: Option.Option<string>;
  /**
   * The limits of each Attempt container, the ones `usine.yaml` sets and the ones derived from
   * the machine. `None` if the Worker runs no containers or the preflight checked no machine.
   */
  readonly containerLimits: Option.Option<ContainerLimits>;
}

/** The report of a Worker that runs Attempts as designed, without containers. */
export const fullPreflight: PreflightReport = {
  degraded: Option.none(),
  deferred: Option.none(),
  containerLimits: Option.none(),
};

/** Logs each preflight failure at error level. */
export const logPreflightFailure = <A, R>(
  effect: Effect.Effect<A, ExecutorError, R>,
): Effect.Effect<A, ExecutorError, R> =>
  Effect.tapError(effect, (error) =>
    error instanceof WorkerCapabilityError
      ? Effect.logError("Worker preflight failed", {
          error: error._tag,
          message: error.message,
          worker: error.worker,
          capability: error.capability,
        })
      : Effect.logError("Worker preflight failed", {
          error: error._tag,
          message: error.message,
        }),
  );

export class CheckoutRequest extends Schema.Class<CheckoutRequest>(
  "@usine/executor/CheckoutRequest",
)({
  /** The checkout directory name, and the key for `cancel`, `intervene`, `isLive`, and `outcome`. */
  attemptId: AttemptId,
  worker: WorkerName,
  /** The only repository the Attempt's credential can access (ADR 0011). */
  repository: RepositoryName,
  /** The Loop of the Attempt's Run, shown in a `read` checkout's pre-push hook message. */
  loop: LoopName,
  /**
   * The Attempt's access to `repository` (ADR 0011). With `read`, the credential can't push, a
   * pre-push hook explains rejected pushes, and an unsuccessful Attempt's checkout is removed
   * without salvage. A Worker kind that can't issue such a credential fails `prepare` with a
   * `credentials` capability error.
   */
  permissions: LoopPermissions,
  /** The revision to fetch, resolved to a commit during preparation and stored as the RunSpec's `baseCommit`. */
  revision: RepositoryRevision,
  /** The payload of the event that triggered the Run, included as JSON in the parent's prompt. */
  payload: Schema.Json,
  /** The parent's task text, after Loop interpolation or operator amendment. */
  task: AttemptTask,
  /**
   * The Agent whose persona and name go in the parent's prompt and whose brain runs the
   * children. Preparation verifies the brain on the Worker.
   */
  agent: Agent,
  /**
   * The Pi parent's model. If `None`, uses the configured default model, then the first model
   * with a credential. A model unknown to Pi fails the launch.
   */
  parentModel: Schema.Option(ModelId),
  /** The maximum child sessions per Attempt. One more fails the Attempt with `ChildSessionBudgetFailure`. */
  maxChildren: ChildSessionBudget,
  /** The maximum minutes of Attempt execution, excluding preparation and cleanup, or `None` for no limit. */
  maxAttemptMinutes: Schema.Option(Schema.Int.check(Schema.isGreaterThan(0))),
  /** The maximum tokens consumed by the parent and all children, or `None` for no limit. Holds don't pause it. */
  maxAttemptTokens: Schema.Option(Schema.Int.check(Schema.isGreaterThan(0))),
  /** The Pi parent's reasoning effort. The launch fails if the model doesn't support it. */
  parentEffort: Effort,
  /** The ref that unfinished work is pushed to if the Attempt doesn't succeed. */
  salvageRef: SalvageRef,
  /** The previous Attempt's pushed salvage, checked out instead of `revision`. */
  resume: Schema.Option(SalvagePushed),
  /**
   * Whether the parent task is still live after an orchestrator restart. If true, preparation
   * reuses the existing checkout and launch reattaches to the parent.
   */
  reattach: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false))),
  /**
   * The GitHub login the Attempt writes as, copied into the RunSpec; harvesting collects comments
   * by this author. If `None`, harvesting asks GitHub for the credential's login.
   */
  botLogin: Schema.Option(BotLogin).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none<BotLogin>())),
  ),
  /**
   * The author and committer of every commit that the Attempt's parent and children make. Their
   * environment sets it, so no git config on the Worker's machine applies.
   */
  commitAuthor: BotAccount,
}) {}

export const WorktreePath = Schema.NonEmptyString.pipe(Schema.brand("WorktreePath"));
export type WorktreePath = typeof WorktreePath.Type;

/** A serializable checkout location and RunSpec, without credentials or live resources. */
export class AttemptWorkspace extends Schema.Class<AttemptWorkspace>(
  "@usine/executor/AttemptWorkspace",
)({
  worker: WorkerName,
  /** The request's fields plus the commit that `revision` resolved to. */
  spec: AttemptChannel.RunSpec,
  /** The checkout path on the Worker's machine, where the children run. */
  worktree: WorktreePath,
}) {}

/**
 * An Attempt prepared in the caller's scope and valid only within it. Closing that scope stops
 * any active session, removes the checkout, and releases credentials, whether or not `launch`
 * ran. The checkout stays on disk while the parent task stays live for a reattachment or isn't
 * confirmed stopped.
 */
export interface PreparedAttempt {
  readonly workspace: AttemptWorkspace;
  /**
   * Runs the Attempt once, writing channel activity to `io`, and releases its resources before
   * returning. Cleanup failures are logged without changing the result. Fails with an
   * infrastructure `AttemptFailure` if called again or after release.
   */
  readonly launch: (io: AttemptChannel.Sink) => Effect.Effect<StepResult, AttemptFailure>;
}

/**
 * A `Redacted` string, kept as the instance it was given, so wiping it wipes the token the
 * provider issued. `Schema.Redacted` stores a copy instead.
 */
const IssuedToken = Schema.declare(
  (input): input is Redacted.Redacted<string> =>
    Redacted.isRedacted(input) && Predicate.isString(Redacted.value(input)),
  { expected: "Redacted<string>" },
);

export class WorkerCredential extends Schema.Class<WorkerCredential>(
  "@usine/executor/WorkerCredential",
)({
  /**
   * The token for git and gh, never written inside the checkout. Wiped when the Attempt's scope
   * closes; `Redacted.value` then throws.
   */
  value: IssuedToken,
  /** A new credential is requested when five minutes or less remain. */
  expiresAt: Schema.DateTimeUtc,
}) {}

export class CredentialProvider extends Context.Service<
  CredentialProvider,
  {
    /**
     * Returns a credential for `repository` only, with `permissions` (`read` can't push). The local
     * and SSH executors call it during `prepare` and again before each expiry until the Attempt's
     * resources are released; a failed renewal is logged and retried after 30 seconds.
     */
    readonly issue: (
      repository: RepositoryName,
      attemptId: AttemptId,
      permissions: LoopPermissions,
    ) => Effect.Effect<WorkerCredential, CredentialUnavailableError>;
  }
>()("@usine/executor/CredentialProvider") {}

/** The service that prepares checkouts, runs Attempts on a Worker, and releases their resources (ADR 0006). */
export class Executor extends Context.Service<
  Executor,
  {
    /**
     * Reconciles the checkout of an Attempt that no Run reattaches, recording its salvage before
     * releasing any work, even if `isLive` returns true. First stops the parent task if durable
     * storage marks it live; if the task can't be confirmed stopped, fails with a `cancel`
     * `ExecutorOperationError` and leaves the checkout. For an open Attempt whose parent task
     * failed before the orchestrator stopped, first records the comments it posted on the Run's
     * Item. `commitAuthor` returns the author and committer of the salvage commit, like
     * `CheckoutRequest.commitAuthor`. It runs only before a salvage, and its failure leaves the
     * checkout.
     */
    readonly recover: <E, A>(
      attempt: AttemptRecovery,
      record: RecoverySink<E>,
      commitAuthor: Effect.Effect<BotAccount, A>,
    ) => Effect.Effect<void, E | A | ExecutorError>;
    /** The orchestrator doesn't start if a configured Worker has a different kind. */
    readonly kind: WorkerKind;
    /**
     * Returns whether the parent task is still running, or reported success before its checkout
     * was harvested. If true, the orchestrator reattaches after a restart.
     */
    readonly isLive: (attemptId: AttemptId) => Effect.Effect<boolean, AttemptFailure>;
    /**
     * Returns the result a finished parent task stored before an orchestrator restart: the
     * harvested result or the parent's failure. Returns `None` if nothing is stored or `isLive` is
     * true.
     */
    readonly outcome: (
      attemptId: AttemptId,
    ) => Effect.Effect<Option.Option<Result.Result<StepResult, AttemptFailure>>, AttemptFailure>;
    /**
     * Verifies Git, enough memory for `maxConcurrentAttempts` concurrent Attempts, and each brain
     * in `brains`. Never installs tools or logs in; an SSH Worker pulls its Attempt image.
     */
    readonly preflight: (
      worker: WorkerName,
      brains: ReadonlyArray<BrainSpec>,
      maxConcurrentAttempts: number,
    ) => Effect.Effect<PreflightReport, ExecutorError>;
    /**
     * Verifies the Agent's brain, then acquires the checkout and credential in the caller's scope.
     * Clone, fetch, and lock waits are interruptible; on failure, releases everything acquired so
     * far. `attemptId` must be new unless `reattach` is set.
     */
    readonly prepare: (
      request: CheckoutRequest,
    ) => Effect.Effect<PreparedAttempt, ExecutorError, Scope.Scope>;
    /**
     * Stops preparation and releases partial resources, or cancels the live parent task with a
     * grace period before forced termination, including one not reattached after a restart.
     * `reason` is why the engine stops the task, which the executor logs. Fails if the parent task
     * can't be confirmed stopped. A canceled Attempt can't launch.
     *
     * An Attempt whose launch ended without a confirmed stop keeps its checkout on disk. Once a
     * later call confirms the stop, it salvages and removes that checkout, as `recover` does, and
     * logs a failure without failing.
     */
    readonly cancel: (
      attemptId: AttemptId,
      reason: StopReason,
    ) => Effect.Effect<void, ExecutorError>;
    /** Sends an operator intervention to the Attempt's live session. */
    readonly intervene: (
      attemptId: AttemptId,
      intervention: AttemptChannel.Intervention,
    ) => Effect.Effect<void, AttemptFailure>;
    /**
     * Removes the files on the Workers that no Attempt holds or can use, such as the Codex home
     * of an Attempt without a checkout on an SSH Worker, which a crash or a failed cleanup left.
     * Run it after startup recovery, which keeps the checkouts of Attempts that a Run may
     * reattach. Never fails; logs what it couldn't remove.
     */
    readonly sweep: Effect.Effect<void>;
  }
>()("@usine/executor/Executor") {}

/** The executor's hold on one provisioned machine, which `WorkerMachines.release` ends. */
export const MachineHold = Schema.NonEmptyString.pipe(Schema.brand("MachineHold"));
export type MachineHold = typeof MachineHold.Type;

/** The machine preflight of a provisioned Worker's first machine each day. */
export class MachineCheck extends Schema.Class<MachineCheck>("@usine/executor/MachineCheck")({
  brains: Schema.Array(BrainSpec),
  /**
   * The limits of each Attempt container that the Worker's machines get until the next check,
   * or `None` if the machine has no Docker.
   */
  containerLimits: Schema.Option(ContainerLimits),
}) {}

/** A machine that a provisioned Worker created for an Attempt and holds until `release`. */
export class MachineGrant extends Schema.Class<MachineGrant>("@usine/executor/MachineGrant")({
  hold: MachineHold,
  id: MachineId,
  worker: WorkerName,
  provider: MachineProvider,
  /** The check that this machine got as the Worker's first each day, or `None` if it got none. */
  checked: Schema.Option(MachineCheck),
}) {}

/**
 * `creating` until the machine answers over SSH, `ready` while an Attempt holds it, and
 * `deleting` until its deletion succeeds.
 */
export const MachineState = Schema.Literals(["creating", "ready", "deleting"]);
export type MachineState = typeof MachineState.Type;

/** A machine in flight on a provisioned Worker. */
export class MachineStatus extends Schema.Class<MachineStatus>("@usine/executor/MachineStatus")({
  worker: WorkerName,
  provider: MachineProvider,
  state: MachineState,
  /** `None` until the provider accepts the creation. */
  id: Schema.Option(MachineId),
  /** The Run the machine was created for, or `None` for a machine found after a restart. */
  runId: Schema.Option(RunId),
  attemptId: Schema.Option(AttemptId),
  /** When the creation started, or when the provider created a machine found after a restart. */
  since: Schema.DateTimeUtc,
}) {}

/**
 * The machines of the provisioned Workers, which create one machine per Attempt and delete it
 * afterwards (#550). Only the SSH executor provides it.
 */
export class WorkerMachines extends Context.Service<
  WorkerMachines,
  {
    /** Returns whether `worker` creates a machine for each Attempt. */
    readonly provisions: (worker: WorkerName) => Effect.Effect<boolean>;
    /**
     * Creates a machine on `worker` for the persisted `attemptId`, labeled with the instance,
     * Worker, Run, and Attempt, and waits until it answers over SSH. The first machine after the configured
     * check interval also gets the preflight checks of `brains`, whose failure is a `WorkerCapabilityError`.
     * On failure or interruption, deletes the machine.
     */
    readonly create: (
      worker: WorkerName,
      runId: RunId,
      attemptId: AttemptId,
      brains: ReadonlyArray<BrainSpec>,
    ) => Effect.Effect<MachineGrant, MachineUnavailableError | WorkerCapabilityError>;
    /**
     * Holds the machine of `attemptId`, an Attempt from before a restart on `worker`, until
     * `release`. Returns `None` if `worker` isn't provisioned or the provider no longer lists the
     * machine. If the provider can't be read, the hold keeps a `sweep` from deleting the machine,
     * and a later use looks it up again.
     */
    readonly adopt: (
      worker: WorkerName,
      attemptId: AttemptId,
    ) => Effect.Effect<Option.Option<MachineHold>>;
    /** Deletes the held machine. Logs a failure, and each `sweep` tries again. */
    readonly release: (hold: MachineHold) => Effect.Effect<void>;
    /**
     * Lists each provisioned Worker's machines at its provider and deletes those that no
     * Attempt or creation in this process holds. Run it after startup recovery, which adopts or
     * reconciles the machines of earlier Attempts.
     */
    readonly sweep: Effect.Effect<void>;
    /** The machines in flight, oldest first. */
    readonly machines: Effect.Effect<ReadonlyArray<MachineStatus>>;
  }
>()("@usine/executor/WorkerMachines") {}

export { claudeLoginLockLayer } from "./claude-login-lock.ts";
