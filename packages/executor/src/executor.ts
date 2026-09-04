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

/** @usine/executor — platform-free worker execution contract. */

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
  "run-host",
  "harness-login",
  "credentials",
]);
export type WorkerCapability = typeof WorkerCapability.Type;

export class ExecutorOperationError extends Schema.TaggedError<ExecutorOperationError>(
  "@usine/executor/ExecutorOperationError",
)("ExecutorOperationError", {
  operation: ExecutorOperation,
  message: Schema.NonEmptyString,
  cause: Schema.Defect(),
}) {}

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

/** Everything prepare needs for one fresh Attempt workspace; credentials are never part of it. */
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

/** What prepare returns and launch consumes; credentials stay private to the adapter. */
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

/** The five-operation worker contract (ADR 0006). Preflight verifies only; it never installs. */
export class Executor extends Context.Service<
  Executor,
  {
    readonly kind: WorkerKind;
    readonly preflight: (worker: WorkerName) => Effect.Effect<void, ExecutorError>;
    readonly prepare: (request: CheckoutRequest) => Effect.Effect<PreparedAttempt, ExecutorError>;
    readonly launch: (
      prepared: PreparedAttempt,
      io: AttemptChannel.Sink,
    ) => Effect.Effect<StepResult, AttemptFailure>;
    readonly cancel: (attemptId: AttemptId) => Effect.Effect<void, ExecutorError>;
    readonly cleanup: (prepared: PreparedAttempt) => Effect.Effect<void, ExecutorError>;
  }
>()("@usine/executor/Executor") {}
