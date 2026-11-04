import * as AttemptChannel from "@usine/core/attempt/channel";

import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";

import { DateTime, Effect, Match, Option } from "effect";
import { jsonExtract, jsonSet, jsonValue } from "../database/dialect.ts";
import type { RunDatabaseClient } from "../database/database.ts";
import { attemptTranscripts, poolRateLimits, sessionUsage } from "../database/schema.ts";

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
    yield* Effect.annotateCurrentSpan({ attemptId: envelope.attemptId, direction });
    const values = {
      attemptId: envelope.attemptId,
      envelope: yield* encodeEnvelope(envelope),
      receivedAt: encodeDateTime(receivedAt),
    };
    const inserted = yield* database
      .insert(attemptTranscripts)
      .values({ ...values, direction, channelSequence: envelope.sequence })
      .onConflictDoNothing()
      .returning({ sequence: attemptTranscripts.sequence })
      .execute();
    const row = inserted[0];
    if (row === undefined) return false;
    if (direction !== "outbound" || envelope.payload._tag !== "SessionEvent") return true;

    const event = envelope.payload.event;
    if (event._tag === "SessionTokensUpdated") {
      yield* Effect.annotateCurrentSpan({ sessionId: event.session.id });
      const usage = { ...values, sequence: row.sequence, totalTokens: event.totalTokens };
      const updated = yield* database
        .insert(sessionUsage)
        .values({ ...usage, sessionId: event.session.id })
        .onConflictDoUpdate({
          target: [sessionUsage.attemptId, sessionUsage.sessionId],
          set: usage,
          setWhere: gt(sql`excluded.total_tokens`, sessionUsage.totalTokens),
        })
        .returning({ sequence: sessionUsage.sequence })
        .execute();
      yield* Effect.logDebug(
        updated.length > 0
          ? "Session usage projection advanced"
          : "Token report did not exceed stored session usage",
        {
          attemptId: envelope.attemptId,
          sessionId: event.session.id,
          sequence: row.sequence,
          totalTokens: event.totalTokens,
          updated: updated.length > 0,
        },
      );
    } else if (event._tag === "PoolRateLimitsUpdated") {
      yield* Effect.annotateCurrentSpan({ pool: event.pool });
      const limits = { ...values, sequence: row.sequence };
      const updated = yield* database
        .insert(poolRateLimits)
        .values({ ...limits, pool: event.pool })
        .onConflictDoUpdate({
          target: poolRateLimits.pool,
          set: {
            ...limits,
            envelope:
              event.pool === "claudePlan"
                ? jsonSet(
                    sql`excluded.envelope`,
                    ["primary", "secondary"].map((window) => {
                      const path = `$.payload.event.rateLimits.${window}`;
                      return [
                        path,
                        jsonValue(
                          sql`coalesce(${jsonExtract(sql`excluded.envelope`, path)}, ${jsonExtract(poolRateLimits.envelope, path)})`,
                        ),
                      ];
                    }),
                  )
                : limits.envelope,
          },
          setWhere: gt(sql`excluded.sequence`, poolRateLimits.sequence),
        })
        .returning({ sequence: poolRateLimits.sequence })
        .execute();
      yield* Effect.logDebug(
        updated.length > 0
          ? "Pool rate-limit projection advanced"
          : "Pool report did not advance transcript sequence",
        {
          attemptId: envelope.attemptId,
          pool: event.pool,
          sequence: row.sequence,
          updated: updated.length > 0,
        },
      );
    }
    return true;
  });

  const transcript = Effect.fn("RunStoreQueries.transcript")(function* (query: TranscriptQuery) {
    yield* Effect.annotateCurrentSpan({ attemptId: query.attemptId, query: query._tag });
    const selection = database
      .select({
        sequence: attemptTranscripts.sequence,
        attemptId: attemptTranscripts.attemptId,
        direction: attemptTranscripts.direction,
        envelope: attemptTranscripts.envelope,
        receivedAt: attemptTranscripts.receivedAt,
      })
      .from(attemptTranscripts);
    const attempt = eq(attemptTranscripts.attemptId, query.attemptId);
    const rows = yield* Match.valueTags(query, {
      TranscriptUsageQuery: () =>
        database
          .select({
            sequence: sessionUsage.sequence,
            attemptId: sessionUsage.attemptId,
            direction: sql<AttemptChannel.Direction>`'outbound'`,
            envelope: sessionUsage.envelope,
            receivedAt: sessionUsage.receivedAt,
          })
          .from(sessionUsage)
          .where(eq(sessionUsage.attemptId, query.attemptId))
          .orderBy(asc(sessionUsage.sequence))
          .execute(),
      TranscriptWorkerQuery: () =>
        selection
          .where(
            eq(
              attemptTranscripts.sequence,
              database
                .select({
                  sequence: sql<number>`max(${attemptTranscripts.sequence})`.as("sequence"),
                })
                .from(attemptTranscripts)
                .where(
                  and(
                    attempt,
                    eq(attemptTranscripts.direction, "outbound"),
                    inArray(attemptTranscripts.payloadTag, [
                      "WorkerUnresponsive",
                      "WorkerResponsive",
                    ]),
                    isNull(attemptTranscripts.eventTag),
                  ),
                ),
            ),
          )
          .execute(),
      TranscriptSessionsQuery: () => {
        const latestSessions = database
          .select({ sequence: sql<number>`max(${attemptTranscripts.sequence})`.as("sequence") })
          .from(attemptTranscripts)
          .where(
            and(
              attempt,
              eq(attemptTranscripts.payloadTag, "SessionEvent"),
              inArray(attemptTranscripts.eventTag, [
                "SessionStarted",
                "SessionIdle",
                "SessionResumed",
                "SessionFinished",
              ]),
            ),
          )
          .groupBy(
            attemptTranscripts.sessionId,
            // Keeps launch metadata next to the latest lifecycle state, even after completion.
            sql`${attemptTranscripts.eventTag} = 'SessionStarted'`,
          );
        const latestInterventions = database
          .select({ sequence: sql<number>`max(${attemptTranscripts.sequence})`.as("sequence") })
          .from(attemptTranscripts)
          .where(
            and(
              attempt,
              inArray(attemptTranscripts.payloadTag, [
                "InterventionApplied",
                "InterventionRejected",
              ]),
            ),
          )
          .groupBy(
            sql`coalesce(${attemptTranscripts.sessionId}, '@parent')`,
            jsonExtract(attemptTranscripts.envelope, "$.payload.inputSequence"),
          );
        return selection
          .where(inArray(attemptTranscripts.sequence, latestSessions.unionAll(latestInterventions)))
          .orderBy(asc(attemptTranscripts.sequence))
          .execute();
      },
      TranscriptAllQuery: () =>
        selection.where(attempt).orderBy(asc(attemptTranscripts.sequence)).execute(),
      TranscriptTailQuery: ({ after, limit }) =>
        selection
          .where(and(attempt, gt(attemptTranscripts.sequence, after)))
          .orderBy(asc(attemptTranscripts.sequence))
          .limit(limit)
          .execute(),
      TranscriptPageQuery: ({ before, limit }) =>
        selection
          .where(
            and(
              attempt,
              Option.match(before, {
                onNone: () => undefined,
                onSome: (sequence) => lt(attemptTranscripts.sequence, sequence),
              }),
            ),
          )
          .orderBy(desc(attemptTranscripts.sequence))
          .limit(limit)
          .execute(),
    });
    // An unknown key in a transcript row is corruption.

    return (yield* decodeTranscriptRows(rows, { onExcessProperty: "error" }))
      .map(transcriptEntryFromRow)
      .sort((left, right) => left.sequence - right.sequence);
  });

  return { appendTranscript, transcript };
};
