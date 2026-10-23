import * as AttemptChannel from "@usine/core/attempt/channel";
import { AttemptId } from "@usine/core/attempt";
import { Schema } from "effect";

/** The global append order of the stored transcript; distinct from `AttemptChannel.Sequence`. */
export const TranscriptSequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("TranscriptSequence"),
);

export type TranscriptSequence = typeof TranscriptSequence.Type;

/**
 * The stored protocol versions that need a separate schema: v3 and v4 inbound frames have no
 * session target and only Steer or Interrupt payloads.
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
 * The stored protocol versions that the current schema still decodes; v7 changed only the
 * unstored `Start` frame. Each version bump must add the retired version here.
 */
const COMPATIBLE_TRANSCRIPT_PROTOCOL_VERSIONS = [5, 6] as const;
const CompatibleVersion = Schema.Literals(COMPATIBLE_TRANSCRIPT_PROTOCOL_VERSIONS);

/** A stored envelope of protocol v3 to v7; the live channel uses only v7. */
const TranscriptEnvelope = Schema.Union([
  AttemptChannel.Envelope,
  Schema.Struct({ ...AttemptChannel.OutboundEnvelope.fields, version: CompatibleVersion }),
  Schema.Struct({ ...AttemptChannel.InboundEnvelope.fields, version: CompatibleVersion }),
  LegacyOutboundEnvelope,
  LegacyInboundEnvelope,
]);

/** An append-only row of an Attempt transcript. */
export class TranscriptEntry extends Schema.Class<TranscriptEntry>("@usine/engine/TranscriptEntry")(
  {
    sequence: TranscriptSequence,
    attemptId: AttemptId,
    direction: AttemptChannel.Direction,
    envelope: TranscriptEnvelope,
    receivedAt: Schema.DateTimeUtc,
  },
) {}

/** A query for all rows of one Attempt, in append order. */
export class TranscriptAllQuery extends Schema.TaggedClass<TranscriptAllQuery>(
  "@usine/engine/TranscriptAllQuery",
)("TranscriptAllQuery", { attemptId: AttemptId }) {}

/** A query for each session's launch metadata, latest lifecycle, and supervision receipt. */
export class TranscriptSessionsQuery extends Schema.TaggedClass<TranscriptSessionsQuery>(
  "@usine/engine/TranscriptSessionsQuery",
)("TranscriptSessionsQuery", { attemptId: AttemptId }) {}

/** A query for each session's highest `SessionTokensUpdated` report, which is its cumulative usage. */
export class TranscriptUsageQuery extends Schema.TaggedClass<TranscriptUsageQuery>(
  "@usine/engine/TranscriptUsageQuery",
)("TranscriptUsageQuery", { attemptId: AttemptId }) {}

/** A query for up to `limit` rows after `after`, in append order. */
export class TranscriptTailQuery extends Schema.TaggedClass<TranscriptTailQuery>(
  "@usine/engine/TranscriptTailQuery",
)("TranscriptTailQuery", {
  attemptId: AttemptId,
  /** The last row already received, excluded from the response. */
  after: TranscriptSequence,
  limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
}) {}

/** A query for the newest `limit` rows before `before`, returned in append order. */
export class TranscriptPageQuery extends Schema.TaggedClass<TranscriptPageQuery>(
  "@usine/engine/TranscriptPageQuery",
)("TranscriptPageQuery", {
  attemptId: AttemptId,
  /** The earliest row already loaded, excluded from the response, or `None` to start at the tail. */
  before: Schema.Option(TranscriptSequence),
  limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
}) {}

export const TranscriptQuery = Schema.Union([
  TranscriptAllQuery,
  TranscriptSessionsQuery,
  TranscriptUsageQuery,
  TranscriptTailQuery,
  TranscriptPageQuery,
]);

export type TranscriptQuery = typeof TranscriptQuery.Type;
