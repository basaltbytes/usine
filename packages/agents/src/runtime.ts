import { Effort, Harness, ModelId } from "@usine/core/agent/brain";
import {
  AgentSession,
  AgentSessionEvent,
  AgentSessionId,
  BillingPool,
  ChildSession,
  ChildSessionBudget,
  ChildSessionCount,
  HarnessSession,
  SessionTokensUpdated,
  TokenCount,
  UsdAmount,
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
import { type Brand, Context, Effect, Match, Option, Schema, Scope, Stream } from "effect";
import { ChildHost } from "./child-host/child-host.ts";

/** The checkout directory of an attempt. */
export const WorkingDirectory = Schema.NonEmptyString.pipe(Schema.brand("AgentWorkingDirectory"));
export type WorkingDirectory = typeof WorkingDirectory.Type;

/** Marks an attempt's release before its child transport and credentials close. */
export class ChildSessionLifecycle extends Context.Service<
  ChildSessionLifecycle,
  { readonly isStopping: Effect.Effect<boolean> }
>()("@usine/agents/runtime/ChildSessionLifecycle") {
  static readonly current = Effect.map(
    Effect.serviceOption(ChildSessionLifecycle),
    Option.getOrElse(() => ChildSessionLifecycle.of({ isStopping: Effect.succeed(false) })),
  );
}

/** An operator message retained until its native acknowledgement arrives. */
export const QueuedOperatorMessage = Schema.Struct({
  id: AttemptChannel.OperatorMessageId,
  message: Schema.NonEmptyString,
});
export type QueuedOperatorMessage = typeof QueuedOperatorMessage.Type;

/** A tool call whose result was not committed before recovery. */
export const InterruptedTool = Schema.Struct({
  callId: Schema.NonEmptyString,
  tool: Schema.NonEmptyString,
});
export type InterruptedTool = typeof InterruptedTool.Type;

/** Checkpoints that must precede a child prompt. */
export class ChildSessionJournal extends Context.Service<
  ChildSessionJournal,
  {
    readonly started: (reference: HarnessSession) => Effect.Effect<void, SessionOperationError>;
    /** Records that the native process acknowledged the task prompt. */
    readonly prompted: Effect.Effect<void, SessionOperationError>;
    readonly continued: (
      timestamps: ReadonlyArray<number>,
    ) => Effect.Effect<void, SessionOperationError>;
    readonly delivered: (
      id: AttemptChannel.OperatorMessageId,
      state: Option.Option<AttemptChannel.InterventionState>,
    ) => Effect.Effect<void>;
  }
>()("@usine/agents/runtime/ChildSessionJournal") {
  static readonly current = Effect.map(
    Effect.serviceOption(ChildSessionJournal),
    Option.getOrElse(() =>
      ChildSessionJournal.of({
        started: () => Effect.void,
        prompted: Effect.void,
        continued: () => Effect.void,
        delivered: () => Effect.void,
      }),
    ),
  );
}

/** A task delegated to one child, with its session and the checkout it shares with the parent. */
export class ChildRequest extends Schema.Class<
  ChildRequest,
  Brand.Brand<"@usine/agents/runtime/ChildRequest">
>("@usine/agents/ChildRequest")({
  /** The child identity, parent session, and brain spec selected for the delegated task. */
  session: ChildSession,
  /** The checkout directory on `host`. */
  cwd: WorkingDirectory,
  /** The complete instructions to send as the child's first message. */
  prompt: Schema.NonEmptyString,
  /** The saved conversation to continue in this checkout instead of starting a new one. */
  resume: Schema.OptionFromOptionalKey(HarnessSession).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none<HarnessSession>())),
  ),
  /**
   * Whether the native process acknowledged the task prompt before the restart. Only Claude records
   * it; Codex reads the thread's turns, and Pi saves a conversation only after its first user
   * message.
   */
  prompted: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(true))),
  /** Continuation timestamps in milliseconds, retained across orchestrator restarts. */
  continuations: Schema.Array(Schema.Finite).pipe(
    Schema.withConstructorDefault(Effect.succeed([])),
  ),
  /** Tool calls without a committed result at restart. */
  inFlight: Schema.Array(InterruptedTool).pipe(Schema.withConstructorDefault(Effect.succeed([]))),
  /** Operator messages without native delivery acknowledgements at restart. */
  unread: Schema.Array(QueuedOperatorMessage).pipe(
    Schema.withConstructorDefault(Effect.succeed([])),
  ),
  /** Cumulative usage committed before the orchestrator resumed this child. */
  usage: Schema.OptionFromOptionalKey(
    Schema.Struct({
      totalTokens: TokenCount,
      costUsd: Schema.OptionFromNullOr(UsdAmount),
      processUsage: Schema.optionalKey(SessionTokensUpdated.fields.processUsage),
    }),
  ).pipe(Schema.withConstructorDefault(Effect.succeedNone)),
  /** Keeps the child addressable after a turn until the operator releases its persisted Hold. */
  held: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false))),
  /** Waits for operator guidance before starting a turn in a restored paused child. */
  paused: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false))),
  /** Restores an idle child's completed report without starting another turn. */
  idle: Schema.OptionFromOptionalKey(Schema.NonEmptyString).pipe(
    Schema.withConstructorDefault(Effect.succeedNone),
  ),
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
export class SessionResult extends Schema.Class<
  SessionResult,
  Brand.Brand<"@usine/agents/runtime/SessionResult">
>("@usine/agents/SessionResult")({
  /** The final answer returned after the session finishes its work. */
  message: Schema.NonEmptyString,
}) {}

/** An error for a model ID that the harness cannot resolve. */
export class UnknownModelError extends Schema.TaggedError<
  UnknownModelError,
  Brand.Brand<"@usine/agents/runtime/UnknownModelError">
>("@usine/agents/UnknownModelError")("UnknownModelError", {
  /** The harness selected by the agent's brain spec. */
  harness: Harness,
  /** The model requested for the session. */
  model: ModelId,
  /** The explanation of why the harness could not resolve the model. */
  message: Schema.NonEmptyString,
}) {}

/** An error for a credential that cannot use the billing pool the session needs. */
export class PoolUnavailableError extends Schema.TaggedError<
  PoolUnavailableError,
  Brand.Brand<"@usine/agents/runtime/PoolUnavailableError">
>("@usine/agents/PoolUnavailableError")("PoolUnavailableError", {
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
export class UnsupportedEffortError extends Schema.TaggedError<
  UnsupportedEffortError,
  Brand.Brand<"@usine/agents/runtime/UnsupportedEffortError">
>("@usine/agents/UnsupportedEffortError")("UnsupportedEffortError", {
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

/** A harness refusal because its model provider has no capacity or the usage limit is reached. */
export class AgentCapacityError extends Schema.TaggedError<
  AgentCapacityError,
  Brand.Brand<"@usine/agents/runtime/AgentCapacityError">
>("@usine/agents/AgentCapacityError")("AgentCapacityError", {
  /** The affected session, or `None` when no session identity is available. */
  sessionId: Schema.OptionFromNullOr(AgentSessionId),
  /** The provider's capacity refusal, or the details after the capacity report marker. */
  message: Schema.NonEmptyString,
  /** The time the provider's usage limit resets, or `None` if the provider didn't report one. */
  resetsAt: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString).pipe(
    Schema.withConstructorDefault(Effect.succeedNone),
  ),
}) {}

/** An error for a session that finished and reported that the work failed. */
export class AgentResultError extends Schema.TaggedError<
  AgentResultError,
  Brand.Brand<"@usine/agents/runtime/AgentResultError">
>("@usine/agents/AgentResultError")("AgentResultError", {
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
    ? AgentCapacityError.make({ sessionId, message })
    : AgentResultError.make({ sessionId, message });

/** An error for a session that finished with the blocker marker; `message` is the blocker text. */
export class AgentBlockedError extends Schema.TaggedError<
  AgentBlockedError,
  Brand.Brand<"@usine/agents/runtime/AgentBlockedError">
>("@usine/agents/AgentBlockedError")("AgentBlockedError", {
  /** The affected session, or `None` when no session identity is available. */
  sessionId: Schema.OptionFromNullOr(AgentSessionId),
  /** The unresolved blocker after the blocked report marker. */
  message: Schema.NonEmptyString,
}) {}

/** An error for a session that finished with a question for the operator; `message` is the question. */
export class AgentQuestionError extends Schema.TaggedError<
  AgentQuestionError,
  Brand.Brand<"@usine/agents/runtime/AgentQuestionError">
>("@usine/agents/AgentQuestionError")("AgentQuestionError", {
  /** The affected session, or `None` when no session identity is available. */
  sessionId: Schema.OptionFromNullOr(AgentSessionId),
  /** The operator question after the question report marker. */
  message: Schema.NonEmptyString,
}) {}

/** An error for a Pi parent that requested more children than the attempt's budget allows. */
export class ChildSessionBudgetExceededError extends Schema.TaggedError<
  ChildSessionBudgetExceededError,
  Brand.Brand<"@usine/agents/runtime/ChildSessionBudgetExceededError">
>("@usine/agents/ChildSessionBudgetExceededError")("ChildSessionBudgetExceededError", {
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
export class SessionOperationError extends Schema.TaggedError<
  SessionOperationError,
  Brand.Brand<"@usine/agents/runtime/SessionOperationError">
>("@usine/agents/SessionOperationError")("SessionOperationError", {
  /** The operation that failed, used to distinguish launch, output, and control failures. */
  operation: SessionOperation,
  /** The affected session, or `None` when no session identity is available. */
  sessionId: Schema.OptionFromNullOr(AgentSessionId),
  /** The operation failure description; its wording is not a stable error code. */
  message: Schema.NonEmptyString,
  /** The original SDK or process failure, retained for diagnosis. */
  cause: Schema.Defect(),
}) {}

/** A saved conversation cannot continue under the current harness configuration. */
export class ContinuationMismatchError extends Schema.TaggedError<
  ContinuationMismatchError,
  Brand.Brand<"@usine/agents/runtime/ContinuationMismatchError">
>("@usine/agents/ContinuationMismatchError")("ContinuationMismatchError", {
  sessionId: AgentSessionId,
  field: Schema.Literals(["harness", "home", "model_provider", "cwd"]),
  message: Schema.NonEmptyString,
}) {}

/** Recovery could not reopen the saved native conversation. */
export class SessionInterruptedError extends Schema.TaggedError<
  SessionInterruptedError,
  Brand.Brand<"@usine/agents/runtime/SessionInterruptedError">
>("@usine/agents/SessionInterruptedError")("SessionInterruptedError", {
  sessionId: AgentSessionId,
  message: Schema.NonEmptyString,
  cause: Schema.OptionFromOptionalKey(SessionOperationError).pipe(
    Schema.withConstructorDefault(Effect.succeedNone),
  ),
}) {}

/** A child exhausted its continuation allowance within the recovery window. */
export class ContinuationLimitError extends Schema.TaggedError<
  ContinuationLimitError,
  Brand.Brand<"@usine/agents/runtime/ContinuationLimitError">
>("@usine/agents/ContinuationLimitError")("ContinuationLimitError", {
  sessionId: AgentSessionId,
  message: Schema.NonEmptyString,
}) {}

/** Any error that stops a session from starting, continuing, or finishing; the error type determines whether a retry needs the operator. */
export const AgentSessionError = Schema.Union([
  UnknownModelError,
  ContinuationMismatchError,
  ContinuationLimitError,
  SessionInterruptedError,
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

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const reportMarker = `(?:${[BLOCKED_MARKER, QUESTION_MARKER].map(escapeRegExp).join("|")})`;

/**
 * A report marker that starts a line, or that directly follows narration and ends the line. A run
 * of quote characters at the start of a line or after whitespace, `(`, or `=` opens a quoted
 * string, so a marker directly after it is a mention. Any other quote character closes a string.
 */
const reportHeader = new RegExp(
  `^[ \\t]*${reportMarker}|(?<=\\S)(?<!(?:^|[\\s(=])["'\`]+)${reportMarker}(?=[ \\t]*\\r?$)`,
  "u",
);

/**
 * A Markdown code fence at any indentation, so a fence nested in a list item still quotes its
 * contents: its group is the run of backticks or tildes.
 */
const codeFence = /^[ \t]*(`{3,}|~{3,})/u;

/** Returns whether `line` closes a code block opened by `opener`: same character, no shorter. */
const closesFence = (line: string, opener: string): boolean => {
  const [fence, run] = codeFence.exec(line) ?? [];
  return (
    fence !== undefined &&
    run !== undefined &&
    run[0] === opener[0] &&
    run.length >= opener.length &&
    line.slice(fence.length).trim() === ""
  );
};

/** Returns the offset of the first report header in `answer` outside fenced code blocks. */
const reportHeaderOffset = (answer: string): Option.Option<number> => {
  let offset = 0;
  let opener: string | undefined;
  for (const line of answer.split("\n")) {
    if (opener !== undefined) {
      if (closesFence(line, opener)) opener = undefined;
    } else {
      opener = codeFence.exec(line)?.[1];
      const header = opener === undefined ? reportHeader.exec(line) : null;
      if (header !== null) return Option.some(offset + header.index);
    }
    offset += line.length + 1;
  }
  return Option.none();
};

/**
 * Returns a blocker or question report from a final answer. A report header starts a line, or
 * directly follows narration without a space or opening quote and ends the line. Headers inside
 * fenced code blocks, quoted strings, and inline mentions are ordinary text. Failure and capacity
 * prefixes take precedence.
 */
export const reportedOutcome = (
  sessionId: Option.Option<AgentSessionId>,
  answer: string,
): Option.Option<AgentReport> => {
  const prefix = answer.trim();
  if (prefix.startsWith(CAPACITY_MARKER)) {
    return Option.some(
      AgentCapacityError.make({
        sessionId,
        message:
          prefix.slice(CAPACITY_MARKER.length).trim() || "The model provider is at capacity.",
      }),
    );
  }
  if (prefix.startsWith(FAILED_MARKER)) {
    return Option.some(
      AgentResultError.make({
        sessionId,
        message:
          prefix.slice(FAILED_MARKER.length).trim() || "Agent reported a failure without details.",
      }),
    );
  }
  const trimmed = Option.match(reportHeaderOffset(prefix), {
    onNone: () => prefix,
    onSome: (offset) => prefix.slice(offset).trim(),
  });
  if (trimmed.startsWith(QUESTION_MARKER)) {
    return Option.some(
      AgentQuestionError.make({
        sessionId,
        message:
          trimmed.slice(QUESTION_MARKER.length).trim() ||
          "Agent asked the operator a question without writing it.",
      }),
    );
  }
  if (trimmed.startsWith(BLOCKED_MARKER)) {
    return Option.some(
      AgentBlockedError.make({
        sessionId,
        message:
          trimmed.slice(BLOCKED_MARKER.length).trim() ||
          "Agent reported an unresolved blocker without details.",
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
 * failures; capacity refusals and usage limits use a delayed retry. Roster errors and other
 * agent-reported failures wait for the operator (ADR 0002).
 */
export const toAttemptFailure = (error: AgentSessionError): AttemptFailure =>
  Match.valueTags(error, {
    SessionOperationError: (operation) =>
      InfraFailure.make({ message: operation.message, cause: operation.cause }),
    UnknownModelError: ({ message }) => AgentFailure.make({ message }),
    ContinuationMismatchError: ({ message }) => AgentFailure.make({ message }),
    ContinuationLimitError: ({ message }) => AgentFailure.make({ message }),
    SessionInterruptedError: (error) => InfraFailure.make({ message: error.message, cause: error }),
    PoolUnavailableError: ({ message }) => AgentFailure.make({ message }),
    UnsupportedEffortError: ({ message }) => AgentFailure.make({ message }),
    AgentResultError: ({ message }) => AgentFailure.make({ message }),
    AgentCapacityError: ({ message, resetsAt }) =>
      ProviderCapacityFailure.make({ message, resetsAt }),
    AgentBlockedError: ({ message }) => BlockedFailure.make({ message }),
    AgentQuestionError: ({ message }) => QuestionFailure.make({ question: message }),
    ChildSessionBudgetExceededError: ({ attemptedChildren, maxChildren }) =>
      ChildSessionBudgetFailure.make({ attemptedChildren, maxChildren }),
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
  readonly steer: (
    message: string,
    id?: AttemptChannel.OperatorMessageId,
  ) => Effect.Effect<void, AgentSessionError>;
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
  /** Stops a retained child without resuming its conversation or starting a turn. */
  readonly stop: (request: ChildRequest) => Effect.Effect<void, AgentSessionError>;
  /** Starts the child described by `request` in the calling scope and returns its controls; await `result` separately before closing the scope. */
  readonly launch: (
    request: ChildRequest,
  ) => Effect.Effect<RunningSession, AgentSessionError, Scope.Scope>;
}

/** The service that runs tasks delegated by an attempt's parent. */
export class ChildBackend extends Context.Service<ChildBackend, ChildBackendService>()(
  "@usine/agents/runtime/ChildBackend",
) {}

/**
 * Serializes commands that can refresh one harness login. Provisioned machines have separate
 * logins; other attempts share their worker's login. Share one instance between preflight and
 * session launch.
 */
export class HostLoginLock extends Context.Service<
  HostLoginLock,
  {
    /**
     * Runs `effect` with the lock of `harness`'s login on `worker`'s provisioned `machine`, or of the
     * worker's shared login if `machine` is `None`, after waiting for any other effect that has
     * the lock.
     */
    readonly withLock: (
      harness: Harness,
      worker: WorkerName,
      machine: Option.Option<MachineId>,
    ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("@usine/agents/runtime/HostLoginLock") {}
