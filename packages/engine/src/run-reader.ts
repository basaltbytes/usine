import { Context, Effect, Layer, Option } from "effect";
import { Run } from "@usine/core";
import { RunDatabase } from "./database/database.ts";
import {
  ProjectionRevision,
  EnginePersistenceError,
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

  const inspect = Effect.fn("RunReader.inspect")((runId: Run.RunId) =>
    queries.snapshot(runId).pipe(persistence("read run")),
  );
  const list = Effect.fn("RunReader.list")(() =>
    queries.runSummaries().pipe(persistence("list runs")),
  );
  const revision = Effect.fn("RunReader.revision")(function* () {
    const stored = yield* queries.revision().pipe(persistence("read projection revision"));
    if (Option.isNone(stored)) {
      return yield* new EnginePersistenceError({
        operation: "read projection revision",
        cause: new Error("The projection revision singleton is missing"),
      });
    }
    return stored.value;
  });
  const transcript = Effect.fn("RunReader.transcript")((query: TranscriptQuery) =>
    queries.transcript(query).pipe(persistence("read Attempt transcript")),
  );

  return { inspect, list, revision, transcript } as const;
});

/** Read-only durable Run projection; safe to build while execution is idle. */
export class RunReader extends Context.Service<
  RunReader,
  {
    readonly inspect: (runId: Run.RunId) => Effect.Effect<RunSnapshot, RunStoreError>;
    readonly list: () => Effect.Effect<ReadonlyArray<RunSummary>, RunStoreError>;
    readonly revision: () => Effect.Effect<ProjectionRevision, RunStoreError>;
    readonly transcript: (
      query: TranscriptQuery,
    ) => Effect.Effect<ReadonlyArray<TranscriptEntry>, RunStoreError>;
  }
>()("@usine/engine/RunReader") {
  static readonly layer = Layer.effect(RunReader, makeRunReader);
}
