/** @usine/executor — platform-free worker execution contract. */

import {
  Agent,
  Attempt,
  AttemptChannel,
  AttemptFailure,
  Repository,
  StepResult,
  Worker,
} from "@usine/core";
import { Context, Effect, Redacted, Schema } from "effect";

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
  repository: Repository.Name,
  message: Schema.NonEmptyString,
  cause: Schema.Defect(),
}) {}

/** A verify-only preflight found a Worker capability missing or incompatible. */
export class WorkerCapabilityError extends Schema.TaggedError<WorkerCapabilityError>(
  "@usine/executor/WorkerCapabilityError",
)("WorkerCapabilityError", {
  worker: Worker.Name,
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

/** Every preflight refusal is logged: a missing capability must be explainable from logs alone. */
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

/** Secret-free request used to create one fresh Attempt workspace. */
export class CheckoutRequest extends Schema.Class<CheckoutRequest>(
  "@usine/executor/CheckoutRequest",
)({
  attemptId: Attempt.AttemptId,
  worker: Worker.Name,
  repository: Repository.Name,
  revision: Repository.Revision,
  payload: Schema.Json,
  task: AttemptChannel.Task,
  agent: Agent.Agent,
  parentModel: Schema.Option(Agent.ModelId),
  maxChildren: Agent.ChildSessionBudget,
}) {}

/** Value object (branded path): one Attempt's disposable checkout directory. */
export const WorktreePath = Schema.NonEmptyString.pipe(Schema.brand("WorktreePath"));
export type WorktreePath = typeof WorktreePath.Type;

/** Prepared workspace descriptor. Credentials remain private to the adapter. */
export class PreparedAttempt extends Schema.Class<PreparedAttempt>(
  "@usine/executor/PreparedAttempt",
)({
  worker: Worker.Name,
  spec: AttemptChannel.RunSpec,
  worktree: WorktreePath,
}) {}

/** Mints exactly one repository-scoped credential for each prepared Attempt. */
export class CredentialProvider extends Context.Service<
  CredentialProvider,
  {
    readonly issue: (
      repository: Repository.Name,
      attemptId: Attempt.AttemptId,
    ) => Effect.Effect<Redacted.Redacted<string>, CredentialUnavailableError>;
  }
>()("@usine/executor/CredentialProvider") {}

/** The five-operation worker contract from ADR 0006. Preflight verifies only — it never installs. */
export class Executor extends Context.Service<
  Executor,
  {
    readonly kind: Worker.Kind;
    readonly preflight: (worker: Worker.Name) => Effect.Effect<void, ExecutorError>;
    readonly prepare: (request: CheckoutRequest) => Effect.Effect<PreparedAttempt, ExecutorError>;
    readonly launch: (
      prepared: PreparedAttempt,
      io: AttemptChannel.Sink,
    ) => Effect.Effect<StepResult.StepResult, AttemptFailure.AttemptFailure>;
    readonly cancel: (attemptId: Attempt.AttemptId) => Effect.Effect<void, ExecutorError>;
    readonly cleanup: (prepared: PreparedAttempt) => Effect.Effect<void, ExecutorError>;
  }
>()("@usine/executor/Executor") {}
