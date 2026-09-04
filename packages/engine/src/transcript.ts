import * as AttemptChannel from "@usine/core/attempt/channel";
import { AttemptId } from "@usine/core/attempt";
import { Schema } from "effect";

/**
 * Global append order of the persisted transcript. Distinct from
 * `AttemptChannel.Sequence`, which orders messages within one Attempt's channel
 * direction.
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

/** Stored v3 envelopes stay readable; the live channel is v4 only. */
const TranscriptEnvelope = Schema.Union([AttemptChannel.Envelope, LegacyTranscriptEnvelope]);

/** One append-only row of an Attempt transcript. */
export class TranscriptEntry extends Schema.Class<TranscriptEntry>("@usine/engine/TranscriptEntry")(
  {
    sequence: TranscriptSequence,
    attemptId: AttemptId,
    direction: AttemptChannel.Direction,
    envelope: TranscriptEnvelope,
    receivedAt: Schema.DateTimeUtc,
  },
) {}

/** Every row for one Attempt, for execution and diagnostics. */
export class TranscriptAllQuery extends Schema.TaggedClass<TranscriptAllQuery>(
  "@usine/engine/TranscriptAllQuery",
)("TranscriptAllQuery", { attemptId: AttemptId }) {}

/** Rows appended after a cursor, for tailing a live Attempt. */
export class TranscriptTailQuery extends Schema.TaggedClass<TranscriptTailQuery>(
  "@usine/engine/TranscriptTailQuery",
)("TranscriptTailQuery", {
  attemptId: AttemptId,
  after: TranscriptSequence,
  limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
}) {}

/** The newest bounded page before a cursor, or from the current tail. */
export class TranscriptPageQuery extends Schema.TaggedClass<TranscriptPageQuery>(
  "@usine/engine/TranscriptPageQuery",
)("TranscriptPageQuery", {
  attemptId: AttemptId,
  before: Schema.Option(TranscriptSequence),
  limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
}) {}

export const TranscriptQuery = Schema.Union([
  TranscriptAllQuery,
  TranscriptTailQuery,
  TranscriptPageQuery,
]);

export type TranscriptQuery = typeof TranscriptQuery.Type;
