import type { AttemptRecovery, AttemptSalvage } from "@usine/core/attempt/salvage";
import { Agent } from "@usine/core/agent";
import { BrainSpec, Effort, ModelId } from "@usine/core/agent/brain";
import { ChildSessionBudget } from "@usine/core/agent/session";
import { AttemptTask, AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AttemptFailure } from "@usine/core/attempt/failure";
import { LoopName, LoopPermissions } from "@usine/core/loop";
import { SalvagePushed, SalvageRef } from "@usine/core/attempt/salvage";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { WorkerName, WorkerKind } from "@usine/core/worker";
import { StepResult } from "@usine/core/step/result";
import { Context, Effect, type Option, type Result, Schema, Scope } from "effect";

/** The Worker operation that failed during readiness checks or an Attempt's lifecycle. */
export const ExecutorOperation = Schema.Literals([
  "preflight",
  "prepare",
  "launch",
  "cancel",
  "cleanup",
]);
export type ExecutorOperation = typeof ExecutorOperation.Type;

/**
 * A prerequisite a Worker must satisfy before it can accept Attempts.
 * `memory` is enough memory on the Worker's machine for its concurrent
 * Attempts. `gateway` is the Gateway in front of the Worker's machine: its
 * admin API answers the orchestrator, and the machine reaches it.
 */
export const WorkerCapability = Schema.Literals([
  "machine",
  "toolchain",
  "memory",
  "harness-login",
  "credentials",
  "gateway",
]);
export type WorkerCapability = typeof WorkerCapability.Type;

/** A Worker operation failed before its requested work completed. */
export class ExecutorOperationError extends Schema.TaggedError<ExecutorOperationError>(
  "@usine/executor/ExecutorOperationError",
)("ExecutorOperationError", {
  /**
   * The operation that failed. `cleanup` covers removing a checkout, its
   * credential, or the credentials an earlier process left on a Worker.
   */
  operation: ExecutorOperation,
  /**
   * A summary for operators, such as the command that exited non-zero. The
   * error has no Worker field, so a caller that reports it names the Worker
   * itself. The wording is not part of the contract: callers branch on `operation`.
   */
  message: Schema.NonEmptyString,
  /** The underlying failure, for example an `Error` holding a command's standard error, or a timeout. */
  cause: Schema.Defect(),
}) {}

/** A Worker could not obtain access to the repository assigned to an Attempt. */
export class CredentialUnavailableError extends Schema.TaggedError<CredentialUnavailableError>(
  "@usine/executor/CredentialUnavailableError",
)("CredentialUnavailableError", {
  /** The repository the Attempt needed access to. */
  repository: RepositoryName,
  /**
   * A summary for operators, such as a GitHub App installation that does not
   * cover the repository, or an exe.dev Worker with no GitHub integration for it.
   */
  message: Schema.NonEmptyString,
  /** The underlying failure, for example the GitHub API error returned while minting the token. */
  cause: Schema.Defect(),
}) {}

/** A verify-only preflight found a Worker capability missing or incompatible. */
export class WorkerCapabilityError extends Schema.TaggedError<WorkerCapabilityError>(
  "@usine/executor/WorkerCapabilityError",
)("WorkerCapabilityError", {
  /** The Worker that lacks the capability. */
  worker: WorkerName,
  /**
   * The missing prerequisite. `machine`: the machine or VM is absent, stopped,
   * or unreachable, or its Worker directory is not writable. `toolchain`: Git or a brain's
   * harness does not run. `memory`: the machine has less than 1.5 GiB of memory per
   * concurrent Attempt, has no swap for more than one, or does not report its memory.
   * `harness-login`: a brain's harness is not logged in. `credentials`: an exe.dev
   * GitHub integration is not ready, or the Worker kind cannot give an Attempt of a
   * Loop with `permissions: read` access that cannot push. `gateway`: the Gateway in front of the machine
   * does not answer or is not reachable from it.
   */
  capability: WorkerCapability,
  /** A summary for operators of the check that failed. */
  message: Schema.NonEmptyString,
  /** What the check observed, for example the unrecognized `git --version` output or the harness's readiness report. */
  cause: Schema.Defect(),
}) {}

/** A readiness, access, or lifecycle failure reported by a Worker operation. */
export const ExecutorError = Schema.Union([
  ExecutorOperationError,
  CredentialUnavailableError,
  WorkerCapabilityError,
]);
export type ExecutorError = typeof ExecutorError.Type;

/** Logs every preflight refusal so a missing capability is explainable from logs alone. */
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

/** The repository, revision, and Agent task assigned to a Worker for one Attempt's checkout. */
export class CheckoutRequest extends Schema.Class<CheckoutRequest>(
  "@usine/executor/CheckoutRequest",
)({
  /**
   * The Attempt this checkout is for. It names the checkout directory, and
   * `cancel`, `intervene`, `isLive`, and `outcome` find the Attempt by it.
   */
  attemptId: AttemptId,
  /** The Worker that prepares the checkout and runs the Attempt's children. */
  worker: WorkerName,
  /**
   * The GitHub repository to check out. The Attempt's credential gives access to
   * this repository only (ADR 0011).
   */
  repository: RepositoryName,
  /** The Loop that opened the Attempt's Run. A `read` checkout's pre-push hook names it in its message. */
  loop: LoopName,
  /**
   * What the Attempt may do to `repository` (ADR 0011). With `read`, its
   * credential cannot push, and a Worker kind that cannot give it such a
   * credential refuses it with a `credentials` capability error. Its
   * checkout's pre-push hook tells the Agent why a push fails, and an
   * unsuccessful end removes the checkout without salvage.
   */
  permissions: LoopPermissions,
  /**
   * What to fetch. Preparation resolves it to a commit, which becomes the
   * RunSpec's `baseCommit`, so a branch that moves later does not change the checkout.
   */
  revision: RepositoryRevision,
  /** The payload of the event that triggered the Run. The parent's prompt includes it as JSON. */
  payload: Schema.Json,
  /** The task text the parent receives, after Loop interpolation or an operator's amendment. */
  task: AttemptTask,
  /**
   * The rostered Agent that runs the Attempt. Its persona and name go into the
   * parent's prompt, and its brain runs the children. Preparation verifies that
   * brain on the Worker first.
   */
  agent: Agent,
  /**
   * The model for the Pi parent. When none is given, the parent uses the
   * configured default model, then the first model with a credential. A model
   * that Pi does not know fails the launch.
   */
  parentModel: Schema.Option(ModelId),
  /**
   * The most child sessions the parent may start over the Attempt's lifetime.
   * The next one fails the Attempt with a `ChildSessionBudgetFailure`.
   */
  maxChildren: ChildSessionBudget,
  /** Maximum minutes of live Attempt execution, or none for no timer; preparation and resource cleanup are outside this budget. */
  maxAttemptMinutes: Schema.Option(Schema.Int.check(Schema.isGreaterThan(0))),
  /** Maximum consumed tokens across the parent and every child, or none for no token ceiling; operator Holds never pause this ceiling. */
  maxAttemptTokens: Schema.Option(Schema.Int.check(Schema.isGreaterThan(0))),
  /** The reasoning effort of the Pi parent. The launch fails if the parent's model does not support it. */
  parentEffort: Effort,
  /** Where the Worker pushes this Attempt's unfinished work if the Attempt ends without success. */
  salvageRef: SalvageRef,
  /** The previous Attempt's pushed salvage to check out instead of the bare revision. */
  resume: Schema.Option(SalvagePushed),
  /**
   * The Attempt outlived an orchestrator restart and its parent task is still
   * live: preparation takes over the checkout it already has instead of
   * creating one, and launch reattaches to the running parent.
   */
  reattach: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false))),
}) {}

/** One Attempt's disposable checkout directory. */
export const WorktreePath = Schema.NonEmptyString.pipe(Schema.brand("WorktreePath"));
export type WorktreePath = typeof WorktreePath.Type;

/** The serializable location and RunSpec of an Attempt checkout. Owning this record does not grant access to live resources or credentials. */
export class AttemptWorkspace extends Schema.Class<AttemptWorkspace>(
  "@usine/executor/AttemptWorkspace",
)({
  /** The Worker whose machine holds the checkout. */
  worker: WorkerName,
  /**
   * What the Attempt's parent launches with: the request's fields plus the
   * commit that preparation resolved the revision to.
   */
  spec: AttemptChannel.RunSpec,
  /** The checkout's path on the Worker's machine. The parent's children run in it. */
  worktree: WorktreePath,
}) {}

/**
 * One prepared Attempt with a scoped checkout and repository access. Use it within
 * the scope that prepared it. Closing that scope stops any active session before
 * removing the checkout and releasing credentials, including when launch never starts.
 */
export interface PreparedAttempt {
  /** Checkout metadata suitable for inspection or serialization; contains no credentials. */
  readonly workspace: AttemptWorkspace;
  /**
   * Runs this Attempt once, recording channel activity through `io`. Completion,
   * failure, or interruption releases its resources before returning. Cleanup
   * failures are logged without replacing the agent's outcome or retrying its work.
   * Reusing an Attempt after launch or release fails with an infrastructure error.
   */
  readonly launch: (io: AttemptChannel.Sink) => Effect.Effect<StepResult, AttemptFailure>;
}

/** A repository-scoped Worker credential and the instant at which it stops authorizing requests. */
export class WorkerCredential extends Schema.Class<WorkerCredential>(
  "@usine/executor/WorkerCredential",
)({
  /**
   * The token that git and gh authenticate with. The executor never writes it
   * inside the checkout. When the Attempt's scope closes, it removes the token
   * from this `Redacted` wrapper, so `Redacted.value` on it throws from then on.
   */
  value: Schema.Redacted(Schema.String),
  /** When the token stops working. The executor requests a new credential once five minutes or fewer remain. */
  expiresAt: Schema.DateTimeUtc,
}) {}

/** Mints renewable repository-scoped credentials for an Attempt. */
export class CredentialProvider extends Context.Service<
  CredentialProvider,
  {
    /**
     * Returns a new credential for `repository` only, at the level of the
     * Attempt's Loop `permissions`: a `read` credential cannot push. The local
     * and SSH executors call it when preparing the Attempt `attemptId`, then
     * again before each credential expires, until the Attempt's resources are
     * released. A failure during preparation fails `prepare`. A failed renewal
     * is logged and tried again 30 seconds later.
     */
    readonly issue: (
      repository: RepositoryName,
      attemptId: AttemptId,
      permissions: LoopPermissions,
    ) => Effect.Effect<WorkerCredential, CredentialUnavailableError>;
  }
>()("@usine/executor/CredentialProvider") {}

/** Prepares isolated checkouts, runs Attempts on a Worker, and releases their resources (ADR 0006). */
export class Executor extends Context.Service<
  Executor,
  {
    /** Reconciles an old checkout before new Attempts start; records its salvage before releasing any work. */
    readonly recover: <E>(
      attempt: AttemptRecovery,
      record: (salvage: AttemptSalvage) => Effect.Effect<void, E>,
    ) => Effect.Effect<void, E | ExecutorError>;
    /**
     * The kind of Worker this executor runs Attempts on. Each executor serves one
     * kind, and the orchestrator does not start when a configured Worker has another.
     */
    readonly kind: WorkerKind;
    /**
     * Whether the orchestrator can reattach to the Attempt's parent task after a restart: the
     * task is still running, or it reported success before the executor harvested its checkout.
     */
    readonly isLive: (attemptId: AttemptId) => Effect.Effect<boolean, AttemptFailure>;
    /**
     * The result that an Attempt's finished parent task wrote to durable storage before an
     * orchestrator restart: the harvested result, or the parent's failure. None when
     * nothing is stored, or when `isLive` returns true and the orchestrator reattaches instead.
     */
    readonly outcome: (
      attemptId: AttemptId,
    ) => Effect.Effect<Option.Option<Result.Result<StepResult, AttemptFailure>>, AttemptFailure>;
    /**
     * Verifies Git, that the Worker's machine has the memory to run
     * `maxConcurrentAttempts` Attempts at the same time, and each rostered
     * brain where the Worker runs children; never installs tools or logs in.
     */
    readonly preflight: (
      worker: WorkerName,
      brains: ReadonlyArray<BrainSpec>,
      maxConcurrentAttempts: number,
    ) => Effect.Effect<void, ExecutorError>;
    /**
     * Verifies the assigned brain before acquiring the Attempt in the caller's scope. Clone, fetch, and lock waits
     * remain interruptible; partial preparation releases everything already acquired
     * before reporting failure. Each request identifies a fresh Attempt, or a live one
     * to reattach when `reattach` is set.
     */
    readonly prepare: (
      request: CheckoutRequest,
    ) => Effect.Effect<PreparedAttempt, ExecutorError, Scope.Scope>;
    /**
     * Stops preparation and releases partial resources, or cancels the live
     * parent task with a grace period before forced termination. A canceled prepared Attempt
     * cannot launch. Repeated cancellation after release is a no-op.
     */
    readonly cancel: (attemptId: AttemptId) => Effect.Effect<void, ExecutorError>;
    /** Delivers an attributed operator action to the active Attempt's live session. */
    readonly intervene: (
      attemptId: AttemptId,
      intervention: AttemptChannel.Intervention,
    ) => Effect.Effect<void, AttemptFailure>;
  }
>()("@usine/executor/Executor") {}
