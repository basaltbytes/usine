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
export const Direction = Schema.Literals(DIRECTIONS);
export type Direction = typeof Direction.Type;

/** The launch input for one Attempt, without Worker credentials. */
export class RunSpec extends Schema.Class<RunSpec>("AttemptChannel/RunSpec")({
  attemptId: AttemptId,
  repository: RepositoryName,
  revision: RepositoryRevision,
  baseCommit: CommitSha,
  payload: Schema.Json,
  task: AttemptTask,
  agent: Agent,
  parentModel: Schema.OptionFromNullOr(ModelId),
  maxChildren: ChildSessionBudget,
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
  parentModel: ModelId,
  conflictingSalvage: Schema.OptionFromNullOr(SalvagePushed).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(Option.none<SalvagePushed>())),
  ),
}) {}

/** A normalized parent or child session event, persisted in the Attempt transcript. */
export class SessionEvent extends Schema.TaggedClass<SessionEvent>("AttemptChannel/SessionEvent")(
  "SessionEvent",
  { event: AgentSessionEvent },
) {}

export class Final extends Schema.TaggedClass<Final>("AttemptChannel/Final")("Final", {
  result: StepResult,
}) {}

export class Failed extends Schema.TaggedClass<Failed>("AttemptChannel/Failed")("Failed", {
  failure: AttemptFailure,
}) {}

/** The parent's terminal acknowledgment of cancellation. */
export class Interrupted extends Schema.TaggedClass<Interrupted>("AttemptChannel/Interrupted")(
  "Interrupted",
  {},
) {}

export class Steer extends Schema.TaggedClass<Steer>("AttemptChannel/Steer")("Steer", {
  message: Schema.NonEmptyString,
}) {}

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
  { sessionId: AgentSessionId },
) {}

export const SessionTarget = Schema.Union([ParentTarget, ChildTarget]);
export type SessionTarget = typeof SessionTarget.Type;

/** Operator input for one live session, never stored as an Event. */
export class Intervention extends Schema.Class<Intervention>("AttemptChannel/Intervention")({
  operator: Schema.NonEmptyString,
  target: SessionTarget,
  action: OperatorAction,
}) {}

/** The session's supervision state after an accepted operator action. */
export class InterventionState extends Schema.Class<InterventionState>(
  "AttemptChannel/InterventionState",
)({
  held: Schema.Boolean,
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
  inputSequence: Sequence,
  intervention: Intervention,
  state: InterventionState,
}) {}

/** The rejection of an operator action by a closed or refusing session; the Attempt continues. */
export class InterventionRejected extends Schema.TaggedClass<InterventionRejected>(
  "AttemptChannel/InterventionRejected",
)("InterventionRejected", {
  inputSequence: Sequence,
  intervention: Intervention,
  message: Schema.NonEmptyString,
}) {}

/**
 * A probe of the Worker that didn't run a command over a new SSH connection within its timeout.
 * The Attempt isn't stopped or failed (ADR 0013).
 */
export class WorkerUnresponsive extends Schema.TaggedClass<WorkerUnresponsive>(
  "AttemptChannel/WorkerUnresponsive",
)("WorkerUnresponsive", {
  worker: WorkerName,
  /** The last successful probe, or the Attempt's launch time if no probe has run. */
  lastAnsweredAt: Schema.DateTimeUtcFromString,
  /** The probe error, such as the SSH client's error or the exceeded timeout. */
  reason: Schema.NonEmptyString,
}) {}

/** A successful probe after `WorkerUnresponsive`. */
export class WorkerResponsive extends Schema.TaggedClass<WorkerResponsive>(
  "AttemptChannel/WorkerResponsive",
)("WorkerResponsive", {
  worker: WorkerName,
  /** The value from the preceding `WorkerUnresponsive`. */
  lastAnsweredAt: Schema.DateTimeUtcFromString,
}) {}

export const WorkerNotice = Schema.Union([WorkerUnresponsive, WorkerResponsive]);
export type WorkerNotice = typeof WorkerNotice.Type;

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
  version: Schema.Literal(PROTOCOL_VERSION),
  attemptId: AttemptId,
  sequence: Sequence,
  sentAt: Schema.DateTimeUtcFromString,
} as const;

export class OutboundEnvelope extends Schema.TaggedClass<OutboundEnvelope>(
  "AttemptChannel/OutboundEnvelope",
)("OutboundEnvelope", {
  ...EnvelopeFields,
  payload: OutboundPayload,
}) {}

export class InboundEnvelope extends Schema.TaggedClass<InboundEnvelope>(
  "AttemptChannel/InboundEnvelope",
)("InboundEnvelope", {
  ...EnvelopeFields,
  /** The target session, the parent by default. */
  target: SessionTarget.pipe(Schema.withDecodingDefaultKey(Effect.succeed({ _tag: "Parent" }))),
  operator: Schema.NonEmptyString,
  payload: InboundPayload,
}) {}

export const Envelope = Schema.Union([OutboundEnvelope, InboundEnvelope]);
export type Envelope = typeof Envelope.Type;

/** The orchestrator storage that an executor uses for one Attempt. */
export interface Sink {
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

export interface Progress {
  readonly state: "AwaitingStarted" | "Running" | "Terminal";
  readonly nextSequence: number;
}

export const initialProgress: Progress = { state: "AwaitingStarted", nextSequence: 1 };

/** A protocol violation, reported as an infrastructure failure. */
export interface Violation {
  readonly message: string;
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
