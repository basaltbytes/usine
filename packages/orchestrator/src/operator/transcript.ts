import { AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { RunId } from "@usine/core/run";
import { TranscriptSequence } from "@usine/engine/transcript";
import { Schema } from "effect";
import { FailureView } from "./attempt.ts";

/** An Attempt failure in the transcript with only displayable details. */
export class FailedTranscriptView extends Schema.TaggedClass<FailedTranscriptView>(
  "@usine/orchestrator/FailedTranscriptView",
)("Failed", { failure: FailureView }) {}

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
export type TranscriptPayload = typeof TranscriptPayload.Type;

/** A stored Attempt channel message with its sequence, direction, and receipt time. */
export class TranscriptEventView extends Schema.Class<TranscriptEventView>(
  "@usine/orchestrator/TranscriptEventView",
)({
  sequence: TranscriptSequence,
  attemptId: AttemptId,
  receivedAt: Schema.String,
  direction: AttemptChannel.Direction,
  target: Schema.optionalKey(AttemptChannel.SessionTarget),
  operator: Schema.optionalKey(Schema.NonEmptyString),
  payload: TranscriptPayload,
}) {}

/** The start of the next earlier transcript page within one Attempt. */
export class TranscriptPageCursor extends Schema.Class<TranscriptPageCursor>(
  "@usine/orchestrator/TranscriptPageCursor",
)({
  attemptId: AttemptId,
  before: TranscriptSequence,
}) {}

/** A request for the newest bounded transcript window when a Run opens. */
export class ColdTranscriptRequest extends Schema.TaggedClass<ColdTranscriptRequest>(
  "@usine/orchestrator/ColdTranscriptRequest",
)("ColdTranscriptRequest", {}) {}

/** A request for transcript events after the last seen sequence. */
export class TailTranscriptRequest extends Schema.TaggedClass<TailTranscriptRequest>(
  "@usine/orchestrator/TailTranscriptRequest",
)("TailTranscriptRequest", { after: TranscriptSequence }) {}

/** A request for an earlier page before a sequence within one Attempt. */
export class EarlierTranscriptRequest extends Schema.TaggedClass<EarlierTranscriptRequest>(
  "@usine/orchestrator/EarlierTranscriptRequest",
)("EarlierTranscriptRequest", {
  attemptId: AttemptId,
  before: TranscriptSequence,
}) {}

/** A request for the initial window, live tail, or an earlier page of a Run transcript. */
export const TranscriptRequest = Schema.Union([
  ColdTranscriptRequest,
  TailTranscriptRequest,
  EarlierTranscriptRequest,
]);
export type TranscriptRequest = typeof TranscriptRequest.Type;

/** The requested Attempt isn't in the Run whose transcript is being read. */
export class TranscriptAttemptNotFoundError extends Schema.TaggedError<TranscriptAttemptNotFoundError>(
  "@usine/orchestrator/TranscriptAttemptNotFoundError",
)("TranscriptAttemptNotFoundError", {
  runId: RunId,
  attemptId: AttemptId,
}) {}
