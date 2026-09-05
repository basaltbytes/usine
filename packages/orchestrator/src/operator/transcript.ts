import { AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { RunId } from "@usine/core/run";
import { TranscriptSequence } from "@usine/engine/transcript";
import { Schema } from "effect";
import { FailureView } from "./attempt.ts";

/** An Attempt failure recorded in the transcript with displayable details only. */
export class FailedTranscriptView extends Schema.TaggedClass<FailedTranscriptView>(
  "@usine/orchestrator/FailedTranscriptView",
)("Failed", { failure: FailureView }) {}

/** Attempt channel messages exposed to the operator, with defect causes removed from failures. */
export const TranscriptPayload = Schema.Union([
  AttemptChannel.Started,
  AttemptChannel.SessionEvent,
  AttemptChannel.Final,
  FailedTranscriptView,
  AttemptChannel.Interrupted,
  AttemptChannel.Steer,
  AttemptChannel.Interrupt,
]);
export type TranscriptPayload = typeof TranscriptPayload.Type;

/** A persisted Attempt channel message with its sequence, direction, and receipt time. */
export class TranscriptEventView extends Schema.Class<TranscriptEventView>(
  "@usine/orchestrator/TranscriptEventView",
)({
  sequence: TranscriptSequence,
  attemptId: AttemptId,
  receivedAt: Schema.String,
  direction: AttemptChannel.Direction,
  payload: TranscriptPayload,
}) {}

/** Where the next earlier transcript page starts, scoped to one Attempt. */
export class TranscriptPageCursor extends Schema.Class<TranscriptPageCursor>(
  "@usine/orchestrator/TranscriptPageCursor",
)({
  attemptId: AttemptId,
  before: TranscriptSequence,
}) {}

/** Requests the newest bounded transcript window when opening a Run. */
export class ColdTranscriptRequest extends Schema.TaggedClass<ColdTranscriptRequest>(
  "@usine/orchestrator/ColdTranscriptRequest",
)("ColdTranscriptRequest", {}) {}

/** Requests transcript events after the last observed sequence. */
export class TailTranscriptRequest extends Schema.TaggedClass<TailTranscriptRequest>(
  "@usine/orchestrator/TailTranscriptRequest",
)("TailTranscriptRequest", { after: TranscriptSequence }) {}

/** Requests an earlier page before a sequence within one Attempt. */
export class EarlierTranscriptRequest extends Schema.TaggedClass<EarlierTranscriptRequest>(
  "@usine/orchestrator/EarlierTranscriptRequest",
)("EarlierTranscriptRequest", {
  attemptId: AttemptId,
  before: TranscriptSequence,
}) {}

/** Selects the initial window, live tail, or earlier page of a Run transcript. */
export const TranscriptRequest = Schema.Union([
  ColdTranscriptRequest,
  TailTranscriptRequest,
  EarlierTranscriptRequest,
]);
export type TranscriptRequest = typeof TranscriptRequest.Type;

/** The requested Attempt is absent from the Run whose transcript is being read. */
export class TranscriptAttemptNotFoundError extends Schema.TaggedError<TranscriptAttemptNotFoundError>(
  "@usine/orchestrator/TranscriptAttemptNotFoundError",
)("TranscriptAttemptNotFoundError", {
  runId: RunId,
  attemptId: AttemptId,
}) {}
