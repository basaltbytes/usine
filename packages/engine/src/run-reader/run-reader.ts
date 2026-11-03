import { Context, type DateTime, Effect, Layer, Option, Schema } from "effect";
import { PoolRateLimitsUpdated } from "@usine/core/agent/session";
import { eq, sql } from "drizzle-orm";
import { poolRateLimits, events as storedEvents, runs } from "../database/schema.ts";
import type { DedupKey } from "@usine/core/event";
import type { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { ItemKey } from "@usine/core/item";
import { ReadSnapshot, RunDatabase } from "../database/database.ts";
import {
  type LoopSighting,
  ProjectionRevision,
  type RunEvent,
  RunEvidence,
  RunSnapshot,
  RunSummary,
  BoardRunHistory,
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
  const snapshot = yield* ReadSnapshot;

  const inspect = Effect.fn("RunReader.inspect")((runId: RunId) =>
    snapshot.run(database, queries.snapshot(runId)).pipe(persistence("read run")),
  );
  const runForEvent = Effect.fn("RunReader.runForEvent")(function* (dedupKey: DedupKey) {
    yield* Effect.annotateCurrentSpan({ dedupKey });
    const rows = yield* database
      .select({ runId: runs.runId })
      .from(storedEvents)
      .innerJoin(runs, eq(runs.eventId, storedEvents.eventId))
      .where(eq(storedEvents.dedupKey, dedupKey))
      .execute();
    const decoded = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ runId: RunId })),
    )(rows);
    const run = Option.fromNullishOr(decoded[0]);
    yield* Effect.logDebug("Read the run admitted for an event", { dedupKey, run });
    return Option.map(run, ({ runId }) => runId);
  }, persistence("read the run admitted for an event"));
  const evidence = Effect.fn("RunReader.evidence")(function* (runId: RunId) {
    yield* Effect.annotateCurrentSpan({ runId });
    const evidence = yield* snapshot
      .run(
        database,
        Effect.gen(function* () {
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
  const summary = Effect.fn("RunReader.summary")(function* (runId: RunId) {
    yield* Effect.annotateCurrentSpan({ runId });
    const summary = yield* snapshot
      .run(database, queries.runSummary(runId))
      .pipe(persistence("read run summary"));
    yield* Effect.logDebug("Read run summary", { runId, state: summary.run.state._tag });
    return summary;
  });
  const list = Effect.fn("RunReader.list")(function* (options: { readonly closedLimit: number }) {
    yield* Effect.annotateCurrentSpan({ closedLimit: options.closedLimit });
    const summaries = yield* snapshot
      .run(database, queries.runSummaries(options.closedLimit))
      .pipe(persistence("list runs"));
    yield* Effect.logDebug("Read run list", {
      closedLimit: options.closedLimit,
      runs: summaries.length,
    });
    return summaries;
  });
  const closed = Effect.fn("RunReader.closed")(function* (options: {
    readonly limit: number;
    readonly repositories?: ReadonlyArray<RepositoryName>;
  }) {
    yield* Effect.annotateCurrentSpan({
      limit: options.limit,
      repositories: options.repositories ?? "all",
    });
    const summaries = yield* snapshot
      .run(database, queries.closedRunSummaries(options.limit, options.repositories))
      .pipe(persistence("list closed runs"));
    yield* Effect.logDebug("Read closed runs", {
      limit: options.limit,
      repositories: options.repositories ?? "all",
      runs: summaries.length,
    });
    return summaries;
  });
  const closedSince = Effect.fn("RunReader.closedSince")(function* (
    since: Option.Option<DateTime.Utc>,
  ) {
    yield* Effect.annotateCurrentSpan({ since });
    const summaries = yield* snapshot
      .run(database, queries.closedRunSummariesSince(since))
      .pipe(persistence("list runs closed since a time"));
    yield* Effect.logDebug("Read runs closed since a time", { since, runs: summaries.length });
    return summaries;
  });
  const revision = Effect.fn("RunReader.revision")(() =>
    queries.revision().pipe(persistence("read projection revision")),
  );
  const forItems = Effect.fn("RunReader.forItems")(function* (itemKeys: ReadonlyArray<ItemKey>) {
    yield* Effect.annotateCurrentSpan({ itemKeys });
    const summaries = yield* snapshot
      .run(database, queries.itemRunSummaries(itemKeys))
      .pipe(persistence("read item run histories"));
    yield* Effect.logDebug("Read item run histories", { itemKeys, runs: summaries.length });
    return summaries;
  });
  const board = Effect.fn("RunReader.board")(function* (
    itemKeys: ReadonlyArray<ItemKey>,
    attentionRunIds: ReadonlyArray<RunId>,
  ) {
    yield* Effect.annotateCurrentSpan({ itemKeys, attentionRunIds });
    return yield* snapshot
      .run(database, queries.boardRunSummaries(itemKeys, attentionRunIds))
      .pipe(persistence("read current board runs and history totals"));
  });
  const events = Effect.fn("RunReader.events")((runIds: ReadonlyArray<RunId>) =>
    queries.runEvents(runIds).pipe(persistence("read the events of runs")),
  );
  const transcript = Effect.fn("RunReader.transcript")((query: TranscriptQuery) =>
    queries.transcript(query).pipe(persistence("read attempt transcript")),
  );
  const latestPoolRateLimits = Effect.fn("RunReader.latestPoolRateLimits")(function* () {
    const rows = yield* database
      .select({
        event: sql<string>`json_extract(${poolRateLimits.envelope}, '$.payload.event')`,
      })
      .from(poolRateLimits)
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
    summary,
    runForEvent,
    evidence,
    list,
    closed,
    closedSince,
    forItems,
    board,
    events,
    revision,
    transcript,
    latestPoolRateLimits,
    attemptsByWorker,
    sightings,
  } as const;
});

/**
 * Reads saved run state and transcripts without starting or recovering execution.
 * Each summary read returns run state, attempts, and board aggregates from one snapshot.
 */
export class RunReader extends Context.Service<
  RunReader,
  {
    /** Returns the Run's state, effective task and Agent, Step result, and Attempt history. */
    readonly inspect: (runId: RunId) => Effect.Effect<RunSnapshot, RunStoreError>;
    /** Returns polling metadata for one run without prompts, results, or comments. */
    readonly summary: (runId: RunId) => Effect.Effect<RunSummary, RunStoreError>;
    /** Returns the admitted run, or `None` if the event has no run. */
    readonly runForEvent: (
      dedupKey: DedupKey,
    ) => Effect.Effect<Option.Option<RunId>, RunStoreError>;
    /** Returns a Run snapshot and all its transcript entries, in append order, from one snapshot. */
    readonly evidence: (runId: RunId) => Effect.Effect<RunEvidence, RunStoreError>;
    /** Returns every open Run plus the newest `closedLimit` closed ones and their Attempts from one snapshot, newest first. */
    readonly list: (options: {
      readonly closedLimit: number;
    }) => Effect.Effect<ReadonlyArray<RunSummary>, RunStoreError>;
    /** Returns the newest closed runs within `repositories`, or all repositories when omitted. */
    readonly closed: (options: {
      readonly limit: number;
      readonly repositories?: ReadonlyArray<RepositoryName>;
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
    /** Returns current runs selected in SQL and aggregate history for every selected board item. */
    readonly board: (
      itemKeys: ReadonlyArray<ItemKey>,
      attentionRunIds: ReadonlyArray<RunId>,
    ) => Effect.Effect<BoardRunHistory, RunStoreError>;
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
  AttemptSummary,
  ItemRunHistory,
  RunUsageSource,
  BoardRunHistory,
  summarizeRun,
  RunEvent,
  RunEvidence,
  RunSnapshot,
  RunSummary,
  ProjectionRevision,
  WorkerAttempts,
} from "./model.ts";
