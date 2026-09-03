import { Result, Schema, type Effect } from "effect";
import { SessionEvent as AgentSessionEvent, Agent, Effort, ModelId } from "./agent.ts";
import { AttemptId } from "./lifecycle/attempt.ts";
import { AttemptFailure } from "./lifecycle/attempt-failure.ts";
import { CommitSha, Name as RepositoryName, Revision } from "./repository.ts";
import { StepResult } from "./step-result.ts";

export const PROTOCOL_VERSION = 3 as const;

/**
 * Value object: monotonically increasing per-Attempt, per-direction message
 * sequence. Distinct from the engine's transcript sequence, which is the
 * global append order of the persisted transcript rows.
 */
export const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("AttemptChannelSequence"),
);
export type Sequence = typeof Sequence.Type;

/**
 * Run-host-relative: `inbound` frames travel orchestrator → run host (Start,
 * Steer, Interrupt); `outbound` frames travel run host → orchestrator.
 */
export const DIRECTIONS = ["inbound", "outbound"] as const;
export const Direction = Schema.Literals(DIRECTIONS);
export type Direction = typeof Direction.Type;

/** Value object: the rendered task text the run host gives the agent. */
export const Task = Schema.String.check(
  Schema.isPattern(/\S/u, { message: "Expected non-blank task text" }),
).pipe(Schema.brand("AttemptTask"));
export type Task = typeof Task.Type;

/** Secret-free launch input. Worker credentials are deliberately absent. */
export class RunSpec extends Schema.Class<RunSpec>("AttemptChannel/RunSpec")({
  attemptId: AttemptId,
  repository: RepositoryName,
  revision: Revision,
  baseCommit: CommitSha,
  payload: Schema.Json,
  task: Task,
  agent: Agent,
  parentModel: Schema.OptionFromNullOr(ModelId),
  parentEffort: Effort,
}) {}

/**
 * The parent model the SDK actually selected at launch — the one effective
 * value the run host knows that the roster may not declare. Child sessions
 * spawn later; their effective brains ride the transcript's `SessionStarted`
 * events (declare by roster, observe by record).
 */
export class Started extends Schema.TaggedClass<Started>("AttemptChannel/Started")("Started", {
  parentModel: ModelId,
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

/** Terminal acknowledgement that the run host stopped on an Interrupt frame. */
export class Interrupted extends Schema.TaggedClass<Interrupted>("AttemptChannel/Interrupted")(
  "Interrupted",
  {},
) {}

export const OutboundPayload = Schema.Union([Started, SessionEvent, Final, Failed, Interrupted]);
export type OutboundPayload = typeof OutboundPayload.Type;

export class Steer extends Schema.TaggedClass<Steer>("AttemptChannel/Steer")("Steer", {
  message: Schema.NonEmptyString,
}) {}

export class Interrupt extends Schema.TaggedClass<Interrupt>("AttemptChannel/Interrupt")(
  "Interrupt",
  {},
) {}

export const InboundPayload = Schema.Union([Steer, Interrupt]);
export type InboundPayload = typeof InboundPayload.Type;

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
  payload: InboundPayload,
}) {}

export const Envelope = Schema.Union([OutboundEnvelope, InboundEnvelope]);
export type Envelope = typeof Envelope.Type;

/** First framed stdin message; later frames are inbound envelopes. */
export class Start extends Schema.TaggedClass<Start>("AttemptChannel/Start")("Start", {
  version: Schema.Literal(PROTOCOL_VERSION),
  spec: RunSpec,
}) {}

export const InputFrame = Schema.Union([Start, InboundEnvelope]);
export type InputFrame = typeof InputFrame.Type;

export const EnvelopeFromJson = Schema.fromJsonString(Envelope);
export const InputFrameFromJson = Schema.fromJsonString(InputFrame);
export const OutboundEnvelopeFromJson = Schema.fromJsonString(OutboundEnvelope);

/** The transcript append seam a channel consumer persists envelopes through. */
export interface Sink {
  readonly append: (
    direction: Direction,
    envelope: Envelope,
  ) => Effect.Effect<void, AttemptFailure>;
}

/** How far one outbound channel has legally progressed. */
export interface Progress {
  readonly state: "AwaitingStarted" | "Running" | "Terminal";
  readonly nextSequence: number;
}

export const initialProgress: Progress = { state: "AwaitingStarted", nextSequence: 1 };

/** One protocol violation, described for the infra-failure that reports it. */
export interface Violation {
  readonly message: string;
  readonly detail: string;
}

const isTerminal = (payload: OutboundPayload): boolean =>
  payload._tag === "Final" || payload._tag === "Failed" || payload._tag === "Interrupted";

/**
 * Pure outbound protocol reducer: admits one envelope
 * against the progress so far, or names the violation. Owning it here keeps
 * every transport adapter folding the same state machine.
 */
export const admit = (
  progress: Progress,
  attemptId: AttemptId,
  envelope: OutboundEnvelope,
): Result.Result<Progress, Violation> => {
  if (envelope.attemptId !== attemptId) {
    return Result.fail({
      message: "The run host emitted a frame for another Attempt",
      detail: String(envelope.attemptId),
    });
  }
  if (envelope.sequence !== progress.nextSequence) {
    return Result.fail({
      message: "The run host emitted a non-contiguous sequence",
      detail: `expected ${progress.nextSequence}, received ${envelope.sequence}`,
    });
  }
  if (progress.state === "Terminal") {
    return Result.fail({
      message: "The run host emitted an envelope after its terminal envelope",
      detail: envelope.payload._tag,
    });
  }
  if (
    progress.state === "AwaitingStarted" &&
    envelope.payload._tag !== "Started" &&
    envelope.payload._tag !== "Failed"
  ) {
    return Result.fail({
      message: "The run host did not begin with a Started or Failed envelope",
      detail: envelope.payload._tag,
    });
  }
  if (progress.state === "Running" && envelope.payload._tag === "Started") {
    return Result.fail({
      message: "The run host emitted more than one Started envelope",
      detail: "duplicate Started envelope",
    });
  }
  return Result.succeed({
    state: isTerminal(envelope.payload) ? "Terminal" : "Running",
    nextSequence: progress.nextSequence + 1,
  });
};
