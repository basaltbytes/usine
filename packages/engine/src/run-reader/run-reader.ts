import { Context, Effect, Layer, Option } from "effect";
import { RunId } from "@usine/core/run";
import { ItemKey } from "@usine/core/item";
import { RunDatabase } from "../database/database.ts";
import {
  type LoopSighting,
  ProjectionRevision,
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
      .pipe(persistence("read Run evidence"));
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
  const revision = Effect.fn("RunReader.revision")(() =>
    queries.revision().pipe(persistence("read projection revision")),
  );
  const forItems = Effect.fn("RunReader.forItems")((itemKeys: ReadonlyArray<ItemKey>) =>
    queries.itemRunSummaries(itemKeys).pipe(persistence("read Item Run histories")),
  );
  const transcript = Effect.fn("RunReader.transcript")((query: TranscriptQuery) =>
    queries.transcript(query).pipe(persistence("read Attempt transcript")),
  );
  const attemptsByWorker = Effect.fn("RunReader.attemptsByWorker")(() =>
    leftoverQueries(database).attemptCountsByWorker().pipe(persistence("count Attempts by Worker")),
  );
  const sightings = Effect.fn("RunReader.sightings")((itemKeys: ReadonlyArray<ItemKey>) =>
    queries.loopItems.sightings(itemKeys).pipe(persistence("read Loop sightings")),
  );

  return {
    inspect,
    evidence,
    list,
    closed,
    forItems,
    revision,
    transcript,
    attemptsByWorker,
    sightings,
  } as const;
});

/** Reads saved Run state and transcripts without starting or recovering execution. */
export class RunReader extends Context.Service<
  RunReader,
  {
    /** Reads a Run's current state, effective task and Agent, Step result, and Attempt history. */
    readonly inspect: (runId: RunId) => Effect.Effect<RunSnapshot, RunStoreError>;
    /** Reads one consistent Run snapshot and every saved transcript entry, in append order without a page limit. */
    readonly evidence: (runId: RunId) => Effect.Effect<RunEvidence, RunStoreError>;
    /** Every open Run plus the newest `closedLimit` settled ones, newest first. */
    readonly list: (options: {
      readonly closedLimit: number;
    }) => Effect.Effect<ReadonlyArray<RunSummary>, RunStoreError>;
    /**
     * The `limit` settled Runs that closed last, newest close first, whenever they opened. A
     * Run closed when its last Attempt ended, or started for one closed before end times were
     * recorded; a Run canceled before any Attempt closed when it opened.
     */
    readonly closed: (options: {
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<RunSummary>, RunStoreError>;
    /** Every saved Run for the supplied Items, newest first, including all their Attempts. */
    readonly forItems: (
      itemKeys: ReadonlyArray<ItemKey>,
    ) => Effect.Effect<ReadonlyArray<RunSummary>, RunStoreError>;
    /** `None` means the invalidation row is absent: treat every cached projection as stale. */
    readonly revision: () => Effect.Effect<Option.Option<ProjectionRevision>, RunStoreError>;
    /** Reads the requested portion of one Attempt's saved transcript in append order. */
    readonly transcript: (
      query: TranscriptQuery,
    ) => Effect.Effect<ReadonlyArray<TranscriptEntry>, RunStoreError>;
    /**
     * The Attempts startup reconciliation visits, counted per Worker and ordered by Worker name,
     * with how many of them are still open; Workers without any are left out.
     */
    readonly attemptsByWorker: () => Effect.Effect<ReadonlyArray<WorkerAttempts>, RunStoreError>;
    /**
     * What each Loop last saw of the supplied Items, one entry per Loop that
     * has seen an Item: the Event of the state it last saw match, the Run that
     * Event owns, and the Run whose question or blocker holds it on the Item.
     */
    readonly sightings: (
      itemKeys: ReadonlyArray<ItemKey>,
    ) => Effect.Effect<ReadonlyArray<LoopSighting>, RunStoreError>;
  }
>()("@usine/engine/RunReader") {
  static readonly layer = Layer.effect(RunReader, makeRunReader);
}

export {
  LoopSighting,
  RunEvidence,
  RunSnapshot,
  RunSummary,
  ProjectionRevision,
  WorkerAttempts,
} from "./model.ts";
