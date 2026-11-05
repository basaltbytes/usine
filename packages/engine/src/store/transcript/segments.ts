import * as AttemptChannel from "@usine/core/attempt/channel";
import { and, asc, desc, eq, gt, lt } from "drizzle-orm";
import { Effect, Option, Schema } from "effect";
import type { RunDatabaseClient } from "../../database/database.ts";
import { attemptTranscripts, transcriptSegments } from "../../database/schema.ts";
import { TranscriptEntry, type TranscriptQuery, TranscriptSequence } from "../../transcript.ts";
import { decodeTranscriptRows, transcriptEntryFromRow } from "../codec.ts";
import type { TranscriptCodec } from "./codec.ts";

export const StoredTranscriptRow = Schema.Struct({
  sequence: TranscriptSequence,
  direction: AttemptChannel.Direction,
  channelSequence: AttemptChannel.Sequence,
  receivedAt: Schema.String,
  envelope: Schema.Json,
});
const StoredRowJson = Schema.fromJsonString(StoredTranscriptRow);
const Segment = Schema.Struct({ codec: Schema.Literal("brotli"), body: Schema.Uint8Array });

const bySequence = (left: TranscriptEntry, right: TranscriptEntry) =>
  left.sequence - right.sequence;

const selectEntries = (entries: Array<TranscriptEntry>, query: TranscriptQuery) => {
  entries.sort(bySequence);
  switch (query._tag) {
    case "TranscriptTailQuery":
      return entries.filter(({ sequence }) => sequence > query.after).slice(0, query.limit);
    case "TranscriptPageQuery":
      return entries
        .filter(({ sequence }) => Option.isNone(query.before) || sequence < query.before.value)
        .slice(-query.limit);
    case "TranscriptWorkerQuery":
      return entries
        .filter(
          ({ direction, envelope }) =>
            direction === "outbound" &&
            (envelope.payload._tag === "WorkerResponsive" ||
              envelope.payload._tag === "WorkerUnresponsive"),
        )
        .slice(-1);
    case "TranscriptSessionsQuery": {
      const latest = new Map<string, TranscriptEntry>();
      for (const entry of entries) {
        const payload = entry.envelope.payload;
        if (payload._tag === "SessionEvent") {
          const event = payload.event;
          switch (event._tag) {
            case "SessionStarted":
              latest.set(`launch:${event.session.id}`, entry);
              break;
            case "SessionIdle":
            case "SessionResumed":
            case "SessionFinished":
              latest.set(`state:${event.session.id}`, entry);
              break;
          }
        } else if (
          payload._tag === "InterventionApplied" ||
          payload._tag === "InterventionRejected"
        ) {
          const target = payload.intervention.target;
          latest.set(
            `input:${target._tag === "Child" ? target.sessionId : "@parent"}:${payload.inputSequence}`,
            entry,
          );
        }
      }
      return [...latest.values()].sort(bySequence);
    }
    default:
      return entries;
  }
};

/** Reads only the segments needed for a page, then merges late hot rows in the same snapshot. */
export const sealedTranscript = Effect.fn("SqliteTranscript.readSealed")(function* (
  database: RunDatabaseClient,
  codec: TranscriptCodec["Service"],
  query: TranscriptQuery,
) {
  yield* Effect.annotateCurrentSpan({ attemptId: query.attemptId, query: query._tag });
  const page = query._tag === "TranscriptPageQuery";
  const after = query._tag === "TranscriptTailQuery" ? query.after : undefined;
  const before = page ? Option.getOrUndefined(query.before) : undefined;
  const limit = page || query._tag === "TranscriptTailQuery" ? query.limit : undefined;
  const hot = database
    .select({
      sequence: attemptTranscripts.sequence,
      attemptId: attemptTranscripts.attemptId,
      direction: attemptTranscripts.direction,
      receivedAt: attemptTranscripts.receivedAt,
      envelope: attemptTranscripts.envelope,
    })
    .from(attemptTranscripts)
    .where(
      and(
        eq(attemptTranscripts.attemptId, query.attemptId),
        after === undefined ? undefined : gt(attemptTranscripts.sequence, after),
        before === undefined ? undefined : lt(attemptTranscripts.sequence, before),
      ),
    )
    .orderBy(page ? desc(attemptTranscripts.sequence) : asc(attemptTranscripts.sequence));
  const hotRows = yield* (limit === undefined ? hot : hot.limit(limit)).execute();
  const entries = (yield* decodeTranscriptRows(hotRows, { onExcessProperty: "error" })).map(
    transcriptEntryFromRow,
  );
  const storedRanges = yield* database
    .select({ firstSequence: transcriptSegments.firstSequence })
    .from(transcriptSegments)
    .where(
      and(
        eq(transcriptSegments.attemptId, query.attemptId),
        after === undefined ? undefined : gt(transcriptSegments.lastSequence, after),
        before === undefined ? undefined : lt(transcriptSegments.firstSequence, before),
      ),
    )
    .orderBy(page ? desc(transcriptSegments.firstSequence) : asc(transcriptSegments.firstSequence))
    .execute();
  const ranges = yield* Schema.decodeEffect(
    Schema.Array(Schema.Struct({ firstSequence: TranscriptSequence })),
  )(storedRanges);
  let segmentRows = 0;
  for (const range of ranges) {
    // Late hot rows follow every sealed segment, so a full newest page needs no segments.
    if (page && limit !== undefined && entries.length >= limit) break;
    const bodies = yield* database
      .select({ codec: transcriptSegments.codec, body: transcriptSegments.body })
      .from(transcriptSegments)
      .where(
        and(
          eq(transcriptSegments.attemptId, query.attemptId),
          eq(transcriptSegments.firstSequence, range.firstSequence),
        ),
      )
      .execute();
    for (const body of bodies) {
      const segment = yield* Schema.decodeEffect(Segment)(body, { onExcessProperty: "error" });
      const raw = yield* codec.decompress(segment.body);
      const rows = yield* Effect.forEach(raw.trimEnd().split("\n"), (line) =>
        Schema.decodeEffect(StoredRowJson)(line, { onExcessProperty: "error" }),
      );
      const decoded = yield* decodeTranscriptRows(
        rows.map(({ channelSequence: _channelSequence, ...row }) => ({
          ...row,
          attemptId: query.attemptId,
        })),
        { onExcessProperty: "error" },
      );
      const selected = decoded.filter(
        ({ sequence }) =>
          (after === undefined || sequence > after) && (before === undefined || sequence < before),
      );
      entries.push(...selected.map(transcriptEntryFromRow));
      segmentRows += selected.length;
    }
    if (!page && limit !== undefined && segmentRows >= limit) break;
  }
  return selectEntries(entries, query);
});
