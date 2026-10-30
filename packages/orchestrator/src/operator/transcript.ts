import { AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { RunId } from "@usine/core/run";
import { TranscriptSequence } from "@usine/engine/transcript";
import { Schema } from "effect";
import { FailureView } from "./attempt.ts";

/** An Attempt failure in the transcript with only displayable details. */
export class FailedTranscriptView extends Schema.TaggedClass<FailedTranscriptView>(
  "@usine/orchestrator/FailedTranscriptView",
)("Failed", {
  /** The attempt failure with safe operator-facing details. */
  failure: FailureView,
}) {}

/** The Attempt channel messages shown to the operator, with defect causes removed from failures. */
export const TranscriptPayload = Schema.Union([
  AttemptChannel.Started,
  AttemptChannel.SessionEvent,
  AttemptChannel.Final,
  FailedTranscriptView,
  AttemptChannel.Interrupted,
  AttemptChannel.Steer,
  AttemptChannel.Interrupt,
  AttemptChannel.OperatorMessage,
  AttemptChannel.Release,
  AttemptChannel.Cancel,
  AttemptChannel.InterventionApplied,
  AttemptChannel.InterventionRejected,
  AttemptChannel.WorkerUnresponsive,
  AttemptChannel.WorkerResponsive,
]);
/** The attempt channel messages shown to the operator, with defect causes removed from failures. */
export type TranscriptPayload = typeof TranscriptPayload.Type;

/** A stored Attempt channel message with its sequence, direction, and receipt time. */
export class TranscriptEventView extends Schema.Class<TranscriptEventView>(
  "@usine/orchestrator/TranscriptEventView",
)({
  /** The durable transcript sequence used for paging. */
  sequence: TranscriptSequence,
  /** The attempt associated with this entry. */
  attemptId: AttemptId,
  /** The time the orchestrator stored the event, as an ISO 8601 timestamp. */
  receivedAt: Schema.String,
  /** Whether the message came from the attempt or the operator. */
  direction: AttemptChannel.Direction,
  /** The parent or child session addressed by an operator message; omitted when not recorded. */
  target: Schema.optionalKey(AttemptChannel.SessionTarget),
  /** The operator login for an intervention; omitted when not recorded. */
  operator: Schema.optionalKey(Schema.NonEmptyString),
  /** The stored attempt message with failure details sanitized for display. */
  payload: TranscriptPayload,
}) {}

/** The start of the next earlier transcript page within one Attempt. */
export class TranscriptPageCursor extends Schema.Class<TranscriptPageCursor>(
  "@usine/orchestrator/TranscriptPageCursor",
)({
  /** The attempt associated with this entry. */
  attemptId: AttemptId,
  /** The exclusive sequence boundary for reading earlier rows of this attempt. */
  before: TranscriptSequence,
}) {}

/** A request for the newest bounded transcript window when a Run opens. */
export class ColdTranscriptRequest extends Schema.TaggedClass<ColdTranscriptRequest>(
  "@usine/orchestrator/ColdTranscriptRequest",
)("ColdTranscriptRequest", {}) {}

/** A request for transcript events after the last seen sequence. */
export class TailTranscriptRequest extends Schema.TaggedClass<TailTranscriptRequest>(
  "@usine/orchestrator/TailTranscriptRequest",
)("TailTranscriptRequest", {
  /** The exclusive sequence boundary for reading newer rows across the run. */
  after: TranscriptSequence,
}) {}

/** A request for an earlier page before a sequence within one Attempt. */
export class EarlierTranscriptRequest extends Schema.TaggedClass<EarlierTranscriptRequest>(
  "@usine/orchestrator/EarlierTranscriptRequest",
)("EarlierTranscriptRequest", {
  /** The attempt associated with this entry. */
  attemptId: AttemptId,
  /** The exclusive sequence boundary for reading older rows of the requested attempt. */
  before: TranscriptSequence,
}) {}

/** A request for the initial window, live tail, or an earlier page of a Run transcript. */
export const TranscriptRequest = Schema.Union([
  ColdTranscriptRequest,
  TailTranscriptRequest,
  EarlierTranscriptRequest,
]);
/** A request for the initial window, live tail, or an earlier page of a run transcript. */
export type TranscriptRequest = typeof TranscriptRequest.Type;

/** The requested Attempt isn't in the Run whose transcript is being read. */
export class TranscriptAttemptNotFoundError extends Schema.TaggedError<TranscriptAttemptNotFoundError>(
  "@usine/orchestrator/TranscriptAttemptNotFoundError",
)("TranscriptAttemptNotFoundError", {
  /** The run associated with this entry. */
  runId: RunId,
  /** The attempt associated with this entry. */
  attemptId: AttemptId,
}) {}
