import { Effect, Option, Result, Schema } from "effect";
import { Agent } from "../agent/agent.ts";
import { Effort, ModelId } from "../agent/brain.ts";
import { AgentSessionEvent, AgentSessionId, ChildSessionBudget } from "../agent/session.ts";
import { AttemptId, AttemptTask, type AttemptWindows } from "./attempt.ts";
import { RepositoryName, CommitSha, RepositoryRevision } from "../repository.ts";
import { type Comment, StepResult } from "../step/result.ts";
import { BotLogin, WorkerName } from "../worker.ts";
import { AttemptFailure } from "./failure.ts";
import { AttemptSalvage, SalvagePushed } from "./salvage.ts";

export const PROTOCOL_VERSION = 7 as const;

/**
 * Per-Attempt, per-direction message sequence, starting at 1. Distinct from the
 * engine's transcript sequence, which orders persisted rows globally.
 */
export const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("AttemptChannelSequence"),
);
export type Sequence = typeof Sequence.Type;

/**
 * Relative to the Attempt's parent: `inbound` envelopes carry operator input and
 * Cancel to it, and `outbound` envelopes carry its activity and outcome.
 */
export const DIRECTIONS = ["inbound", "outbound"] as const;
export const Direction = Schema.Literals(DIRECTIONS);
export type Direction = typeof Direction.Type;

/** Launch input for one Attempt. Worker credentials are never part of it. */
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
  /**
   * The previous Attempt's pushed salvage whose work this workspace holds, on
   * top of `baseCommit`, rebased when the base moved; the agent continues from it.
   */
  resume: Schema.OptionFromNullOr(SalvagePushed),
  /**
   * The previous Attempt's pushed salvage that conflicts with `baseCommit`: the
   * workspace starts from `baseCommit` without it, and its work stays on its branch.
   */
  conflictingSalvage: Schema.OptionFromNullOr(SalvagePushed).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(Option.none<SalvagePushed>())),
  ),
  /**
   * When the Worker prepared the Attempt's checkout. Everything the Attempt
   * writes on GitHub comes after it, so harvesting reads the Run's Item from
   * then on. None for an Attempt prepared before this was recorded.
   */
  preparedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  /**
   * The bot login the Attempt writes to GitHub as, which harvesting matches
   * comments against. None when the orchestrator did not know it or the
   * Attempt was prepared before it was recorded; harvesting then asks GitHub
   * which login the Attempt's credential has.
   */
  botLogin: Schema.OptionFromNullOr(BotLogin).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
}) {}

/**
 * The parent model the SDK selected at launch, which the roster may not declare.
 * Child sessions report their own model in `SessionStarted` events.
 * `conflictingSalvage` is the previous Attempt's work that this Attempt starts
 * without, because it conflicts with the current revision (`RunSpec`).
 */
export class Started extends Schema.TaggedClass<Started>("AttemptChannel/Started")("Started", {
  parentModel: ModelId,
  conflictingSalvage: Schema.OptionFromNullOr(SalvagePushed).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(Option.none<SalvagePushed>())),
  ),
}) {}

/** One normalized parent or child session event, persisted in the Attempt transcript. */
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

/** The Attempt's parent acknowledged cancellation. Terminal. */
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

/** Stops the entire Attempt, including every held or paused session. Used by cancellation and guardrails. */
export class Cancel extends Schema.TaggedClass<Cancel>("AttemptChannel/Cancel")("Cancel", {}) {}

/** An operator turn joined to the target session, distinct from a Steer so a takeover can record and hold it, parent and child alike (ADR 0018). */
export class OperatorMessage extends Schema.TaggedClass<OperatorMessage>(
  "AttemptChannel/OperatorMessage",
)("OperatorMessage", {
  message: Schema.NonEmptyString,
}) {}

/**
 * Ends a takeover (ADR 0018): a held child's idle result returns to the
 * awaiting parent, and a held or paused parent continues the task.
 */
export class Release extends Schema.TaggedClass<Release>("AttemptChannel/Release")("Release", {}) {}

/** Nonterminal operator controls; cancellation is an Attempt operation. */
export const OperatorAction = Schema.Union([Steer, Interrupt, OperatorMessage, Release]);
export type OperatorAction = typeof OperatorAction.Type;
export const InboundPayload = Schema.Union([OperatorAction, Cancel]);
export type InboundPayload = typeof InboundPayload.Type;

/** The Pi parent, the default recipient of operator input for an Attempt. */
export class ParentTarget extends Schema.TaggedClass<ParentTarget>("AttemptChannel/ParentTarget")(
  "Parent",
  {},
) {}

/** A harness child of the Attempt's parent, addressed by the id it reports in the normalized event stream. */
export class ChildTarget extends Schema.TaggedClass<ChildTarget>("AttemptChannel/ChildTarget")(
  "Child",
  { sessionId: AgentSessionId },
) {}

/** Which session inside an Attempt an inbound envelope addresses: the Pi parent, or one of its children. */
export const SessionTarget = Schema.Union([ParentTarget, ChildTarget]);
export type SessionTarget = typeof SessionTarget.Type;

/** Attributed operator input addressed to one live session, never an Event. */
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
   * The session accepted the message but reads it only when its current tool
   * call returns, such as a parent waiting on a child. A later receipt for the
   * same input sequence reports the delivery, or a rejection when the session
   * stopped first. Receipts recorded before this field existed decode as false.
   */
  queued: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
    Schema.withConstructorDefault(Effect.succeed(false)),
  ),
}) {}

/**
 * Acknowledges an operator input and records the resulting Hold or pause in
 * the transcript. A queued input gets a second receipt with the same input
 * sequence once the session reads it.
 */
export class InterventionApplied extends Schema.TaggedClass<InterventionApplied>(
  "AttemptChannel/InterventionApplied",
)("InterventionApplied", {
  inputSequence: Sequence,
  intervention: Intervention,
  state: InterventionState,
}) {}

/** A session closed or refused an operator action; the Attempt itself continues. */
export class InterventionRejected extends Schema.TaggedClass<InterventionRejected>(
  "AttemptChannel/InterventionRejected",
)("InterventionRejected", {
  inputSequence: Sequence,
  intervention: Intervention,
  message: Schema.NonEmptyString,
}) {}

/**
 * The executor's probe of the Attempt's Worker got no answer: its machine did
 * not run a command over a new SSH connection within the probe's bound. The
 * Attempt and its children keep running, and nothing stops or fails them on
 * this report (ADR 0013).
 */
export class WorkerUnresponsive extends Schema.TaggedClass<WorkerUnresponsive>(
  "AttemptChannel/WorkerUnresponsive",
)("WorkerUnresponsive", {
  worker: WorkerName,
  /** When the Worker last answered a probe, or when the Attempt launched if no probe has run yet. */
  lastAnsweredAt: Schema.DateTimeUtcFromString,
  /** What the failed probe saw, such as the SSH client's error or the bound it exceeded. */
  reason: Schema.NonEmptyString,
}) {}

/** The Worker answers the executor's probe again after `WorkerUnresponsive`. */
export class WorkerResponsive extends Schema.TaggedClass<WorkerResponsive>(
  "AttemptChannel/WorkerResponsive",
)("WorkerResponsive", {
  worker: WorkerName,
  /** When the Worker last answered before it stopped, as `WorkerUnresponsive` reported it. */
  lastAnsweredAt: Schema.DateTimeUtcFromString,
}) {}

/** What the executor reports about an Attempt's Worker while the Attempt runs. */
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
  /** The session this envelope addresses; the Pi parent unless a child is named. */
  target: SessionTarget.pipe(Schema.withDecodingDefaultKey(Effect.succeed({ _tag: "Parent" }))),
  operator: Schema.NonEmptyString,
  payload: InboundPayload,
}) {}

export const Envelope = Schema.Union([OutboundEnvelope, InboundEnvelope]);
export type Envelope = typeof Envelope.Type;

/**
 * The orchestrator's side of one Attempt for its executor: where it persists
 * envelopes and the records of an Attempt that ended without success, and
 * what the harvest reads from its records.
 */
export interface Sink {
  readonly append: (
    direction: Direction,
    envelope: Envelope,
  ) => Effect.Effect<void, AttemptFailure>;
  /** Records what the executor preserved of the workspace after the Attempt ended without success. */
  readonly salvage: (salvage: AttemptSalvage) => Effect.Effect<void, AttemptFailure>;
  /** Records the comments and reviews the Attempt posted on its Run's Item before it ended without success. */
  readonly comments: (comments: ReadonlyArray<Comment>) => Effect.Effect<void, AttemptFailure>;
  /**
   * The Attempt's own window on its Run's Item and the windows of the other
   * Attempts of its Agent that overlap it there. The harvest reads them once
   * GitHub has listed the Attempt's comments, so they include Attempts that
   * started after it, even while the harvest ran, and the end recorded when
   * the Attempt was closed before its harvest, as on a cancel. It keeps only a
   * comment posted inside the own window and in none of the others.
   */
  readonly windows: Effect.Effect<AttemptWindows, AttemptFailure>;
  /**
   * The envelopes `append` recorded for the Attempt so far, in the order they
   * were appended. An executor reattaching the Attempt after an orchestrator
   * restart reads them to resume what it counted from the Attempt's activity,
   * such as its runaway guard.
   */
  readonly transcript: Effect.Effect<ReadonlyArray<Envelope>, AttemptFailure>;
}

/** How far one outbound channel has legally progressed. */
export interface Progress {
  readonly state: "AwaitingStarted" | "Running" | "Terminal";
  readonly nextSequence: number;
}

export const initialProgress: Progress = { state: "AwaitingStarted", nextSequence: 1 };

/** One protocol violation, described for the infra failure that reports it. */
export interface Violation {
  readonly message: string;
  readonly detail: string;
}

const isTerminal = (payload: OutboundPayload): boolean =>
  payload._tag === "Final" || payload._tag === "Failed" || payload._tag === "Interrupted";

/**
 * Checks one outbound envelope against the progress so far and returns the next
 * progress, or the violation. Whatever sends outbound envelopes folds each
 * one through it before appending it.
 */
export const admit = (
  progress: Progress,
  attemptId: AttemptId,
  envelope: OutboundEnvelope,
): Result.Result<Progress, Violation> => {
  if (envelope.attemptId !== attemptId) {
    return Result.fail({
      message: "The outbound channel carried an envelope for another Attempt",
      detail: String(envelope.attemptId),
    });
  }
  if (envelope.sequence !== progress.nextSequence) {
    return Result.fail({
      message: "The outbound channel carried a non-contiguous sequence",
      detail: `expected ${progress.nextSequence}, received ${envelope.sequence}`,
    });
  }
  if (progress.state === "Terminal") {
    return Result.fail({
      message: "The outbound channel carried an envelope after its terminal envelope",
      detail: envelope.payload._tag,
    });
  }
  if (
    progress.state === "AwaitingStarted" &&
    envelope.payload._tag !== "Started" &&
    envelope.payload._tag !== "Failed"
  ) {
    return Result.fail({
      message: "The outbound channel did not begin with a Started or Failed envelope",
      detail: envelope.payload._tag,
    });
  }
  if (progress.state === "Running" && envelope.payload._tag === "Started") {
    return Result.fail({
      message: "The outbound channel carried more than one Started envelope",
      detail: "duplicate Started envelope",
    });
  }
  return Result.succeed({
    state: isTerminal(envelope.payload) ? "Terminal" : "Running",
    nextSequence: progress.nextSequence + 1,
  });
};
