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
import { BotAccount, BotLogin, WorkerName, WorkerKind } from "@usine/core/worker";
import { StepResult } from "@usine/core/step/result";
import { Context, Effect, Option, type Result, Schema, Scope } from "effect";

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
   */
  capability: WorkerCapability,
  message: Schema.NonEmptyString,
  /** The observed value, for example unrecognized `git --version` output or the harness readiness report. */
  cause: Schema.Defect(),
}) {}

export const ExecutorError = Schema.Union([
  ExecutorOperationError,
  CredentialUnavailableError,
  WorkerCapabilityError,
]);
export type ExecutorError = typeof ExecutorError.Type;

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

export class WorkerCredential extends Schema.Class<WorkerCredential>(
  "@usine/executor/WorkerCredential",
)({
  /**
   * The token for git and gh, never written inside the checkout. Wiped when the Attempt's scope
   * closes; `Redacted.value` then throws.
   */
  value: Schema.Redacted(Schema.String),
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
     * in `brains`. Never installs tools or logs in.
     */
    readonly preflight: (
      worker: WorkerName,
      brains: ReadonlyArray<BrainSpec>,
      maxConcurrentAttempts: number,
    ) => Effect.Effect<void, ExecutorError>;
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
  }
>()("@usine/executor/Executor") {}

export { claudeLoginLockLayer } from "./claude-login-lock.ts";
