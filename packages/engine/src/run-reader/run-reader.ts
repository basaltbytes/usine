import { Context, Effect, Layer, Option } from "effect";
import { RunId } from "@usine/core/run";
import { ItemKey } from "@usine/core/item";
import { RunDatabase } from "../database/database.ts";
import { ProjectionRevision, RunEvidence, RunSnapshot, RunSummary } from "./model.ts";
import { TranscriptAllQuery, TranscriptEntry, TranscriptQuery } from "../transcript.ts";
import type { RunStoreError } from "../engine/error.ts";
import { persistence } from "../store/codec.ts";
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
  const revision = Effect.fn("RunReader.revision")(() =>
    queries.revision().pipe(persistence("read projection revision")),
  );
  const forItems = Effect.fn("RunReader.forItems")((itemKeys: ReadonlyArray<ItemKey>) =>
    queries.itemRunSummaries(itemKeys).pipe(persistence("read Item Run histories")),
  );
  const transcript = Effect.fn("RunReader.transcript")((query: TranscriptQuery) =>
    queries.transcript(query).pipe(persistence("read Attempt transcript")),
  );

  return { inspect, evidence, list, forItems, revision, transcript } as const;
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
  }
>()("@usine/engine/RunReader") {
  static readonly layer = Layer.effect(RunReader, makeRunReader);
}

export { RunEvidence, RunSnapshot, RunSummary, ProjectionRevision } from "./model.ts";
