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

/**
 * Protocol versions whose envelopes predate the current wire schema but remain in
 * stored transcripts: v3 and v4 inbound frames carry no session target and only
 * Steer or Interrupt payloads, so they decode against a narrowed shape.
 */
const LEGACY_TRANSCRIPT_PROTOCOL_VERSIONS = [3, 4] as const;
const LegacyVersion = Schema.Literals(LEGACY_TRANSCRIPT_PROTOCOL_VERSIONS);

const LegacyOutboundEnvelope = Schema.Struct({
  ...AttemptChannel.OutboundEnvelope.fields,
  version: LegacyVersion,
});

const LegacyInboundEnvelope = Schema.Struct({
  _tag: Schema.Literal("InboundEnvelope"),
  version: LegacyVersion,
  attemptId: AttemptId,
  sequence: AttemptChannel.Sequence,
  sentAt: Schema.DateTimeUtcFromString,
  payload: Schema.Union([AttemptChannel.Steer, AttemptChannel.Interrupt]),
});

/**
 * Protocol versions whose envelopes the current wire schema still decodes: v6 added
 * optional harness session metadata and v7 changed only the `Start` frame,
 * which is never stored. Each bump must list the version it retires here.
 */
const COMPATIBLE_TRANSCRIPT_PROTOCOL_VERSIONS = [5, 6] as const;
const CompatibleVersion = Schema.Literals(COMPATIBLE_TRANSCRIPT_PROTOCOL_VERSIONS);

/** Stored v3–v6 envelopes stay readable; the live channel is v7 only. */
const TranscriptEnvelope = Schema.Union([
  AttemptChannel.Envelope,
  Schema.Struct({ ...AttemptChannel.OutboundEnvelope.fields, version: CompatibleVersion }),
  Schema.Struct({ ...AttemptChannel.InboundEnvelope.fields, version: CompatibleVersion }),
  LegacyOutboundEnvelope,
  LegacyInboundEnvelope,
]);

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

/** Launch metadata, latest lifecycle, and supervision receipt per session, independent of the visible page. */
export class TranscriptSessionsQuery extends Schema.TaggedClass<TranscriptSessionsQuery>(
  "@usine/engine/TranscriptSessionsQuery",
)("TranscriptSessionsQuery", { attemptId: AttemptId }) {}

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
  TranscriptSessionsQuery,
  TranscriptTailQuery,
  TranscriptPageQuery,
]);

export type TranscriptQuery = typeof TranscriptQuery.Type;
