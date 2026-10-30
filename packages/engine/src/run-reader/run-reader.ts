import { Context, type DateTime, Effect, Layer, Option, Schema } from "effect";
import { PoolRateLimitsUpdated } from "@usine/core/agent/session";
import { and, eq, inArray, sql } from "drizzle-orm";
import { attemptTranscripts } from "../database/schema.ts";
import { RunId } from "@usine/core/run";
import { ItemKey } from "@usine/core/item";
import { RunDatabase } from "../database/database.ts";
import {
  type LoopSighting,
  ProjectionRevision,
  type RunEvent,
  RunEvidence,
  RunSnapshot,
  RunSummary,
  type WorkerAttempts,
} from "./model.ts";
import { TranscriptAllQuery, TranscriptEntry, TranscriptQuery } from "../transcript.ts";
import type { RunStoreError } from "../engine/error.ts";
import { persistence } from "../store/codec.ts";
import { leftoverQueries } from "../store/leftovers.ts";
import { queriesFor } from "../store/queries.ts";

const makeRunReader = Effect.gen(function* () {
  const database = yield* RunDatabase;
  const queries = queriesFor(database);

  const inspect = Effect.fn("RunReader.inspect")((runId: RunId) =>
    queries.snapshot(runId).pipe(persistence("read run")),
  );
  const evidence = Effect.fn("RunReader.evidence")(function* (runId: RunId) {
    yield* Effect.annotateCurrentSpan({ runId });
    const evidence = yield* database
      .transaction((transaction) =>
        Effect.gen(function* () {
          const queries = queriesFor(transaction);
          const snapshot = yield* queries.snapshot(runId);
          const transcripts = yield* Effect.forEach(snapshot.attempts, ({ id }) =>
            queries.transcript(new TranscriptAllQuery({ attemptId: id })),
          );
          return new RunEvidence({
            snapshot,
            transcript: transcripts.flat().sort((left, right) => left.sequence - right.sequence),
          });
        }),
      )
      .pipe(persistence("read run evidence"));
    yield* Effect.logDebug("Run evidence read", {
      runId,
      attempts: evidence.snapshot.attempts.length,
      transcriptRows: evidence.transcript.length,
    });
    return evidence;
  });
  const list = Effect.fn("RunReader.list")((options: { readonly closedLimit: number }) =>
    queries.runSummaries(options.closedLimit).pipe(persistence("list runs")),
  );
  const closed = Effect.fn("RunReader.closed")((options: { readonly limit: number }) =>
    queries.closedRunSummaries(options.limit).pipe(persistence("list closed runs")),
  );
  const closedSince = Effect.fn("RunReader.closedSince")((since: Option.Option<DateTime.Utc>) =>
    queries.closedRunSummariesSince(since).pipe(persistence("list runs closed since a time")),
  );
  const revision = Effect.fn("RunReader.revision")(() =>
    queries.revision().pipe(persistence("read projection revision")),
  );
  const forItems = Effect.fn("RunReader.forItems")((itemKeys: ReadonlyArray<ItemKey>) =>
    queries.itemRunSummaries(itemKeys).pipe(persistence("read item run histories")),
  );
  const events = Effect.fn("RunReader.events")((runIds: ReadonlyArray<RunId>) =>
    queries.runEvents(runIds).pipe(persistence("read the events of runs")),
  );
  const transcript = Effect.fn("RunReader.transcript")((query: TranscriptQuery) =>
    queries.transcript(query).pipe(persistence("read attempt transcript")),
  );
  const latestPoolRateLimits = Effect.fn("RunReader.latestPoolRateLimits")(function* () {
    const rows = yield* database
      .select({
        event: sql<string>`json_extract(${attemptTranscripts.envelope}, '$.payload.event')`,
      })
      .from(attemptTranscripts)
      .where(
        inArray(
          attemptTranscripts.sequence,
          database
            .select({ sequence: sql<number>`max(${attemptTranscripts.sequence})` })
            .from(attemptTranscripts)
            .where(
              and(
                eq(attemptTranscripts.direction, "outbound"),
                sql`json_extract(${attemptTranscripts.envelope}, '$.payload._tag') = 'SessionEvent'`,
                sql`json_extract(${attemptTranscripts.envelope}, '$.payload.event._tag') = 'PoolRateLimitsUpdated'`,
              ),
            )
            .groupBy(sql`json_extract(${attemptTranscripts.envelope}, '$.payload.event.pool')`),
        ),
      )
      .execute();
    const events = yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({
          event: Schema.fromJsonString(PoolRateLimitsUpdated),
        }),
      ),
    )(rows, { onExcessProperty: "error" });
    yield* Effect.annotateCurrentSpan({ pools: events.map(({ event }) => event.pool) });
    yield* Effect.logDebug("Read latest pool rate limits", {
      pools: events.map(({ event }) => event.pool),
    });
    return events.map(({ event }) => event);
  }, persistence("read latest pool rate limits"));
  const attemptsByWorker = Effect.fn("RunReader.attemptsByWorker")(() =>
    leftoverQueries(database).attemptCountsByWorker().pipe(persistence("count attempts by worker")),
  );
  const sightings = Effect.fn("RunReader.sightings")((itemKeys: ReadonlyArray<ItemKey>) =>
    queries.loopItems.sightings(itemKeys).pipe(persistence("read loop sightings")),
  );

  return {
    inspect,
    evidence,
    list,
    closed,
    closedSince,
    forItems,
    events,
    revision,
    transcript,
    latestPoolRateLimits,
    attemptsByWorker,
    sightings,
  } as const;
});

/** The service that reads saved Run state and transcripts without starting or recovering execution. */
export class RunReader extends Context.Service<
  RunReader,
  {
    /** Returns the Run's state, effective task and Agent, Step result, and Attempt history. */
    readonly inspect: (runId: RunId) => Effect.Effect<RunSnapshot, RunStoreError>;
    /** Returns a Run snapshot and all its transcript entries, in append order, from one transaction. */
    readonly evidence: (runId: RunId) => Effect.Effect<RunEvidence, RunStoreError>;
    /** Returns every open Run plus the newest `closedLimit` closed ones, newest first. */
    readonly list: (options: {
      readonly closedLimit: number;
    }) => Effect.Effect<ReadonlyArray<RunSummary>, RunStoreError>;
    /** Returns the `limit` most recently closed Runs, by close time, newest first. */
    readonly closed: (options: {
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<RunSummary>, RunStoreError>;
    /**
     * Returns every Run that closed at or after `since`, or every closed Run for `None`, by close
     * time, newest first.
     */
    readonly closedSince: (
      since: Option.Option<DateTime.Utc>,
    ) => Effect.Effect<ReadonlyArray<RunSummary>, RunStoreError>;
    /** Returns every Run for `itemKeys`, newest first, with all their Attempts. */
    readonly forItems: (
      itemKeys: ReadonlyArray<ItemKey>,
    ) => Effect.Effect<ReadonlyArray<RunSummary>, RunStoreError>;
    /** Returns the Event each existing Run in `runIds` was opened for, once per Run, in no particular order. */
    readonly events: (
      runIds: ReadonlyArray<RunId>,
    ) => Effect.Effect<ReadonlyArray<RunEvent>, RunStoreError>;
    /** Returns the projection revision. If the row is absent, returns `None`, and every cached projection is stale. */
    readonly revision: () => Effect.Effect<Option.Option<ProjectionRevision>, RunStoreError>;
    /** Returns the requested part of an Attempt's transcript, in append order. */
    readonly transcript: (
      query: TranscriptQuery,
    ) => Effect.Effect<ReadonlyArray<TranscriptEntry>, RunStoreError>;
    /** Returns the newest stored rate-limit event per pool, by global transcript append order. */
    readonly latestPoolRateLimits: () => Effect.Effect<
      ReadonlyArray<PoolRateLimitsUpdated>,
      RunStoreError
    >;
    /** Returns the Attempts that startup reconciliation visits, counted per Worker, by Worker name. */
    readonly attemptsByWorker: () => Effect.Effect<ReadonlyArray<WorkerAttempts>, RunStoreError>;
    /** Returns each Loop's last sighting of the Items in `itemKeys`, one entry per Loop and Item. */
    readonly sightings: (
      itemKeys: ReadonlyArray<ItemKey>,
    ) => Effect.Effect<ReadonlyArray<LoopSighting>, RunStoreError>;
  }
>()("@usine/engine/RunReader") {
  /** Reads the supplied runtime database without starting run recovery or execution. */
  static readonly layer = Layer.effect(RunReader, makeRunReader);
}

export {
  LoopSighting,
  RunEvent,
  RunEvidence,
  RunSnapshot,
  RunSummary,
  ProjectionRevision,
  WorkerAttempts,
} from "./model.ts";
