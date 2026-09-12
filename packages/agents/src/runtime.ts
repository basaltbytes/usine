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

/** The Attempt's task and Agent choices, together with the prepared checkout where its parent starts. */
export class LaunchRequest extends Schema.Class<LaunchRequest>("@usine/agents/LaunchRequest")({
  spec: AttemptChannel.RunSpec,
  cwd: WorkingDirectory,
}) {}

/** Work delegated to one child, with its assigned identity and the checkout it shares with the parent. */
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

/** A session could not start, continue, or finish its work; the failure determines whether retry needs an operator. */
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

/** A live parent or child session whose activity can be observed while its work continues. */
export interface RunningSession {
  readonly session: AgentSession;
  /** Activity to record in the Attempt transcript while waiting for the result. */
  readonly events: Stream.Stream<AgentSessionEvent, AgentSessionError>;
  /** Waits for the final message or the failure that ends this session's work. */
  readonly result: Effect.Effect<SessionResult, AgentSessionError>;
  /** Adds operator guidance to the running session without creating a new Attempt. */
  readonly steer: (message: string) => Effect.Effect<void, AgentSessionError>;
  /** Requests that this session stop its current work. */
  readonly interrupt: Effect.Effect<void, AgentSessionError>;
}

/**
 * Records each live child session so the run host can route operator input
 * (steer, interrupt, or a takeover message) to one by the id it reports in the
 * normalized event stream. The parent registers no child; it is addressed
 * directly. Registration is scoped: the entry is removed when the child's scope
 * closes, so a returned child is no longer addressable (ADR 0018).
 */
export interface ChildSessions {
  readonly register: (session: RunningSession) => Effect.Effect<void, never, Scope.Scope>;
}

/** Launches coding sessions for tasks delegated by an Attempt's parent. */
export interface ChildBackendService {
  /** Starts the assigned child and returns its controls; its result is awaited separately. */
  readonly launch: (
    request: ChildRequest,
  ) => Effect.Effect<RunningSession, AgentSessionError, Scope.Scope>;
}

/** Runs the coding work delegated by an Attempt's parent. */
export class ChildBackend extends Context.Service<ChildBackend, ChildBackendService>()(
  "@usine/agents/ChildBackend",
) {}

/** Runs delegated coding work with Claude Code. */
export class ClaudeChildBackend extends Context.Service<ClaudeChildBackend, ChildBackendService>()(
  "@usine/agents/ClaudeChildBackend",
) {}

/** Runs delegated coding work with Codex. */
export class CodexChildBackend extends Context.Service<CodexChildBackend, ChildBackendService>()(
  "@usine/agents/CodexChildBackend",
) {}

/** Runs delegated coding work with Pi. */
export class PiChildBackend extends Context.Service<PiChildBackend, ChildBackendService>()(
  "@usine/agents/PiChildBackend",
) {}

/** Starts the parent that coordinates one Attempt's task and delegates coding work to children. */
export class AgentRuntime extends Context.Service<
  AgentRuntime,
  {
    /**
     * Starts work in the prepared checkout and returns controls for observing and
     * guiding the parent. Each child it spawns registers with `children` so the
     * run host can address a takeover to it by id.
     */
    readonly launch: (
      request: LaunchRequest,
      children: ChildSessions,
    ) => Effect.Effect<RunningSession, AgentSessionError, Scope.Scope>;
  }
>()("@usine/agents/AgentRuntime") {}
