import { Effort, Harness, ModelId } from "@usine/core/agent/brain";
import {
  AgentSession,
  AgentSessionEvent,
  AgentSessionId,
  BillingPool,
  ChildSession,
  ChildSessionBudget,
  ChildSessionCount,
} from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import {
  AgentFailure,
  AttemptFailure,
  ChildSessionBudgetFailure,
  InfraFailure,
} from "@usine/core/attempt/failure";
import { Context, Effect, Match, Schema, Scope, Stream } from "effect";

/** The checkout directory one Attempt runs in. */
export const WorkingDirectory = Schema.NonEmptyString.pipe(Schema.brand("AgentWorkingDirectory"));
export type WorkingDirectory = typeof WorkingDirectory.Type;

export class LaunchRequest extends Schema.Class<LaunchRequest>("@usine/agents/LaunchRequest")({
  spec: AttemptChannel.RunSpec,
  cwd: WorkingDirectory,
}) {}

/** Starts one first-level child session; a child cannot request children of its own. */
export class ChildRequest extends Schema.Class<ChildRequest>("@usine/agents/ChildRequest")({
  session: ChildSession,
  cwd: WorkingDirectory,
  prompt: Schema.NonEmptyString,
}) {}

/** The final message a parent or child session returns. */
export class SessionResult extends Schema.Class<SessionResult>("@usine/agents/SessionResult")({
  message: Schema.NonEmptyString,
}) {}

/** The rostered model id is well-formed but the SDK's registry does not list it. */
export class UnknownModelError extends Schema.TaggedError<UnknownModelError>(
  "@usine/agents/UnknownModelError",
)("UnknownModelError", {
  harness: Harness,
  model: ModelId,
  message: Schema.NonEmptyString,
}) {}

/** The credential cannot spend from the billing pool this session needs. */
export class PoolUnavailableError extends Schema.TaggedError<PoolUnavailableError>(
  "@usine/agents/PoolUnavailableError",
)("PoolUnavailableError", {
  harness: Harness,
  model: ModelId,
  pool: BillingPool,
  message: Schema.NonEmptyString,
}) {}

/** The model exists but does not support the rostered reasoning effort. */
export class UnsupportedEffortError extends Schema.TaggedError<UnsupportedEffortError>(
  "@usine/agents/UnsupportedEffortError",
)("UnsupportedEffortError", {
  harness: Harness,
  model: ModelId,
  effort: Effort,
  message: Schema.NonEmptyString,
}) {}

/** The session finished and reported that the work itself failed. */
export class AgentResultError extends Schema.TaggedError<AgentResultError>(
  "@usine/agents/AgentResultError",
)("AgentResultError", {
  sessionId: Schema.OptionFromNullOr(AgentSessionId),
  message: Schema.NonEmptyString,
}) {}

/** The Pi parent asked for one more child than this Attempt's budget allows. */
export class ChildSessionBudgetExceededError extends Schema.TaggedError<ChildSessionBudgetExceededError>(
  "@usine/agents/ChildSessionBudgetExceededError",
)("ChildSessionBudgetExceededError", {
  maxChildren: ChildSessionBudget,
  attemptedChildren: ChildSessionCount,
  message: Schema.NonEmptyString,
}) {}

export const SESSION_OPERATIONS = ["launch", "stream", "steer", "interrupt"] as const;
export const SessionOperation = Schema.Literals(SESSION_OPERATIONS);
export type SessionOperation = typeof SessionOperation.Type;

/** The SDK or its process failed after the model and harness were validated. */
export class SessionOperationError extends Schema.TaggedError<SessionOperationError>(
  "@usine/agents/SessionOperationError",
)("SessionOperationError", {
  operation: SessionOperation,
  sessionId: Schema.OptionFromNullOr(AgentSessionId),
  message: Schema.NonEmptyString,
  cause: Schema.Defect(),
}) {}

export const AgentSessionError = Schema.Union([
  UnknownModelError,
  PoolUnavailableError,
  UnsupportedEffortError,
  AgentResultError,
  ChildSessionBudgetExceededError,
  SessionOperationError,
]);
export type AgentSessionError = typeof AgentSessionError.Type;

/**
 * Maps session errors onto the retry taxonomy: an SDK or process failure is
 * retryable infrastructure, while a bad roster spec or the agent failing its
 * own work waits for the operator (ADR 0002).
 */
export const toAttemptFailure = (error: AgentSessionError): AttemptFailure =>
  Match.valueTags(error, {
    SessionOperationError: (operation) =>
      new InfraFailure({ message: operation.message, cause: operation.cause }),
    UnknownModelError: ({ message }) => new AgentFailure({ message }),
    PoolUnavailableError: ({ message }) => new AgentFailure({ message }),
    UnsupportedEffortError: ({ message }) => new AgentFailure({ message }),
    AgentResultError: ({ message }) => new AgentFailure({ message }),
    ChildSessionBudgetExceededError: ({ attemptedChildren, maxChildren }) =>
      new ChildSessionBudgetFailure({ attemptedChildren, maxChildren }),
  });

/** A running session: the same event stream and controls whichever backend runs it. */
export interface RunningSession {
  readonly session: AgentSession;
  readonly events: Stream.Stream<AgentSessionEvent, AgentSessionError>;
  readonly result: Effect.Effect<SessionResult, AgentSessionError>;
  readonly steer: (message: string) => Effect.Effect<void, AgentSessionError>;
  readonly interrupt: Effect.Effect<void, AgentSessionError>;
}

export interface ChildBackendService {
  readonly launch: (
    request: ChildRequest,
  ) => Effect.Effect<RunningSession, AgentSessionError, Scope.Scope>;
}

/** Starts first-level child sessions; the dispatcher picks the implementation from the BrainSpec harness. */
export class ChildBackend extends Context.Service<ChildBackend, ChildBackendService>()(
  "@usine/agents/ChildBackend",
) {}

/** Claude child sessions; reached through the dispatcher, not directly. */
export class ClaudeChildBackend extends Context.Service<ClaudeChildBackend, ChildBackendService>()(
  "@usine/agents/ClaudeChildBackend",
) {}

/** Codex child sessions; reached through the dispatcher, not directly. */
export class CodexChildBackend extends Context.Service<CodexChildBackend, ChildBackendService>()(
  "@usine/agents/CodexChildBackend",
) {}

/** Pi child sessions; reached through the dispatcher, not directly. */
export class PiChildBackend extends Context.Service<PiChildBackend, ChildBackendService>()(
  "@usine/agents/PiChildBackend",
) {}

/** Launches the parent session for one Attempt; the run host calls it. */
export class AgentRuntime extends Context.Service<
  AgentRuntime,
  {
    readonly launch: (
      request: LaunchRequest,
    ) => Effect.Effect<RunningSession, AgentSessionError, Scope.Scope>;
  }
>()("@usine/agents/AgentRuntime") {}
