import { InstanceDirectory } from "@usine/core/instance";
import { RunId } from "@usine/core/run";
import { observationLayer } from "@usine/engine/local-sqlite";
import { RunReader, RunSnapshot } from "@usine/engine/run-reader";
import { TranscriptAllQuery, TranscriptEntry } from "@usine/engine/transcript";
import { Console, DateTime, Effect, FileSystem, Match, Option, Path, Schema } from "effect";

/** One Run's saved execution context, Attempt history, and full channel transcripts. */
export class RunEvidence extends Schema.Class<RunEvidence>("@usine/server/RunEvidence")({
  version: Schema.Literal(1),
  exportedAt: Schema.DateTimeUtc,
  snapshot: RunSnapshot,
  transcript: Schema.Array(TranscriptEntry),
}) {}

/** JSON encoding preserves timestamps, optional values, and typed Attempt outcomes. */
export const RunEvidenceFromJson = Schema.fromJsonString(Schema.toCodecJson(RunEvidence), {
  space: 2,
});

/** Reading, encoding, or writing Run evidence failed; no successful export was reported. */
export class RunExportError extends Schema.TaggedError<RunExportError>(
  "@usine/server/RunExportError",
)("RunExportError", {
  runId: RunId,
  operation: Schema.Literals(["read", "encode", "write"]),
  path: Schema.String,
  reason: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Reads every saved transcript row for the Attempts in the Run snapshot, without the UI page limit. */
const readEvidence = Effect.fn("RunEvidence.read")(function* (runId: RunId) {
  yield* Effect.annotateCurrentSpan({ runId });
  const reader = yield* RunReader;
  const snapshot = yield* reader.inspect(runId);
  const transcripts = yield* Effect.forEach(snapshot.attempts, ({ id }) =>
    reader.transcript(new TranscriptAllQuery({ attemptId: id })),
  );
  return new RunEvidence({
    version: 1,
    exportedAt: yield* DateTime.now,
    snapshot,
    transcript: transcripts.flat().sort((left, right) => left.sequence - right.sequence),
  });
});

/** Writes a complete evidence file without overwriting an existing destination. */
const writeRunEvidence = Effect.fn("RunEvidence.write")(function* (
  evidence: RunEvidence,
  output: string,
) {
  const runId = evidence.snapshot.run.id;
  yield* Effect.annotateCurrentSpan({ runId, output });
  const json = yield* Schema.encodeEffect(RunEvidenceFromJson)(evidence).pipe(
    Effect.mapError(
      (cause) =>
        new RunExportError({ runId, operation: "encode", path: output, reason: cause._tag, cause }),
    ),
  );
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const temporary = yield* fileSystem.makeTempDirectoryScoped({
        directory: path.dirname(output),
        prefix: ".usine-export-",
      });
      const staged = path.join(temporary, "evidence.json");
      yield* fileSystem.writeFileString(staged, `${json}\n`, { mode: 0o600 });
      // Publish the complete file atomically. A hard link refuses an existing destination.
      yield* fileSystem.link(staged, output);
    }),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new RunExportError({
          runId,
          operation: "write",
          path: output,
          reason: cause.reason._tag,
          cause,
        }),
    ),
  );
  yield* Effect.logInfo("Run evidence exported", {
    runId,
    output,
    attempts: evidence.snapshot.attempts.length,
    transcriptRows: evidence.transcript.length,
  });
});

/** Exports from the current instance without loading GitHub credentials or starting execution. */
export const exportRun = Effect.fn("Cli.exportRun")(
  function* (runId: RunId, output: Option.Option<string>) {
    const directory = InstanceDirectory.make(process.cwd());
    const path = yield* Path.Path;
    const destination = path.resolve(
      Option.getOrElse(output, () => `run-${encodeURIComponent(runId)}.json`),
    );
    yield* Effect.annotateCurrentSpan({ runId, instanceDirectory: directory, output: destination });
    const fileSystem = yield* FileSystem.FileSystem;
    const databasePath = path.join(directory, ".usine", "runtime.sqlite");
    // A maintenance command must not create a fresh runtime store in the wrong directory.
    const evidence = yield* fileSystem.access(databasePath).pipe(
      Effect.andThen(readEvidence(runId).pipe(Effect.provide(observationLayer(directory)))),
      Effect.mapError((cause) =>
        cause._tag === "RunNotFoundError"
          ? cause
          : new RunExportError({
              runId,
              operation: "read",
              path: databasePath,
              reason: cause._tag === "PlatformError" ? cause.reason._tag : cause._tag,
              cause,
            }),
      ),
    );
    yield* writeRunEvidence(evidence, destination);
    yield* Console.log(`Exported Run ${runId} to ${destination}`);
  },
  Effect.tapError((error) =>
    Effect.logWarning(
      "Run evidence export failed",
      Match.valueTags(error, {
        RunNotFoundError: ({ runId, _tag }) => ({ runId, errorTag: _tag }),
        RunExportError: ({ runId, _tag, operation, path, reason }) => ({
          runId,
          errorTag: _tag,
          operation,
          path,
          reason,
        }),
      }),
    ),
  ),
);
