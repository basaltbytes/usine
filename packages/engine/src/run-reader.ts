import { Context, Effect, Layer, Option } from "effect";
import { RunId } from "@usine/core/ids";
import { RunDatabase } from "./database/database.ts";
import {
  ProjectionRevision,
  RunSnapshot,
  RunSummary,
  TranscriptEntry,
  TranscriptQuery,
  type RunStoreError,
} from "./model.ts";
import { persistence } from "./store/codec.ts";
import { queriesFor } from "./store/queries.ts";

const makeRunReader = Effect.gen(function* () {
  const queries = queriesFor(yield* RunDatabase);

  const inspect = Effect.fn("RunReader.inspect")((runId: RunId) =>
    queries.snapshot(runId).pipe(persistence("read run")),
  );
  const list = Effect.fn("RunReader.list")((options: { readonly closedLimit: number }) =>
    queries.runSummaries(options.closedLimit).pipe(persistence("list runs")),
  );
  const revision = Effect.fn("RunReader.revision")(() =>
    queries.revision().pipe(persistence("read projection revision")),
  );
  const transcript = Effect.fn("RunReader.transcript")((query: TranscriptQuery) =>
    queries.transcript(query).pipe(persistence("read Attempt transcript")),
  );

  return { inspect, list, revision, transcript } as const;
});

/** Read-only durable Run projection; safe to build while execution is idle. */
export class RunReader extends Context.Service<
  RunReader,
  {
    readonly inspect: (runId: RunId) => Effect.Effect<RunSnapshot, RunStoreError>;
    /** Every open Run plus the newest `closedLimit` settled ones, newest first. */
    readonly list: (options: {
      readonly closedLimit: number;
    }) => Effect.Effect<ReadonlyArray<RunSummary>, RunStoreError>;
    /** `None` means the invalidation singleton is absent: treat every cached projection as stale. */
    readonly revision: () => Effect.Effect<Option.Option<ProjectionRevision>, RunStoreError>;
    readonly transcript: (
      query: TranscriptQuery,
    ) => Effect.Effect<ReadonlyArray<TranscriptEntry>, RunStoreError>;
  }
>()("@usine/engine/RunReader") {
  static readonly layer = Layer.effect(RunReader, makeRunReader);
}
