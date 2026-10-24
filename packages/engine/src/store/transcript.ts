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

/** Returns the transcript queries that run on the caller's transaction. */
export const transcriptQueries = (database: RunDatabaseClient) => {
  /**
   * Appends an envelope and returns whether it was new. A redelivered envelope with the same
   * direction and sequence keeps the first stored copy.
   */
  const appendTranscript = Effect.fn("RunStoreQueries.appendTranscript")(function* (
    direction: AttemptChannel.Direction,
    envelope: AttemptChannel.Envelope,
    receivedAt: DateTime.Utc,
  ) {
    const inserted = yield* database
      .insert(attemptTranscripts)
      .values({
        attemptId: envelope.attemptId,
        direction,
        channelSequence: envelope.sequence,
        envelope: encodeEnvelope(envelope),
        receivedAt: encodeDateTime(receivedAt),
      })
      .onConflictDoNothing()
      .returning({ sequence: attemptTranscripts.sequence })
      .execute();
    return inserted.length > 0;
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
              // Keeps launch metadata next to the latest lifecycle state, even after completion.
              sql`json_extract(${attemptTranscripts.envelope}, '$.payload.event._tag') = 'SessionStarted'`,
            ),
        ),
      TranscriptUsageQuery: ({ attemptId }) => {
        // SQLite returns a bare column from the row with the group's max().
        const highest = database
          .select({
            sequence: attemptTranscripts.sequence,
            tokens:
              sql<number>`max(json_extract(${attemptTranscripts.envelope}, '$.payload.event.totalTokens'))`.as(
                "tokens",
              ),
          })
          .from(attemptTranscripts)
          .where(
            and(
              eq(attemptTranscripts.attemptId, attemptId),
              sql`json_extract(${attemptTranscripts.envelope}, '$.payload._tag') = 'SessionEvent'`,
              sql`json_extract(${attemptTranscripts.envelope}, '$.payload.event._tag') = 'SessionTokensUpdated'`,
            ),
          )
          .groupBy(sql`json_extract(${attemptTranscripts.envelope}, '$.payload.event.session.id')`)
          .as("highest");
        return inArray(
          attemptTranscripts.sequence,
          database.select({ sequence: highest.sequence }).from(highest),
        );
      },
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
    // A page query reads the newest rows backwards, then sorts them into append order.
    const rows = yield* Match.valueTags(query, {
      TranscriptSessionsQuery: () => selection.orderBy(asc(attemptTranscripts.sequence)).execute(),
      TranscriptUsageQuery: () => selection.orderBy(asc(attemptTranscripts.sequence)).execute(),
      TranscriptAllQuery: () => selection.orderBy(asc(attemptTranscripts.sequence)).execute(),
      TranscriptTailQuery: ({ limit }) =>
        selection.orderBy(asc(attemptTranscripts.sequence)).limit(limit).execute(),
      TranscriptPageQuery: ({ limit }) =>
        selection.orderBy(desc(attemptTranscripts.sequence)).limit(limit).execute(),
    });
    // An unknown key in a transcript row is corruption.
    return (yield* decodeTranscriptRows(rows, { onExcessProperty: "error" }))
      .map(transcriptEntryFromRow)
      .sort((left, right) => left.sequence - right.sequence);
  });

  return { appendTranscript, transcript };
};
