import { Schema } from "effect";
import { AttemptId } from "./lifecycle/attempt.ts";
import { AttemptFailure } from "./lifecycle/attempt-failure.ts";
import { CommitSha, Name as RepositoryName, Revision } from "./repository.ts";
import { StepResult } from "./step-result.ts";

export const PROTOCOL_VERSION = 1 as const;

/** Value object: monotonically increasing sequence within one channel direction. */
export const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("AttemptChannelSequence"),
);
export type Sequence = typeof Sequence.Type;

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
  task: Task,
}) {}

export class Started extends Schema.TaggedClass<Started>("AttemptChannel/Started")("Started", {}) {}

export class AgentMessage extends Schema.TaggedClass<AgentMessage>("AttemptChannel/AgentMessage")(
  "AgentMessage",
  {
    message: Schema.NonEmptyString,
  },
) {}

export class Final extends Schema.TaggedClass<Final>("AttemptChannel/Final")("Final", {
  result: StepResult,
}) {}

export class Failed extends Schema.TaggedClass<Failed>("AttemptChannel/Failed")("Failed", {
  failure: AttemptFailure,
}) {}

export const OutboundPayload = Schema.Union([Started, AgentMessage, Final, Failed]);
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
