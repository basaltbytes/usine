import { Agent } from "@usine/core/agent";
import { Effort, ModelId } from "@usine/core/agent/brain";
import { ChildSessionBudget } from "@usine/core/agent/session";
import { AttemptTask, AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AttemptFailure } from "@usine/core/attempt/failure";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { WorkerName, WorkerKind } from "@usine/core/worker";
import { StepResult } from "@usine/core/step/result";
import { Context, Effect, Redacted, Schema } from "effect";

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
  parentEffort: Effort,
}) {}

/** One Attempt's disposable checkout directory. */
export const WorktreePath = Schema.NonEmptyString.pipe(Schema.brand("WorktreePath"));
export type WorktreePath = typeof WorktreePath.Type;

/** A prepared Attempt checkout ready to launch on its assigned Worker; credentials stay with the adapter. */
export class PreparedAttempt extends Schema.Class<PreparedAttempt>(
  "@usine/executor/PreparedAttempt",
)({
  worker: WorkerName,
  spec: AttemptChannel.RunSpec,
  worktree: WorktreePath,
}) {}

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
    /** Fetches the requested revision and prepares an isolated checkout; successful preparation requires eventual cleanup. */
    readonly prepare: (request: CheckoutRequest) => Effect.Effect<PreparedAttempt, ExecutorError>;
    /** Runs the prepared Attempt, persists channel activity through `io`, and waits for its result or failure. */
    readonly launch: (
      prepared: PreparedAttempt,
      io: AttemptChannel.Sink,
    ) => Effect.Effect<StepResult, AttemptFailure>;
    /** Requests an active Attempt to stop, allowing a grace period before forcing termination. */
    readonly cancel: (attemptId: AttemptId) => Effect.Effect<void, ExecutorError>;
    /** Removes the Attempt's checkout and releases its resources after any outcome. */
    readonly cleanup: (prepared: PreparedAttempt) => Effect.Effect<void, ExecutorError>;
  }
>()("@usine/executor/Executor") {}
