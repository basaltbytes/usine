/** @usine/executor — platform-free worker execution contract. */

import {
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

export const ExecutorError = Schema.Union([ExecutorOperationError, CredentialUnavailableError]);
export type ExecutorError = typeof ExecutorError.Type;

/** Secret-free request used to create one fresh Attempt workspace. */
export class CheckoutRequest extends Schema.Class<CheckoutRequest>(
  "@usine/executor/CheckoutRequest",
)({
  attemptId: Attempt.AttemptId,
  worker: Worker.Name,
  repository: Repository.Name,
  revision: Repository.Revision,
  task: AttemptChannel.Task,
}) {}

/** Prepared workspace descriptor. Credentials remain private to the adapter. */
export class PreparedAttempt extends Schema.Class<PreparedAttempt>(
  "@usine/executor/PreparedAttempt",
)({
  worker: Worker.Name,
  spec: AttemptChannel.RunSpec,
  worktree: Schema.NonEmptyString,
}) {}

export class PreflightReport extends Schema.Class<PreflightReport>(
  "@usine/executor/PreflightReport",
)({
  gitVersion: Schema.NonEmptyString,
  protocolVersion: Schema.Literal(AttemptChannel.PROTOCOL_VERSION),
}) {}

export interface ChannelIo {
  readonly append: (
    direction: AttemptChannel.Direction,
    envelope: AttemptChannel.Envelope,
  ) => Effect.Effect<void, AttemptFailure.AttemptFailure>;
}

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

/** The five-operation worker contract from ADR 0003. */
export class Executor extends Context.Service<
  Executor,
  {
    readonly preflight: (worker: Worker.Name) => Effect.Effect<PreflightReport, ExecutorError>;
    readonly prepare: (request: CheckoutRequest) => Effect.Effect<PreparedAttempt, ExecutorError>;
    readonly launch: (
      prepared: PreparedAttempt,
      io: ChannelIo,
    ) => Effect.Effect<StepResult.StepResult, AttemptFailure.AttemptFailure>;
    readonly cancel: (attemptId: Attempt.AttemptId) => Effect.Effect<void, ExecutorError>;
    readonly cleanup: (prepared: PreparedAttempt) => Effect.Effect<void, ExecutorError>;
  }
>()("@usine/executor/Executor") {}
