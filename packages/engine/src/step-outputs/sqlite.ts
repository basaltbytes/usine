import { StepOutput } from "@usine/core/step/output";
import { CommitSha } from "@usine/core/repository";
import { Effect, DateTime, Layer, Option, Schema } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import { EnginePersistenceError } from "../engine/error.ts";
import { StepOutputStore, StoredStepOutput } from "./store.ts";

const RefFields = { ...StoredStepOutput.fields, commit: Schema.OptionFromNullOr(CommitSha) };
const ContentJson = Schema.fromJsonString(Schema.Json);
const fields = `o.attempt_id AS attemptId, o.run_id AS runId, o.step_name AS stepName,
  o.name, o.type, o.repository, o.item_number AS itemNumber, o."commit" AS "commit",
  o.size, o.sha256, o.created_at AS createdAt`;
const succeeded = `JOIN usine_attempts a ON a.attempt_id = o.attempt_id
  AND json_extract(a.outcome_json, '$._tag') = 'Succeeded'`;
const failure = (operation: string) => (cause: unknown) =>
  EnginePersistenceError.make({ operation, cause });

const compress = (text: string) =>
  Effect.tryPromise({
    try: () =>
      new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip")))
        .arrayBuffer()
        .then((body) => new Uint8Array(body)),
    catch: failure("compress step output"),
  });
const decompress = (body: Uint8Array) =>
  Effect.tryPromise({
    try: () =>
      new Response(
        new Blob([new Uint8Array(body)]).stream().pipeThrough(new DecompressionStream("gzip")),
      ).text(),
    catch: failure("decompress step output"),
  });

/** Provides output persistence on the application's SqlClient, with its own migration ledger. */
export const sqliteStepOutputLayer = Layer.effect(
  StepOutputStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Migrator.make({})({
      table: "usine_step_output_migrations",
      loader: Migrator.fromRecord({
        "0001_step_outputs": Effect.gen(function* () {
          yield* sql`CREATE TABLE usine_step_outputs (
          attempt_id TEXT NOT NULL, run_id TEXT NOT NULL, step_name TEXT NOT NULL,
          name TEXT NOT NULL, type TEXT NOT NULL, repository TEXT NOT NULL COLLATE NOCASE,
          item_number INTEGER, "commit" TEXT, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
          body BLOB NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (attempt_id, name)
        )`;
          yield* sql`CREATE INDEX usine_step_outputs_item_type ON usine_step_outputs (repository, item_number, type)`;
        }),
      }),
    }).pipe(Effect.mapError(failure("migrate step outputs")));

    return StepOutputStore.of({
      write: Effect.fn("StepOutputStore.write")(
        function* (context, outputs) {
          yield* Effect.annotateCurrentSpan({ attemptId: context.attemptId, runId: context.runId });
          const now = yield* DateTime.now;
          const createdAt = DateTime.formatIso(now);
          for (const output of outputs) {
            const json = yield* Schema.encodeEffect(ContentJson)(output.content);
            const body = yield* compress(json);
            yield* sql`INSERT INTO usine_step_outputs ${sql.insert({
              attempt_id: context.attemptId,
              run_id: context.runId,
              step_name: context.stepName,
              name: output.name,
              type: output.type,
              repository: context.repository,
              item_number: Option.getOrNull(context.itemNumber),
              commit: Option.getOrNull(output.commit),
              size: output.size,
              sha256: output.sha256,
              body,
              created_at: createdAt,
            })} ON CONFLICT(attempt_id, name) DO UPDATE SET
          run_id = excluded.run_id, step_name = excluded.step_name, type = excluded.type,
          repository = excluded.repository, item_number = excluded.item_number,
          "commit" = excluded."commit", size = excluded.size, sha256 = excluded.sha256, body = excluded.body`;
          }
          yield* Effect.logInfo("Stored step outputs", {
            attemptId: context.attemptId,
            outputs: outputs.length,
          });
        },
        Effect.mapError(failure("write step outputs")),
      ),
      list: Effect.fn("StepOutputStore.list")(
        function* (repository, itemNumber, type) {
          yield* Effect.annotateCurrentSpan({ repository, itemNumber });
          const rows = yield* sql.unsafe(
            `SELECT ${fields} FROM usine_step_outputs o ${succeeded}
        WHERE o.repository = ? AND o.item_number = ? ${Option.isSome(type) ? "AND o.type = ?" : ""}
        ORDER BY o.attempt_id, o.name`,
            Option.isSome(type) ? [repository, itemNumber, type.value] : [repository, itemNumber],
          );
          return (yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct(RefFields)))(
            rows,
          )).map((row) => StoredStepOutput.make(row));
        },
        Effect.mapError(failure("list step outputs")),
      ),
      read: Effect.fn("StepOutputStore.read")(
        function* (attemptId, name) {
          yield* Effect.annotateCurrentSpan({ attemptId, name });
          const rows = yield* sql.unsafe(
            `SELECT ${fields}, o.body FROM usine_step_outputs o ${succeeded}
        WHERE o.attempt_id = ? AND o.name = ?`,
            [attemptId, name],
          );
          const row = rows[0];
          if (row === undefined) return Option.none();
          const decoded = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ ...RefFields, body: Schema.Uint8Array }),
          )(row);
          const content = yield* decompress(decoded.body).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ContentJson)),
          );
          return Option.some(StepOutput.make({ ...decoded, content }));
        },
        Effect.mapError(failure("read step output")),
      ),
    });
  }),
);
