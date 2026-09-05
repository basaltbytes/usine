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

/** All persisted rows for one Attempt, in append order. */
export class TranscriptAllQuery extends Schema.TaggedClass<TranscriptAllQuery>(
  "@usine/engine/TranscriptAllQuery",
)("TranscriptAllQuery", { attemptId: AttemptId }) {}

/** The next bounded set of rows after a cursor, in append order, for following an Attempt's activity. */
export class TranscriptTailQuery extends Schema.TaggedClass<TranscriptTailQuery>(
  "@usine/engine/TranscriptTailQuery",
)("TranscriptTailQuery", {
  attemptId: AttemptId,
  /** Last row already received; the response excludes this row. */
  after: TranscriptSequence,
  /** Maximum number of newer rows to return. */
  limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
}) {}

/** The newest bounded page before a cursor, returned in append order for loading earlier activity. */
export class TranscriptPageQuery extends Schema.TaggedClass<TranscriptPageQuery>(
  "@usine/engine/TranscriptPageQuery",
)("TranscriptPageQuery", {
  attemptId: AttemptId,
  /** Earliest row already loaded, excluded from the response; `None` starts at the current tail. */
  before: Schema.Option(TranscriptSequence),
  /** Maximum number of earlier rows to return. */
  limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
}) {}

/** Selects a complete Attempt transcript, newer activity, or an earlier page. */
export const TranscriptQuery = Schema.Union([
  TranscriptAllQuery,
  TranscriptTailQuery,
  TranscriptPageQuery,
]);

export type TranscriptQuery = typeof TranscriptQuery.Type;
