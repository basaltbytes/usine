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
import { WorkerName } from "@usine/core/worker";
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

/** The checkout directory one Attempt runs in. */
export const WorkingDirectory = Schema.NonEmptyString.pipe(Schema.brand("AgentWorkingDirectory"));
export type WorkingDirectory = typeof WorkingDirectory.Type;

/** Work delegated to one child, with its assigned identity and the checkout it shares with the parent. */
export class ChildRequest extends Schema.Class<ChildRequest>("@usine/agents/ChildRequest")({
  session: ChildSession,
  /** The checkout, on the machine `host` names. */
  cwd: WorkingDirectory,
  prompt: Schema.NonEmptyString,
  /**
   * The complete environment of the child's process and every command it runs:
   * the Worker's allowlisted variables plus the Attempt's credential
   * configuration. Nothing is inherited from the process that launches the
   * child (ADR 0011). On a `RemoteShell` host they are exported on top of the
   * remote machine's own environment, which holds no orchestrator secret.
   */
  environment: Schema.Record(Schema.String, Schema.String),
  /** Where the child's process runs. */
  host: ChildHost,
  /** The Worker whose machine `host` reaches. Claude children on one Worker share its Claude login. */
  worker: WorkerName,
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

/**
 * The reserved opening of a final answer that reports an unresolved blocker.
 * Text after the marker is the blocker; the session fails with `AgentBlockedError`.
 */
export const BLOCKED_MARKER = "[usine:blocked]";

/**
 * The reserved opening of a final answer that asks the operator for a decision
 * the Agent cannot make itself. Text after the marker is the question; the
 * session fails with `AgentQuestionError`.
 */
export const QUESTION_MARKER = "[usine:question]";

/**
 * The reserved opening of a report that relays a harness failure, such as a
 * child's failed Codex turn, to the parent. Text after the marker is the
 * failure; the session fails with `AgentResultError`, which ends the Attempt
 * with `AgentFailure`.
 */
export const FAILED_MARKER = "[usine:failed]";

/** The session finished and reported that the work itself failed. */
export class AgentResultError extends Schema.TaggedError<AgentResultError>(
  "@usine/agents/AgentResultError",
)("AgentResultError", {
  sessionId: Schema.OptionFromNullOr(AgentSessionId),
  message: Schema.NonEmptyString,
}) {}

/** The session finished by reporting a blocker with the reserved marker; `message` is the blocker as the Agent wrote it. */
export class AgentBlockedError extends Schema.TaggedError<AgentBlockedError>(
  "@usine/agents/AgentBlockedError",
)("AgentBlockedError", {
  sessionId: Schema.OptionFromNullOr(AgentSessionId),
  message: Schema.NonEmptyString,
}) {}

/** The session finished by asking the operator a question; `message` is the question as the Agent wrote it. */
export class AgentQuestionError extends Schema.TaggedError<AgentQuestionError>(
  "@usine/agents/AgentQuestionError",
)("AgentQuestionError", {
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
  AgentBlockedError,
  AgentQuestionError,
  ChildSessionBudgetExceededError,
  SessionOperationError,
]);
export type AgentSessionError = typeof AgentSessionError.Type;

/**
 * The reports a session ends its work with: a blocker or a question its final
 * answer opened with a reserved marker, or a failure its harness reported. A
 * child relays each to the parent with its own marker.
 */
export type AgentReport = AgentResultError | AgentBlockedError | AgentQuestionError;

/**
 * Reads a final answer's reserved marker: `[usine:blocked]` reports a blocker,
 * `[usine:question]` asks the operator, and `[usine:failed]` relays a failure.
 * Only an answer that opens with a marker counts, whether its details follow
 * on the same line or the next; ordinary prose and later mentions are unchanged.
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

/** The final answer that relays `report` to whoever awaits it, opening with its marker. */
export const reportText = (report: AgentReport): string => {
  const marker = Match.valueTags(report, {
    AgentResultError: () => FAILED_MARKER,
    AgentBlockedError: () => BLOCKED_MARKER,
    AgentQuestionError: () => QUESTION_MARKER,
  });
  return `${marker}\n${report.message}`;
};

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
    AgentBlockedError: ({ message }) => new BlockedFailure({ message }),
    AgentQuestionError: ({ message }) => new QuestionFailure({ question: message }),
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
  /**
   * Applies a nonterminal operator action; child messages hold completion
   * until release. A message the harness reads only at its next boundary
   * comes back `queued`, and `onDelivery` is called once for it: with the
   * session's state when the harness reads it, or with none when the session
   * stops first.
   */
  readonly intervene: (
    action: AttemptChannel.OperatorAction,
    onDelivery: OnDelivery,
  ) => Effect.Effect<AttemptChannel.InterventionState, AgentSessionError>;
}

/** Told once whether a queued operator message was read: the session's state then, or none when it stopped first. */
export type OnDelivery = (
  delivered: Option.Option<AttemptChannel.InterventionState>,
) => Effect.Effect<void>;

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

/**
 * The lock, one per Worker, that the Claude commands able to refresh a Worker's Claude login take:
 * the preflight's login check and the start of a Claude child. Every Claude process on a Worker
 * shares one login, and Claude Code ends a process that finds another one refreshing it (#453).
 * Provide one instance to both the executor and the Attempt runtime, so they take the same lock.
 */
export class ClaudeLoginLock extends Context.Service<
  ClaudeLoginLock,
  {
    /** Runs `effect` once no other holder of `worker`'s lock runs, and holds the lock until `effect` ends. */
    readonly withLock: (
      worker: WorkerName,
    ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("@usine/agents/ClaudeLoginLock") {}

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
