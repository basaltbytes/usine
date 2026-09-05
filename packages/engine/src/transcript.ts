import * as AttemptChannel from "@usine/core/attempt/channel";
import { AttemptId } from "@usine/core/attempt";
import { Schema } from "effect";

/**
 * Value object: global append order of the persisted transcript — the tail
 * cursor. Distinct from `AttemptChannel.Sequence`, which orders messages
 * within one Attempt's channel direction.
 */
export const TranscriptSequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("TranscriptSequence"),
);

export type TranscriptSequence = typeof TranscriptSequence.Type;

const LEGACY_TRANSCRIPT_PROTOCOL_VERSION = 3 as const;

const LegacyTranscriptEnvelope = Schema.Union([
  Schema.Struct({
    ...AttemptChannel.OutboundEnvelope.fields,
    version: Schema.Literal(LEGACY_TRANSCRIPT_PROTOCOL_VERSION),
  }),
  Schema.Struct({
    ...AttemptChannel.InboundEnvelope.fields,
    version: Schema.Literal(LEGACY_TRANSCRIPT_PROTOCOL_VERSION),
  }),
]);

/** Durable v3 envelopes remain readable; the live Attempt channel stays v4-only. */
const TranscriptEnvelope = Schema.Union([AttemptChannel.Envelope, LegacyTranscriptEnvelope]);

/** One append-only row in an Attempt transcript. */
export class TranscriptEntry extends Schema.Class<TranscriptEntry>("@usine/engine/TranscriptEntry")(
  {
    sequence: TranscriptSequence,
    attemptId: AttemptId,
    direction: AttemptChannel.Direction,
    envelope: TranscriptEnvelope,
    receivedAt: Schema.DateTimeUtc,
  },
) {}

/** Read every row for one Attempt. Intended for execution and diagnostic consumers. */
export class TranscriptAllQuery extends Schema.TaggedClass<TranscriptAllQuery>(
  "@usine/engine/TranscriptAllQuery",
)("TranscriptAllQuery", { attemptId: AttemptId }) {}

/** Read rows appended after a cursor while tailing a live Attempt. */
export class TranscriptTailQuery extends Schema.TaggedClass<TranscriptTailQuery>(
  "@usine/engine/TranscriptTailQuery",
)("TranscriptTailQuery", {
  attemptId: AttemptId,
  after: TranscriptSequence,
  limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
}) {}

/** Read the newest bounded page before a cursor, or from the current tail. */
export class TranscriptPageQuery extends Schema.TaggedClass<TranscriptPageQuery>(
  "@usine/engine/TranscriptPageQuery",
)("TranscriptPageQuery", {
  attemptId: AttemptId,
  before: Schema.Option(TranscriptSequence),
  limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
}) {}

/** Illegal combinations of full, tail, and backward-page reads are unrepresentable. */
export const TranscriptQuery = Schema.Union([
  TranscriptAllQuery,
  TranscriptTailQuery,
  TranscriptPageQuery,
]);

export type TranscriptQuery = typeof TranscriptQuery.Type;
