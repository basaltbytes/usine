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
import { MachineId, WorkerName } from "@usine/core/worker";
import {
  AgentFailure,
  AttemptFailure,
  BlockedFailure,
  ChildSessionBudgetFailure,
  InfraFailure,
  QuestionFailure,
} from "@usine/core/attempt/failure";
import { Context, Effect, Match, Option, Schema, Scope, Stream } from "effect";
import { ChildHost } from "./child-host/child-host.ts";

/** The checkout directory of an Attempt. */
export const WorkingDirectory = Schema.NonEmptyString.pipe(Schema.brand("AgentWorkingDirectory"));
export type WorkingDirectory = typeof WorkingDirectory.Type;

/** A task delegated to one child, with its session and the checkout it shares with the parent. */
export class ChildRequest extends Schema.Class<ChildRequest>("@usine/agents/ChildRequest")({
  session: ChildSession,
  /** The checkout directory on `host`. */
  cwd: WorkingDirectory,
  prompt: Schema.NonEmptyString,
  /**
   * The complete environment of the child process and its commands: the Worker's allowlisted
   * variables plus the Attempt's credential configuration, with nothing inherited from the launching
   * process (ADR 0011). On a `RemoteShell` host, the variables are exported on top of the remote
   * environment, which contains no orchestrator secret.
   */
  environment: Schema.Record(Schema.String, Schema.String),
  host: ChildHost,
  /** The Worker that `host` runs on. */
  worker: WorkerName,
  /**
   * The provider's ID of the machine that a provisioned Worker created for the Attempt, or `None`
   * on other Workers, whose Attempts share one Claude login.
   */
  machine: Schema.Option(MachineId),
}) {}

/** The final message a parent or child session returns. */
export class SessionResult extends Schema.Class<SessionResult>("@usine/agents/SessionResult")({
  message: Schema.NonEmptyString,
}) {}

/** An error for a well-formed rostered model ID that the SDK's registry does not list. */
export class UnknownModelError extends Schema.TaggedError<UnknownModelError>(
  "@usine/agents/UnknownModelError",
)("UnknownModelError", {
  harness: Harness,
  model: ModelId,
  message: Schema.NonEmptyString,
}) {}

/** An error for a credential that cannot use the billing pool the session needs. */
export class PoolUnavailableError extends Schema.TaggedError<PoolUnavailableError>(
  "@usine/agents/PoolUnavailableError",
)("PoolUnavailableError", {
  harness: Harness,
  model: ModelId,
  pool: BillingPool,
  message: Schema.NonEmptyString,
}) {}

/** An error for a model that does not support the rostered reasoning effort. */
export class UnsupportedEffortError extends Schema.TaggedError<UnsupportedEffortError>(
  "@usine/agents/UnsupportedEffortError",
)("UnsupportedEffortError", {
  harness: Harness,
  model: ModelId,
  effort: Effort,
  message: Schema.NonEmptyString,
}) {}

/**
 * The reserved prefix of a final answer that reports an unresolved blocker. The session fails with
 * `AgentBlockedError`, whose message is the text after the marker.
 */
export const BLOCKED_MARKER = "[usine:blocked]";

/**
 * The reserved prefix of a final answer that asks the operator for a decision. The session fails
 * with `AgentQuestionError`, whose message is the text after the marker.
 */
export const QUESTION_MARKER = "[usine:question]";

/**
 * The reserved prefix of a report that relays a harness failure, such as a child's failed Codex
 * turn, to the parent. The session fails with `AgentResultError`, which ends the Attempt with
 * `AgentFailure`.
 */
export const FAILED_MARKER = "[usine:failed]";

/** An error for a session that finished and reported that the work failed. */
export class AgentResultError extends Schema.TaggedError<AgentResultError>(
  "@usine/agents/AgentResultError",
)("AgentResultError", {
  sessionId: Schema.OptionFromNullOr(AgentSessionId),
  message: Schema.NonEmptyString,
}) {}

/** An error for a session that finished with the blocker marker; `message` is the blocker text. */
export class AgentBlockedError extends Schema.TaggedError<AgentBlockedError>(
  "@usine/agents/AgentBlockedError",
)("AgentBlockedError", {
  sessionId: Schema.OptionFromNullOr(AgentSessionId),
  message: Schema.NonEmptyString,
}) {}

/** An error for a session that finished with a question for the operator; `message` is the question. */
export class AgentQuestionError extends Schema.TaggedError<AgentQuestionError>(
  "@usine/agents/AgentQuestionError",
)("AgentQuestionError", {
  sessionId: Schema.OptionFromNullOr(AgentSessionId),
  message: Schema.NonEmptyString,
}) {}

/** An error for a Pi parent that requested more children than the Attempt's budget allows. */
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

/** An error for an SDK or process failure after the model and harness were validated. */
export class SessionOperationError extends Schema.TaggedError<SessionOperationError>(
  "@usine/agents/SessionOperationError",
)("SessionOperationError", {
  operation: SessionOperation,
  sessionId: Schema.OptionFromNullOr(AgentSessionId),
  message: Schema.NonEmptyString,
  cause: Schema.Defect(),
}) {}

/** Any error that stops a session from starting, continuing, or finishing; the error type determines whether a retry needs the operator. */
export const AgentSessionError = Schema.Union([
  UnknownModelError,
  PoolUnavailableError,
  UnsupportedEffortError,
  AgentResultError,
  AgentBlockedError,
  AgentQuestionError,
  ChildSessionBudgetExceededError,
  SessionOperationError,
]);
export type AgentSessionError = typeof AgentSessionError.Type;

/**
 * A report that a session ends with: a blocker or question marked in its final answer, or a failure
 * reported by its harness. A child relays each report to the parent with the same marker.
 */
export type AgentReport = AgentResultError | AgentBlockedError | AgentQuestionError;

/**
 * Returns the report of a final answer that starts with `[usine:blocked]`, `[usine:question]`, or
 * `[usine:failed]`; the details can follow on the same line or the next. Returns `None` if the answer
 * does not start with a marker.
 */
export const reportedOutcome = (
  sessionId: Option.Option<AgentSessionId>,
  answer: string,
): Option.Option<AgentReport> => {
  const trimmed = answer.trim();
  if (trimmed.startsWith(QUESTION_MARKER)) {
    return Option.some(
      new AgentQuestionError({
        sessionId,
        message:
          trimmed.slice(QUESTION_MARKER.length).trim() ||
          "Agent asked the operator a question without writing it.",
      }),
    );
  }
  if (trimmed.startsWith(BLOCKED_MARKER)) {
    return Option.some(
      new AgentBlockedError({
        sessionId,
        message:
          trimmed.slice(BLOCKED_MARKER.length).trim() ||
          "Agent reported an unresolved blocker without details.",
      }),
    );
  }
  if (trimmed.startsWith(FAILED_MARKER)) {
    return Option.some(
      new AgentResultError({
        sessionId,
        message:
          trimmed.slice(FAILED_MARKER.length).trim() || "Agent reported a failure without details.",
      }),
    );
  }
  return Option.none();
};

/** Returns the final answer that relays `report`, starting with its marker. */
export const reportText = (report: AgentReport): string => {
  const marker = Match.valueTags(report, {
    AgentResultError: () => FAILED_MARKER,
    AgentBlockedError: () => BLOCKED_MARKER,
    AgentQuestionError: () => QUESTION_MARKER,
  });
  return `${marker}\n${report.message}`;
};

/**
 * Maps a session error to an Attempt failure: SDK and process failures are retryable infrastructure
 * failures; roster errors and Agent-reported failures wait for the operator (ADR 0002).
 */
export const toAttemptFailure = (error: AgentSessionError): AttemptFailure =>
  Match.valueTags(error, {
    SessionOperationError: (operation) =>
      new InfraFailure({ message: operation.message, cause: operation.cause }),
    UnknownModelError: ({ message }) => new AgentFailure({ message }),
    PoolUnavailableError: ({ message }) => new AgentFailure({ message }),
    UnsupportedEffortError: ({ message }) => new AgentFailure({ message }),
    AgentResultError: ({ message }) => new AgentFailure({ message }),
    AgentBlockedError: ({ message }) => new BlockedFailure({ message }),
    AgentQuestionError: ({ message }) => new QuestionFailure({ question: message }),
    ChildSessionBudgetExceededError: ({ attemptedChildren, maxChildren }) =>
      new ChildSessionBudgetFailure({ attemptedChildren, maxChildren }),
  });

/** A running parent or child session. */
export interface RunningSession {
  readonly session: AgentSession;
  /** The session activity to record in the Attempt transcript. */
  readonly events: Stream.Stream<AgentSessionEvent, AgentSessionError>;
  /** Waits for the session's final message, or fails with the error that ended it. */
  readonly result: Effect.Effect<SessionResult, AgentSessionError>;
  /** Adds operator guidance to the running session without creating a new Attempt. */
  readonly steer: (message: string) => Effect.Effect<void, AgentSessionError>;
  /** Requests that the session stop its current work. */
  readonly interrupt: Effect.Effect<void, AgentSessionError>;
  /**
   * Applies a nonterminal operator action; after a child message, the session does not complete
   * until release. If the harness reads the message only at its next boundary, returns `queued` and
   * calls `onDelivery` once: with the session state when it is read, or `None` if the session stops
   * first.
   */
  readonly intervene: (
    action: AttemptChannel.OperatorAction,
    onDelivery: OnDelivery,
  ) => Effect.Effect<AttemptChannel.InterventionState, AgentSessionError>;
}

/** A callback, called once for a queued operator message with the session state when it was read, or `None` if the session stopped first. */
export type OnDelivery = (
  delivered: Option.Option<AttemptChannel.InterventionState>,
) => Effect.Effect<void>;

/** A backend that launches child sessions for tasks delegated by an Attempt's parent. */
export interface ChildBackendService {
  /** Starts the child and returns its controls; `result` is awaited separately. */
  readonly launch: (
    request: ChildRequest,
  ) => Effect.Effect<RunningSession, AgentSessionError, Scope.Scope>;
}

/** The service that runs tasks delegated by an Attempt's parent. */
export class ChildBackend extends Context.Service<ChildBackend, ChildBackendService>()(
  "@usine/agents/ChildBackend",
) {}

/**
 * A per-Worker lock for Claude commands that can refresh the Worker's shared Claude login: the
 * preflight login check and the start of a Claude child. Claude Code ends a process that finds
 * another process refreshing the login (#453). Provide one instance to both the executor and the
 * Attempt runtime.
 */
export class ClaudeLoginLock extends Context.Service<
  ClaudeLoginLock,
  {
    /** Runs `effect` with `worker`'s lock, after waiting for any other effect that has the lock. */
    readonly withLock: (
      worker: WorkerName,
    ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("@usine/agents/ClaudeLoginLock") {}

/** The child backend for Claude Code. */
export class ClaudeChildBackend extends Context.Service<ClaudeChildBackend, ChildBackendService>()(
  "@usine/agents/ClaudeChildBackend",
) {}

/** The child backend for Codex. */
export class CodexChildBackend extends Context.Service<CodexChildBackend, ChildBackendService>()(
  "@usine/agents/CodexChildBackend",
) {}

/** The child backend for Pi. */
export class PiChildBackend extends Context.Service<PiChildBackend, ChildBackendService>()(
  "@usine/agents/PiChildBackend",
) {}
