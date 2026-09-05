import { Agent } from "@usine/core/agent";
import { Effort, ModelId } from "@usine/core/agent/brain";
import { ChildSessionBudget } from "@usine/core/agent/session";
import { AttemptTask, AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AttemptFailure } from "@usine/core/attempt/failure";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { WorkerName, WorkerKind } from "@usine/core/worker";
import { StepResult } from "@usine/core/step/result";
import { Context, Effect, Redacted, Schema, Scope } from "effect";

/** The Worker operation that failed during readiness checks or an Attempt's lifecycle. */
export const ExecutorOperation = Schema.Literals([
  "preflight",
  "prepare",
  "launch",
  "cancel",
  "cleanup",
]);
export type ExecutorOperation = typeof ExecutorOperation.Type;

/** A prerequisite a Worker must satisfy before it can accept Attempts. */
export const WorkerCapability = Schema.Literals([
  "machine",
  "toolchain",
  "run-host",
  "harness-login",
  "credentials",
]);
export type WorkerCapability = typeof WorkerCapability.Type;

/** A Worker operation failed before its requested work completed. */
export class ExecutorOperationError extends Schema.TaggedError<ExecutorOperationError>(
  "@usine/executor/ExecutorOperationError",
)("ExecutorOperationError", {
  operation: ExecutorOperation,
  message: Schema.NonEmptyString,
  cause: Schema.Defect(),
}) {}

/** A Worker could not obtain access to the repository assigned to an Attempt. */
export class CredentialUnavailableError extends Schema.TaggedError<CredentialUnavailableError>(
  "@usine/executor/CredentialUnavailableError",
)("CredentialUnavailableError", {
  repository: RepositoryName,
  message: Schema.NonEmptyString,
  cause: Schema.Defect(),
}) {}

/** A verify-only preflight found a Worker capability missing or incompatible. */
export class WorkerCapabilityError extends Schema.TaggedError<WorkerCapabilityError>(
  "@usine/executor/WorkerCapabilityError",
)("WorkerCapabilityError", {
  worker: WorkerName,
  capability: WorkerCapability,
  message: Schema.NonEmptyString,
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

/** Process command for a one-shot run host or a preflight capability probe. */
export interface RunHostCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/** The repository, revision, and Agent task assigned to a Worker for one fresh Attempt checkout. */
export class CheckoutRequest extends Schema.Class<CheckoutRequest>(
  "@usine/executor/CheckoutRequest",
)({
  attemptId: AttemptId,
  worker: WorkerName,
  repository: RepositoryName,
  revision: RepositoryRevision,
  payload: Schema.Json,
  task: AttemptTask,
  agent: Agent,
  parentModel: Schema.Option(ModelId),
  maxChildren: ChildSessionBudget,
  /** Maximum minutes of live run-host execution; preparation and resource cleanup are outside this budget. */
  maxAttemptMinutes: Schema.Int.check(Schema.isGreaterThan(0)),
  parentEffort: Effort,
}) {}

/** One Attempt's disposable checkout directory. */
export const WorktreePath = Schema.NonEmptyString.pipe(Schema.brand("WorktreePath"));
export type WorktreePath = typeof WorktreePath.Type;

/** The serializable location and RunSpec of an Attempt checkout. Owning this record does not grant access to live resources or credentials. */
export class AttemptWorkspace extends Schema.Class<AttemptWorkspace>(
  "@usine/executor/AttemptWorkspace",
)({
  worker: WorkerName,
  spec: AttemptChannel.RunSpec,
  worktree: WorktreePath,
}) {}

/**
 * One prepared Attempt with a scoped checkout and repository access. Use it within
 * the scope that prepared it. Closing that scope stops any active run host before
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

/** Mints exactly one repository-scoped credential for each prepared Attempt. */
export class CredentialProvider extends Context.Service<
  CredentialProvider,
  {
    readonly issue: (
      repository: RepositoryName,
      attemptId: AttemptId,
    ) => Effect.Effect<Redacted.Redacted<string>, CredentialUnavailableError>;
  }
>()("@usine/executor/CredentialProvider") {}

/** Prepares isolated checkouts, runs Attempts on a Worker, and releases their resources (ADR 0006). */
export class Executor extends Context.Service<
  Executor,
  {
    readonly kind: WorkerKind;
    /** Verifies that a configured Worker is ready to accept work; never installs tools or logs in. */
    readonly preflight: (worker: WorkerName) => Effect.Effect<void, ExecutorError>;
    /**
     * Acquires a fresh Attempt in the caller's scope. Clone, fetch, and lock waits
     * remain interruptible; partial preparation releases everything already acquired
     * before reporting failure. Each request must identify a fresh Attempt.
     */
    readonly prepare: (
      request: CheckoutRequest,
    ) => Effect.Effect<PreparedAttempt, ExecutorError, Scope.Scope>;
    /** Requests an active Attempt to stop, allowing a grace period before forcing termination. */
    readonly cancel: (attemptId: AttemptId) => Effect.Effect<void, ExecutorError>;
  }
>()("@usine/executor/Executor") {}
