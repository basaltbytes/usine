import { InstanceDirectory } from "@usine/core/instance";
import { RunId } from "@usine/core/run";
import { runReaderLayer } from "@usine/engine/local-sqlite";
import { RunEvidence, RunReader } from "@usine/engine/run-reader";
import { Console, DateTime, Effect, FileSystem, Match, Option, Path, Schema } from "effect";

/** JSON encoding preserves timestamps, optional values, and typed Attempt outcomes. */
export const RunEvidenceFromJson = Schema.fromJsonString(
  Schema.toCodecJson(
    Schema.Struct({
      version: Schema.Literal(1),
      exportedAt: Schema.DateTimeUtc,
      ...RunEvidence.fields,
    }),
  ),
  { space: 2 },
);

/** A failure to read, encode, or write Run evidence. */
export class RunExportError extends Schema.TaggedError<RunExportError>(
  "@usine/server/RunExportError",
)("RunExportError", {
  runId: RunId,
  operation: Schema.Literals(["read", "encode", "write"]),
  path: Schema.String,
  reason: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Writes a complete evidence file without overwriting an existing destination. */
const writeRunEvidence = Effect.fn("RunEvidence.write")(function* (
  evidence: RunEvidence,
  output: string,
) {
  const runId = evidence.snapshot.run.id;
  yield* Effect.annotateCurrentSpan({ runId, output });
  const json = yield* Schema.encodeEffect(RunEvidenceFromJson)({
    version: 1,
    exportedAt: yield* DateTime.now,
    ...evidence,
  }).pipe(
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
      // Hard-link the complete staged file into place; the link fails if the destination exists.
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
    const databasePath = path.join(directory, ".usine", "runtime.sqlite");
    const reader = runReaderLayer(directory);
    const evidence = yield* Effect.flatMap(RunReader, (reader) => reader.evidence(runId)).pipe(
      Effect.provide(reader),
      Effect.mapError((cause) =>
        cause._tag === "RunNotFoundError"
          ? cause
          : new RunExportError({
              runId,
              operation: "read",
              path: databasePath,
              reason: cause._tag,
              cause,
            }),
      ),
    );
    yield* writeRunEvidence(evidence, destination);
    yield* Console.log(`Exported run ${runId} to ${destination}`);
  },
  Effect.tapError((error) =>
    Effect.logWarning(
      "Run evidence export failed",
      Match.valueTags(error, {
        RunNotFoundError: ({ runId, _tag }) => ({ runId, errorTag: _tag }),
        RunExportError: ({ runId, _tag, operation, path, reason, cause }) => ({
          runId,
          errorTag: _tag,
          operation,
          path,
          reason,
          cause,
        }),
      }),
    ),
  ),
);
