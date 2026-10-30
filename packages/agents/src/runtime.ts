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
  ProviderCapacityFailure,
  QuestionFailure,
} from "@usine/core/attempt/failure";
import { Context, Effect, Match, Option, Schema, Scope, Stream } from "effect";
import { ChildHost } from "./child-host/child-host.ts";

/** The checkout directory of an attempt. */
export const WorkingDirectory = Schema.NonEmptyString.pipe(Schema.brand("AgentWorkingDirectory"));
export type WorkingDirectory = typeof WorkingDirectory.Type;

/** A task delegated to one child, with its session and the checkout it shares with the parent. */
export class ChildRequest extends Schema.Class<ChildRequest>("@usine/agents/ChildRequest")({
  /** The child identity, parent session, and brain spec selected for the delegated task. */
  session: ChildSession,
  /** The checkout directory on `host`. */
  cwd: WorkingDirectory,
  /** The complete instructions to send as the child's first message. */
  prompt: Schema.NonEmptyString,
  /**
   * The complete environment of the child process and its commands: the worker's allowlisted
   * variables plus the attempt's credential configuration, with nothing inherited from the launching
   * process (ADR 0011). On a `RemoteShell` host, the variables are exported on top of the remote
   * environment, which contains no orchestrator secret.
   */
  environment: Schema.Record(Schema.String, Schema.String),
  /** Where to start the harness process and run its commands. */
  host: ChildHost,
  /** The worker that `host` runs on. */
  worker: WorkerName,
  /**
   * The provider's ID of the machine that a provisioned worker created for the attempt, or `None`
   * on other workers, whose attempts share one Claude login.
   */
  machine: Schema.Option(MachineId),
}) {}

/** The final message a parent or child session returns. */
export class SessionResult extends Schema.Class<SessionResult>("@usine/agents/SessionResult")({
  /** The final answer returned after the session finishes its work. */
  message: Schema.NonEmptyString,
}) {}

/** An error for a model ID that the harness cannot resolve. */
export class UnknownModelError extends Schema.TaggedError<UnknownModelError>(
  "@usine/agents/UnknownModelError",
)("UnknownModelError", {
  /** The harness selected by the agent's brain spec. */
  harness: Harness,
  /** The model requested for the session. */
  model: ModelId,
  /** The explanation of why the harness could not resolve the model. */
  message: Schema.NonEmptyString,
}) {}

/** An error for a credential that cannot use the billing pool the session needs. */
export class PoolUnavailableError extends Schema.TaggedError<PoolUnavailableError>(
  "@usine/agents/PoolUnavailableError",
)("PoolUnavailableError", {
  /** The harness selected by the agent's brain spec. */
  harness: Harness,
  /** The model requested for the session. */
  model: ModelId,
  /** The billing pool the session requires but cannot access with its credential. */
  pool: BillingPool,
  /** The credential or billing restriction that prevents the session from starting or continuing. */
  message: Schema.NonEmptyString,
}) {}

/** An error for a model that does not support the rostered reasoning effort. */
export class UnsupportedEffortError extends Schema.TaggedError<UnsupportedEffortError>(
  "@usine/agents/UnsupportedEffortError",
)("UnsupportedEffortError", {
  /** The harness selected by the agent's brain spec. */
  harness: Harness,
  /** The model requested for the session. */
  model: ModelId,
  /** The requested reasoning effort that the model does not support. */
  effort: Effort,
  /** The explanation of the model's reasoning-effort restriction. */
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
 * turn, to the parent. The session fails with `AgentResultError`, which ends the attempt with
 * `AgentFailure`. Capacity refusals use `CAPACITY_MARKER`.
 */
export const FAILED_MARKER = "[usine:failed]";

/** The reserved report prefix for a temporary provider capacity refusal. */
export const CAPACITY_MARKER = "[usine:provider-capacity]";

/** A harness refusal because its model provider has no capacity. */
export class AgentCapacityError extends Schema.TaggedError<AgentCapacityError>(
  "@usine/agents/AgentCapacityError",
)("AgentCapacityError", {
  /** The affected session, or `None` when no session identity is available. */
  sessionId: Schema.OptionFromNullOr(AgentSessionId),
  /** The provider's capacity refusal, or the details after the capacity report marker. */
  message: Schema.NonEmptyString,
}) {}

/** An error for a session that finished and reported that the work failed. */
export class AgentResultError extends Schema.TaggedError<AgentResultError>(
  "@usine/agents/AgentResultError",
)("AgentResultError", {
  /** The affected session, or `None` when no session identity is available. */
  sessionId: Schema.OptionFromNullOr(AgentSessionId),
  /** The harness failure or the details after the failed report marker. */
  message: Schema.NonEmptyString,
}) {}

/** Recognizes capacity refusals when a harness supplies only an error message. */
const isCapacityMessage = (message: string): boolean =>
  /\bselected model is at capacity\b|\boverloaded_error\b/iu.test(message) ||
  /(?:^|\b(?:HTTP|(?:status|error)(?: code)?)[: ]+)529\b/iu.test(message) ||
  (/\b503\b/u.test(message) && /\bretry(?:[- ]after)?\b|\btry again\b/iu.test(message));

/** Classifies a harness failure when it exposes only a message. */
export const harnessFailure = (
  sessionId: Option.Option<AgentSessionId>,
  message: string,
): AgentResultError | AgentCapacityError =>
  isCapacityMessage(message)
    ? new AgentCapacityError({ sessionId, message })
    : new AgentResultError({ sessionId, message });

/** An error for a session that finished with the blocker marker; `message` is the blocker text. */
export class AgentBlockedError extends Schema.TaggedError<AgentBlockedError>(
  "@usine/agents/AgentBlockedError",
)("AgentBlockedError", {
  /** The affected session, or `None` when no session identity is available. */
  sessionId: Schema.OptionFromNullOr(AgentSessionId),
  /** The unresolved blocker after the blocked report marker. */
  message: Schema.NonEmptyString,
}) {}

/** An error for a session that finished with a question for the operator; `message` is the question. */
export class AgentQuestionError extends Schema.TaggedError<AgentQuestionError>(
  "@usine/agents/AgentQuestionError",
)("AgentQuestionError", {
  /** The affected session, or `None` when no session identity is available. */
  sessionId: Schema.OptionFromNullOr(AgentSessionId),
  /** The operator question after the question report marker. */
  message: Schema.NonEmptyString,
}) {}

/** An error for a Pi parent that requested more children than the attempt's budget allows. */
export class ChildSessionBudgetExceededError extends Schema.TaggedError<ChildSessionBudgetExceededError>(
  "@usine/agents/ChildSessionBudgetExceededError",
)("ChildSessionBudgetExceededError", {
  /** The attempt's maximum number of child sessions. */
  maxChildren: ChildSessionBudget,
  /** The child count including the launch that exceeded the budget. */
  attemptedChildren: ChildSessionCount,
  /** The explanation of the refused child launch. */
  message: Schema.NonEmptyString,
}) {}

/** The session operations identified by SDK and process errors. */
export const SESSION_OPERATIONS = ["launch", "stream", "steer", "interrupt"] as const;
/** The operation that failed: starting a session, reading output, sending guidance, or stopping work. */
export const SessionOperation = Schema.Literals(SESSION_OPERATIONS);
export type SessionOperation = typeof SessionOperation.Type;

/** An error for an SDK or process failure after the model and harness were validated. */
export class SessionOperationError extends Schema.TaggedError<SessionOperationError>(
  "@usine/agents/SessionOperationError",
)("SessionOperationError", {
  /** The operation that failed, used to distinguish launch, output, and control failures. */
  operation: SessionOperation,
  /** The affected session, or `None` when no session identity is available. */
  sessionId: Schema.OptionFromNullOr(AgentSessionId),
  /** The operation failure description; its wording is not a stable error code. */
  message: Schema.NonEmptyString,
  /** The original SDK or process failure, retained for diagnosis. */
  cause: Schema.Defect(),
}) {}

/** Any error that stops a session from starting, continuing, or finishing; the error type determines whether a retry needs the operator. */
export const AgentSessionError = Schema.Union([
  UnknownModelError,
  PoolUnavailableError,
  UnsupportedEffortError,
  AgentResultError,
  AgentCapacityError,
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
export type AgentReport =
  | AgentResultError
  | AgentCapacityError
  | AgentBlockedError
  | AgentQuestionError;

/**
 * Returns the report of a final answer that starts with a reserved report marker. Details can
 * follow on the same line or the next. Returns `None` if the answer has no marker.
 */
export const reportedOutcome = (
  sessionId: Option.Option<AgentSessionId>,
  answer: string,
): Option.Option<AgentReport> => {
  const trimmed = answer.trim();
  if (trimmed.startsWith(CAPACITY_MARKER)) {
    return Option.some(
      new AgentCapacityError({
        sessionId,
        message:
          trimmed.slice(CAPACITY_MARKER.length).trim() || "The model provider is at capacity.",
      }),
    );
  }
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
    AgentCapacityError: () => CAPACITY_MARKER,
    AgentBlockedError: () => BLOCKED_MARKER,
    AgentQuestionError: () => QUESTION_MARKER,
  });
  return `${marker}\n${report.message}`;
};

/**
 * Maps a session error to an attempt failure: SDK and process failures are retryable infrastructure
 * failures; capacity refusals use a delayed retry. Roster errors and other agent-reported
 * failures wait for the operator (ADR 0002).
 */
export const toAttemptFailure = (error: AgentSessionError): AttemptFailure =>
  Match.valueTags(error, {
    SessionOperationError: (operation) =>
      new InfraFailure({ message: operation.message, cause: operation.cause }),
    UnknownModelError: ({ message }) => new AgentFailure({ message }),
    PoolUnavailableError: ({ message }) => new AgentFailure({ message }),
    UnsupportedEffortError: ({ message }) => new AgentFailure({ message }),
    AgentResultError: ({ message }) => new AgentFailure({ message }),
    AgentCapacityError: ({ message }) => new ProviderCapacityFailure({ message }),
    AgentBlockedError: ({ message }) => new BlockedFailure({ message }),
    AgentQuestionError: ({ message }) => new QuestionFailure({ question: message }),
    ChildSessionBudgetExceededError: ({ attemptedChildren, maxChildren }) =>
      new ChildSessionBudgetFailure({ attemptedChildren, maxChildren }),
  });

/** A running parent or child session. */
export interface RunningSession {
  /** The session identity and launch metadata associated with these controls and events. */
  readonly session: AgentSession;
  /** The session activity to record in the attempt transcript. */
  readonly events: Stream.Stream<AgentSessionEvent, AgentSessionError>;
  /** Waits for the session's final message, or fails with the error that ended it. */
  readonly result: Effect.Effect<SessionResult, AgentSessionError>;
  /** Adds operator guidance to the running session without creating a new attempt. */
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

/** A backend that launches child sessions for tasks delegated by an attempt's parent. */
export interface ChildBackendService {
  /** Starts the child described by `request` in the calling scope and returns its controls; await `result` separately before closing the scope. */
  readonly launch: (
    request: ChildRequest,
  ) => Effect.Effect<RunningSession, AgentSessionError, Scope.Scope>;
}

/** The service that runs tasks delegated by an attempt's parent. */
export class ChildBackend extends Context.Service<ChildBackend, ChildBackendService>()(
  "@usine/agents/ChildBackend",
) {}

/**
 * A lock per Claude login for the Claude commands that can refresh it: the preflight login check
 * and the start of a Claude child. Claude Code ends a process that finds another process
 * refreshing the login (#453). Each machine of a provisioned worker has its own login; on other
 * workers, all attempts share one. Provide one instance to both the executor and the attempt
 * runtime.
 */
export class ClaudeLoginLock extends Context.Service<
  ClaudeLoginLock,
  {
    /**
     * Runs `effect` with the lock of the login on `worker`'s provisioned `machine`, or of the
     * worker's shared login if `machine` is `None`, after waiting for any other effect that has
     * the lock.
     */
    readonly withLock: (
      worker: WorkerName,
      machine: Option.Option<MachineId>,
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
