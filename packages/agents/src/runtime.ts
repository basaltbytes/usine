import { Agent, AttemptChannel, AttemptFailure } from "@usine/core";
import { Context, Effect, Match, Schema, Scope, Stream } from "effect";

/** Value object: process-local working directory for one isolated Attempt. */
export const WorkingDirectory = Schema.NonEmptyString.pipe(Schema.brand("AgentWorkingDirectory"));
export type WorkingDirectory = typeof WorkingDirectory.Type;

/** Complete input required to start the Pi parent inside one Attempt checkout. */
export class LaunchRequest extends Schema.Class<LaunchRequest>("@usine/agents/LaunchRequest")({
  spec: AttemptChannel.RunSpec,
  cwd: WorkingDirectory,
}) {}

/** Complete input for exactly one first-level child session. */
export class ChildRequest extends Schema.Class<ChildRequest>("@usine/agents/ChildRequest")({
  session: Agent.ChildSession,
  cwd: WorkingDirectory,
  prompt: Schema.NonEmptyString,
}) {}

/** Terminal semantic output from a parent or child SDK session. */
export class SessionResult extends Schema.Class<SessionResult>("@usine/agents/SessionResult")({
  message: Schema.NonEmptyString,
}) {}

/** The configured vendor model id is well-formed but absent from the selected SDK registry. */
export class UnknownModelError extends Schema.TaggedError<UnknownModelError>(
  "@usine/agents/UnknownModelError",
)("UnknownModelError", {
  harness: Agent.Harness,
  model: Agent.ModelId,
  message: Schema.NonEmptyString,
}) {}

/** The roster names a valid usine harness that this backend does not implement. */
export class UnsupportedHarnessError extends Schema.TaggedError<UnsupportedHarnessError>(
  "@usine/agents/UnsupportedHarnessError",
)("UnsupportedHarnessError", {
  harness: Agent.Harness,
  message: Schema.NonEmptyString,
}) {}

/** The session ran to a terminal state and reported that the work itself failed. */
export class AgentResultError extends Schema.TaggedError<AgentResultError>(
  "@usine/agents/AgentResultError",
)("AgentResultError", {
  sessionId: Schema.OptionFromNullOr(Agent.SessionId),
  message: Schema.NonEmptyString,
}) {}

export const SESSION_OPERATIONS = ["launch", "stream", "steer", "interrupt"] as const;
export const SessionOperation = Schema.Literals(SESSION_OPERATIONS);
export type SessionOperation = typeof SessionOperation.Type;

/** SDK/process failure after model and harness validation. */
export class SessionOperationError extends Schema.TaggedError<SessionOperationError>(
  "@usine/agents/SessionOperationError",
)("SessionOperationError", {
  operation: SessionOperation,
  sessionId: Schema.OptionFromNullOr(Agent.SessionId),
  message: Schema.NonEmptyString,
  cause: Schema.Defect(),
}) {}

export const AgentSessionError = Schema.Union([
  UnknownModelError,
  UnsupportedHarnessError,
  AgentResultError,
  SessionOperationError,
]);
export type AgentSessionError = typeof AgentSessionError.Type;

/**
 * The one place the session error union meets the ADR 0002 retry taxonomy:
 * SDK/process trouble is retryable infrastructure; a bad roster spec or the
 * agent failing its own work always waits for the operator.
 */
export const toAttemptFailure = (error: AgentSessionError): AttemptFailure.AttemptFailure =>
  Match.valueTags(error, {
    SessionOperationError: (operation) =>
      new AttemptFailure.InfraFailure({ message: operation.message, cause: operation.cause }),
    UnknownModelError: ({ message }) => new AttemptFailure.AgentFailure({ message }),
    UnsupportedHarnessError: ({ message }) => new AttemptFailure.AgentFailure({ message }),
    AgentResultError: ({ message }) => new AttemptFailure.AgentFailure({ message }),
  });

/** Live SDK session. Its event stream and controls are backend-independent. */
export interface RunningSession {
  readonly events: Stream.Stream<Agent.SessionEvent, AgentSessionError>;
  readonly result: Effect.Effect<SessionResult, AgentSessionError>;
  readonly steer: (message: string) => Effect.Effect<void, AgentSessionError>;
  readonly interrupt: Effect.Effect<void, AgentSessionError>;
}

/** Stable first-level child seam implemented initially by the Claude Agent SDK. */
export class ChildBackend extends Context.Service<
  ChildBackend,
  {
    readonly launch: (
      request: ChildRequest,
    ) => Effect.Effect<RunningSession, AgentSessionError, Scope.Scope>;
  }
>()("@usine/agents/ChildBackend") {}

/** Stable parent seam consumed by the run host. */
export class AgentRuntime extends Context.Service<
  AgentRuntime,
  {
    readonly launch: (
      request: LaunchRequest,
    ) => Effect.Effect<RunningSession, AgentSessionError, Scope.Scope>;
  }
>()("@usine/agents/AgentRuntime") {}
