import * as AttemptChannel from "@usine/core/attempt/channel";

import { and, asc, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";

import { DateTime, Effect, Match, Option } from "effect";
import type { RunDatabaseClient } from "../database/database.ts";
import { attemptTranscripts } from "../database/schema.ts";

import { TranscriptQuery } from "../transcript.ts";

import {
  decodeTranscriptRows,
  encodeDateTime,
  encodeEnvelope,
  transcriptEntryFromRow,
} from "./codec.ts";

/** Owns durable transcript writes and bounded history/session reads on the caller's transaction. */
export const transcriptQueries = (database: RunDatabaseClient) => {
  const appendTranscript = Effect.fn("RunStoreQueries.appendTranscript")(function* (
    direction: AttemptChannel.Direction,
    envelope: AttemptChannel.Envelope,
    receivedAt: DateTime.Utc,
  ) {
    yield* database
      .insert(attemptTranscripts)
      .values({
        attemptId: envelope.attemptId,
        direction,
        channelSequence: envelope.sequence,
        envelope: encodeEnvelope(envelope),
        receivedAt: encodeDateTime(receivedAt),
      })
      .onConflictDoNothing()
      .execute();
  });

  const transcript = Effect.fn("RunStoreQueries.transcript")(function* (query: TranscriptQuery) {
    yield* Effect.annotateCurrentSpan({
      attemptId: query.attemptId,
      query: query._tag,
    });

    const cursor = Match.valueTags(query, {
      TranscriptSessionsQuery: ({ attemptId }) =>
        inArray(
          attemptTranscripts.sequence,
          database
            .select({ sequence: sql<number>`max(${attemptTranscripts.sequence})` })
            .from(attemptTranscripts)
            .where(
              and(
                eq(attemptTranscripts.attemptId, attemptId),
                sql`(
            json_extract(${attemptTranscripts.envelope}, '$.payload._tag') = 'InterventionApplied'
            OR (json_extract(${attemptTranscripts.envelope}, '$.payload._tag') = 'SessionEvent'
              AND json_extract(${attemptTranscripts.envelope}, '$.payload.event._tag') IN ('SessionStarted', 'SessionIdle', 'SessionResumed', 'SessionFinished'))
          )`,
              ),
            )
            .groupBy(
              sql`coalesce(json_extract(${attemptTranscripts.envelope}, '$.payload.event.session.id'), json_extract(${attemptTranscripts.envelope}, '$.payload.intervention.target.sessionId'), '@parent')`,
              sql`json_extract(${attemptTranscripts.envelope}, '$.payload._tag')`,
              // Keep launch metadata alongside the latest lifecycle state, even after completion.
              sql`json_extract(${attemptTranscripts.envelope}, '$.payload.event._tag') = 'SessionStarted'`,
            ),
        ),
      TranscriptAllQuery: ({ attemptId }) => eq(attemptTranscripts.attemptId, attemptId),
      TranscriptTailQuery: ({ attemptId, after }) =>
        and(eq(attemptTranscripts.attemptId, attemptId), gt(attemptTranscripts.sequence, after)),
      TranscriptPageQuery: ({ attemptId, before }) =>
        Option.match(before, {
          onNone: () => eq(attemptTranscripts.attemptId, attemptId),
          onSome: (sequence) =>
            and(
              eq(attemptTranscripts.attemptId, attemptId),
              lt(attemptTranscripts.sequence, sequence),
            ),
        }),
    });
    const selection = database
      .select({
        sequence: attemptTranscripts.sequence,
        attemptId: attemptTranscripts.attemptId,
        direction: attemptTranscripts.direction,
        envelope: attemptTranscripts.envelope,
        receivedAt: attemptTranscripts.receivedAt,
      })
      .from(attemptTranscripts)
      .where(cursor);
    // A limited read walks the tail index backwards for the newest N rows and
    // re-sorts ascending, so callers always receive append order.
    const rows = yield* Match.valueTags(query, {
      TranscriptSessionsQuery: () => selection.orderBy(asc(attemptTranscripts.sequence)).execute(),
      TranscriptAllQuery: () => selection.orderBy(asc(attemptTranscripts.sequence)).execute(),
      TranscriptTailQuery: ({ limit }) =>
        selection.orderBy(asc(attemptTranscripts.sequence)).limit(limit).execute(),
      TranscriptPageQuery: ({ limit }) =>
        selection.orderBy(desc(attemptTranscripts.sequence)).limit(limit).execute(),
    });
    // Transcript rows are usine-owned, so an unknown key is corruption.
    return (yield* decodeTranscriptRows(rows, { onExcessProperty: "error" }))
      .map(transcriptEntryFromRow)
      .sort((left, right) => left.sequence - right.sequence);
  });

  return { appendTranscript, transcript };
};
