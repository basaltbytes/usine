import { Effect, Option, Result, Schema } from "effect";
import { Agent } from "../agent/agent.ts";
import { Effort, ModelId } from "../agent/brain.ts";
import { AgentSessionEvent, AgentSessionId, ChildSessionBudget } from "../agent/session.ts";
import {
  AttemptId,
  AttemptTask,
  type AttemptWindows,
  type ContainerOutOfMemoryKills,
} from "./attempt.ts";
import { RepositoryName, CommitSha, RepositoryRevision } from "../repository.ts";
import { type Comment, StepResult } from "../step/result.ts";
import { BotLogin, WorkerName } from "../worker.ts";
import { AttemptFailure } from "./failure.ts";
import { AttemptSalvage, SalvagePushed } from "./salvage.ts";

/** The envelope version emitted by this package; transcript readers use it to decode stored messages (ADR 0006). */
export const PROTOCOL_VERSION = 7 as const;

/** The per-Attempt, per-direction message sequence, starting at 1; distinct from the transcript sequence. */
export const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("AttemptChannelSequence"),
);
export type Sequence = typeof Sequence.Type;

/**
 * The directions relative to the Attempt's parent: `inbound` for operator input and Cancel, and
 * `outbound` for activity and outcome.
 */
export const DIRECTIONS = ["inbound", "outbound"] as const;
/** The message direction relative to the attempt's parent: operator input is inbound, activity and outcomes are outbound. */
export const Direction = Schema.Literals(DIRECTIONS);
export type Direction = typeof Direction.Type;

/** The launch input for one Attempt, without Worker credentials. */
export class RunSpec extends Schema.Class<RunSpec>("AttemptChannel/RunSpec")({
  /** The attempt that all channel messages must identify. */
  attemptId: AttemptId,
  /** The managed repo checked out for this attempt. */
  repository: RepositoryName,
  /** The requested branch, tag, or commit resolved during checkout preparation. */
  revision: RepositoryRevision,
  /** The resolved revision before applying salvage, used as the base for harvesting commits. */
  baseCommit: CommitSha,
  /** The event snapshot used by selection expressions and prompt interpolation. */
  payload: Schema.Json,
  /** The effective task text supplied to the parent. */
  task: AttemptTask,
  /** The selected agent definition, including its standing instructions and child brain. */
  agent: Agent,
  /** The requested Pi parent model, or `None` to let Pi select it. */
  parentModel: Schema.OptionFromNullOr(ModelId),
  /** The total child sessions the parent may start, including sequential starts. */
  maxChildren: ChildSessionBudget,
  /** The resolved reasoning effort for the Pi parent session. */
  parentEffort: Effort,
  /** The previous Attempt's pushed salvage, applied on top of `baseCommit` and rebased if the base moved. */
  resume: Schema.OptionFromNullOr(SalvagePushed),
  /** The previous Attempt's pushed salvage that conflicts with `baseCommit` and isn't applied. */
  conflictingSalvage: Schema.OptionFromNullOr(SalvagePushed).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(Option.none<SalvagePushed>())),
  ),
  /** The time the Worker prepared the checkout, from which harvesting reads the Item, or `None` for older Attempts. */
  preparedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  /**
   * The GitHub login the Attempt writes as. If `None`, harvesting asks GitHub for the credential's
   * login.
   */
  botLogin: Schema.OptionFromNullOr(BotLogin).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
}) {}

/** The start of an Attempt, with the parent model selected at launch, which can differ from the roster. */
export class Started extends Schema.TaggedClass<Started>("AttemptChannel/Started")("Started", {
  /** The Pi parent model actually selected when the attempt launched. */
  parentModel: ModelId,
  /** The previous salvage that could not be rebased onto the prepared revision, or `None`. */
  conflictingSalvage: Schema.OptionFromNullOr(SalvagePushed).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(Option.none<SalvagePushed>())),
  ),
}) {}

/** A normalized parent or child session event, persisted in the Attempt transcript. */
export class SessionEvent extends Schema.TaggedClass<SessionEvent>("AttemptChannel/SessionEvent")(
  "SessionEvent",
  {
    /** The parent or child session report to append to the transcript. */
    event: AgentSessionEvent,
  },
) {}

/** The parent's terminal success message with the step result to persist. */
export class Final extends Schema.TaggedClass<Final>("AttemptChannel/Final")("Final", {
  /** The successful step result, including the agent's final message and collected facts. */
  result: StepResult,
}) {}

/** The parent's terminal failure message with the reason the attempt failed. */
export class Failed extends Schema.TaggedClass<Failed>("AttemptChannel/Failed")("Failed", {
  /** The reason the attempt failed, used to decide whether to retry. */
  failure: AttemptFailure,
}) {}

/** The parent's terminal acknowledgment of cancellation. */
export class Interrupted extends Schema.TaggedClass<Interrupted>("AttemptChannel/Interrupted")(
  "Interrupted",
  {},
) {}

/** A message for the target session's next turn that does not place a hold. */
export class Steer extends Schema.TaggedClass<Steer>("AttemptChannel/Steer")("Steer", {
  /** The text to deliver to the target session without placing a hold. */
  message: Schema.NonEmptyString,
}) {}

/** A request to interrupt the target session's current turn without canceling the attempt. */
export class Interrupt extends Schema.TaggedClass<Interrupt>("AttemptChannel/Interrupt")(
  "Interrupt",
  {},
) {}

/** The request to stop the whole Attempt, including held and paused sessions. */
export class Cancel extends Schema.TaggedClass<Cancel>("AttemptChannel/Cancel")("Cancel", {}) {}

/** An operator turn for the target session; unlike `Steer`, it puts the session on hold (ADR 0018). */
export class OperatorMessage extends Schema.TaggedClass<OperatorMessage>(
  "AttemptChannel/OperatorMessage",
)("OperatorMessage", {
  /** The operator's text to deliver while placing a hold on the target session. */
  message: Schema.NonEmptyString,
}) {}

/**
 * The request to end a takeover (ADR 0018). A held child returns its idle result to the parent,
 * and a held or paused parent resumes the task.
 */
export class Release extends Schema.TaggedClass<Release>("AttemptChannel/Release")("Release", {}) {}

/** The non-terminal operator actions; `Cancel` is separate. */
export const OperatorAction = Schema.Union([Steer, Interrupt, OperatorMessage, Release]);
export type OperatorAction = typeof OperatorAction.Type;
/** An operator action for a session or a request to cancel the entire attempt. */
export const InboundPayload = Schema.Union([OperatorAction, Cancel]);
export type InboundPayload = typeof InboundPayload.Type;

/** The default target of operator input. */
export class ParentTarget extends Schema.TaggedClass<ParentTarget>("AttemptChannel/ParentTarget")(
  "Parent",
  {},
) {}

/** A child session, addressed by the session ID in its events. */
export class ChildTarget extends Schema.TaggedClass<ChildTarget>("AttemptChannel/ChildTarget")(
  "Child",
  {
    /** The usine session ID of the child that should receive the action. */
    sessionId: AgentSessionId,
  },
) {}

/** The parent or child session that receives an operator action. */
export const SessionTarget = Schema.Union([ParentTarget, ChildTarget]);
export type SessionTarget = typeof SessionTarget.Type;

/** Operator input for one live session, never stored as an Event. */
export class Intervention extends Schema.Class<Intervention>("AttemptChannel/Intervention")({
  /** The operator identity attributed to this action. */
  operator: Schema.NonEmptyString,
  /** The parent or child session to which the action applies. */
  target: SessionTarget,
  /** The requested session action; cancellation of the whole attempt is separate. */
  action: OperatorAction,
}) {}

/** The session's supervision state after an accepted operator action. */
export class InterventionState extends Schema.Class<InterventionState>(
  "AttemptChannel/InterventionState",
)({
  /** Whether the session must wait for operator release before returning its result. */
  held: Schema.Boolean,
  /** Whether the session's turn is interrupted and waits for input or release. */
  paused: Schema.Boolean,
  /**
   * Whether the session reads the message only after its current tool call returns. A later
   * receipt with the same input sequence reports delivery or rejection.
   */
  queued: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
    Schema.withConstructorDefault(Effect.succeed(false)),
  ),
}) {}

/**
 * The receipt for an accepted operator input, with the resulting hold or pause state. A queued
 * input gets a second receipt with the same `inputSequence` when the session reads it.
 */
export class InterventionApplied extends Schema.TaggedClass<InterventionApplied>(
  "AttemptChannel/InterventionApplied",
)("InterventionApplied", {
  /** The inbound sequence of the accepted action, reused for queued delivery receipts. */
  inputSequence: Sequence,
  /** The operator action that the target session accepted. */
  intervention: Intervention,
  /** The target session's hold, pause, and delivery state after accepting the action. */
  state: InterventionState,
}) {}

/** The rejection of an operator action by a closed or refusing session; the Attempt continues. */
export class InterventionRejected extends Schema.TaggedClass<InterventionRejected>(
  "AttemptChannel/InterventionRejected",
)("InterventionRejected", {
  /** The inbound sequence of the rejected action. */
  inputSequence: Sequence,
  /** The operator action the target session could not accept. */
  intervention: Intervention,
  /** The reason the action was rejected; the attempt can continue. */
  message: Schema.NonEmptyString,
}) {}

/** Consecutive unanswered probes before the operator needs a worker alert. */
export const WORKER_UNRESPONSIVE_PROBES = 3;

/**
 * A probe of the Worker that didn't run a command over a new SSH connection within its timeout.
 * The Attempt isn't stopped or failed (ADR 0013).
 */
export class WorkerUnresponsive extends Schema.TaggedClass<WorkerUnresponsive>(
  "AttemptChannel/WorkerUnresponsive",
)("WorkerUnresponsive", {
  /** The worker that did not answer the probe. */
  worker: WorkerName,
  /** The last successful probe, or the Attempt's launch time if no probe has run. */
  lastAnsweredAt: Schema.DateTimeUtcFromString,
  /** The probe error, such as the SSH client's error or the exceeded timeout. */
  reason: Schema.NonEmptyString,
  /** Consecutive unanswered probes; older notices default to one. */
  unansweredProbes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(1)),
    Schema.withConstructorDefault(Effect.succeed(1)),
  ),
}) {}

/** The first successful probe for an attempt's watch, or a successful probe after `WorkerUnresponsive`. */
export class WorkerResponsive extends Schema.TaggedClass<WorkerResponsive>(
  "AttemptChannel/WorkerResponsive",
)("WorkerResponsive", {
  /** The worker that answered the probe. */
  worker: WorkerName,
  /** The value from the preceding `WorkerUnresponsive`, or the first confirmed answer after joining a watch. */
  lastAnsweredAt: Schema.DateTimeUtcFromString,
  /** Whether this watch observed an unanswered probe before this answer. Older notices represent recovery. */
  recovered: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(true)),
    Schema.withConstructorDefault(Effect.succeed(true)),
  ),
}) {}

/** A worker connectivity report that does not change the attempt's outcome. */
export const WorkerNotice = Schema.Union([WorkerUnresponsive, WorkerResponsive]);
export type WorkerNotice = typeof WorkerNotice.Type;

/** Activity, operator receipts, connectivity reports, and terminal outcomes emitted by an attempt. */
export const OutboundPayload = Schema.Union([
  Started,
  SessionEvent,
  Final,
  Failed,
  Interrupted,
  InterventionApplied,
  InterventionRejected,
  WorkerUnresponsive,
  WorkerResponsive,
]);
export type OutboundPayload = typeof OutboundPayload.Type;

const EnvelopeFields = {
  /** The attempt-channel protocol version used to encode this message. */
  version: Schema.Literal(PROTOCOL_VERSION),
  /** The attempt whose channel this message belongs to. */
  attemptId: AttemptId,
  /** The contiguous sequence within this attempt and direction, starting at 1. */
  sequence: Sequence,
  /** The time the sender emitted the message, encoded as a UTC timestamp. */
  sentAt: Schema.DateTimeUtcFromString,
} as const;

/** A versioned attempt message sent to the orchestrator for validation and storage. */
export class OutboundEnvelope extends Schema.TaggedClass<OutboundEnvelope>(
  "AttemptChannel/OutboundEnvelope",
)("OutboundEnvelope", {
  ...EnvelopeFields,
  /** The activity, receipt, connectivity report, or terminal outcome to record. */
  payload: OutboundPayload,
}) {}

/** A versioned operator message sent to the attempt's parent, optionally targeting a child. */
export class InboundEnvelope extends Schema.TaggedClass<InboundEnvelope>(
  "AttemptChannel/InboundEnvelope",
)("InboundEnvelope", {
  ...EnvelopeFields,
  /** The target session, the parent by default. */
  target: SessionTarget.pipe(Schema.withDecodingDefaultKey(Effect.succeed({ _tag: "Parent" }))),
  /** The operator identity attributed to the input. */
  operator: Schema.NonEmptyString,
  /** The session action or request to cancel the entire attempt. */
  payload: InboundPayload,
}) {}

/** A versioned message in either direction of an attempt channel. */
export const Envelope = Schema.Union([OutboundEnvelope, InboundEnvelope]);
export type Envelope = typeof Envelope.Type;

/** The orchestrator storage that an executor uses for one Attempt. */
export interface Sink {
  /** Appends `envelope` to this attempt's transcript in `direction`; outbound messages must first pass `admit`. Fails with `AttemptFailure` if storage fails. */
  readonly append: (
    direction: Direction,
    envelope: Envelope,
  ) => Effect.Effect<void, AttemptFailure>;
  /** Records what the executor kept of the workspace after an unsuccessful end. */
  readonly salvage: (salvage: AttemptSalvage) => Effect.Effect<void, AttemptFailure>;
  /** Records the comments and reviews an unsuccessful Attempt posted on the Run's Item. */
  readonly comments: (comments: ReadonlyArray<Comment>) => Effect.Effect<void, AttemptFailure>;
  /**
   * Records the processes that the kernel killed in one of the Attempt's containers for memory.
   * The kills of the Attempt's other containers stay; a second record of a container replaces
   * its count.
   */
  readonly outOfMemory: (kills: ContainerOutOfMemoryKills) => Effect.Effect<void, AttemptFailure>;
  /** Reads the Attempt windows; harvesting runs it after GitHub lists the Attempt's comments. */
  readonly windows: Effect.Effect<AttemptWindows, AttemptFailure>;
  /** Reads the envelopes recorded by `append`, in order; reattach uses them to restore counters. */
  readonly transcript: Effect.Effect<ReadonlyArray<Envelope>, AttemptFailure>;
}

/** The outbound protocol state used by `admit` to reject invalid message order. */
export interface Progress {
  /** Whether the channel awaits its first message, accepts activity, or has ended. */
  readonly state: "AwaitingStarted" | "Running" | "Terminal";
  /** The only sequence number that the next outbound envelope may use. */
  readonly nextSequence: number;
}

/** The outbound protocol state before the first message, whose sequence must be 1. */
export const initialProgress: Progress = { state: "AwaitingStarted", nextSequence: 1 };

/** A protocol violation, reported as an infrastructure failure. */
export interface Violation {
  /** The protocol diagnostic suitable for an infrastructure failure. */
  readonly message: string;
  /** The received identity, sequence, or payload detail that explains the violation. */
  readonly detail: string;
}

const isTerminal = (payload: OutboundPayload): boolean =>
  payload._tag === "Final" || payload._tag === "Failed" || payload._tag === "Interrupted";

/**
 * Validates an outbound envelope against `progress` and returns the next progress or the
 * violation. Every outbound envelope passes through it before `append`.
 */
export const admit = (
  progress: Progress,
  attemptId: AttemptId,
  envelope: OutboundEnvelope,
): Result.Result<Progress, Violation> => {
  if (envelope.attemptId !== attemptId) {
    return Result.fail({
      message: "The outbound channel has an envelope for another attempt",
      detail: String(envelope.attemptId),
    });
  }
  if (envelope.sequence !== progress.nextSequence) {
    return Result.fail({
      message: "The outbound channel has a non-contiguous sequence number",
      detail: `expected ${progress.nextSequence}, received ${envelope.sequence}`,
    });
  }
  if (progress.state === "Terminal") {
    return Result.fail({
      message: "The outbound channel has an envelope after the terminal envelope",
      detail: envelope.payload._tag,
    });
  }
  if (
    progress.state === "AwaitingStarted" &&
    envelope.payload._tag !== "Started" &&
    envelope.payload._tag !== "Failed"
  ) {
    return Result.fail({
      message: "The outbound channel doesn't start with a Started or Failed envelope",
      detail: envelope.payload._tag,
    });
  }
  if (progress.state === "Running" && envelope.payload._tag === "Started") {
    return Result.fail({
      message: "The outbound channel has more than one Started envelope",
      detail: "duplicate Started envelope",
    });
  }
  return Result.succeed({
    state: isTerminal(envelope.payload) ? "Terminal" : "Running",
    nextSequence: progress.nextSequence + 1,
  });
};
