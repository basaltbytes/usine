import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { assert, it } from "@effect/vitest";
import { AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { Effect, FileSystem, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";

import { sqliteTempDirectory } from "../../../tooling/test/sqlite.mts";
import { StoredRequest } from "../src/attempt-runtime.ts";
import { AttemptJournal } from "../src/coordinator/journal.ts";
import { sqliteAttemptJournalLayer } from "../src/coordinator/sqlite/store.ts";
import { attemptRequest } from "./support.ts";

const stored = (attemptId: string, coordinator: AttemptChannel.RunSpec["coordinator"]) => {
  const { spec, worker, cwd } = attemptRequest(attemptId);
  return StoredRequest.make({
    spec: AttemptChannel.RunSpec.make({ ...spec, coordinator }),
    worker,
    cwd,
  });
};

it.effect("reads a journaled RunSpec.parent as its coordinator kind", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({
      directory: sqliteTempDirectory(),
      prefix: "usine-journal-migration-",
    });
    const database = SqliteClient.layer({ filename: `${directory}/runtime.sqlite` });
    const journal = () =>
      Layer.fresh(sqliteAttemptJournalLayer.pipe(Layer.provide(database), Layer.orDie));
    const statement = (query: string) =>
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(query)).pipe(
        Effect.provide(database),
        Effect.orDie,
      );

    yield* Effect.gen(function* () {
      const attempts = yield* AttemptJournal;
      yield* attempts.open(stored("migration/events", "events"));
      yield* attempts.open(stored("migration/session", "session"));
    }).pipe(Effect.provide(journal()));
    // The rows as an orchestrator wrote them before the rename, with the rename not yet applied.
    yield* statement(
      "UPDATE usine_attempt_coordination SET request = json_set(json_remove(request, '$.spec.coordinator'), '$.spec.parent', CASE json_extract(request, '$.spec.coordinator') WHEN 'events' THEN 'none' ELSE 'pi' END)",
    );
    yield* statement(
      "DELETE FROM usine_attempt_journal_migrations WHERE name LIKE '%coordinator_kind'",
    );

    const kinds = yield* Effect.gen(function* () {
      const attempts = yield* AttemptJournal;
      return yield* Effect.forEach(["migration/events", "migration/session"], (attemptId) =>
        attempts
          .load(AttemptId.make(attemptId))
          .pipe(Effect.map(Option.map(({ request }) => request.spec.coordinator))),
      );
    }).pipe(Effect.provide(journal()));

    assert.deepStrictEqual(kinds, [Option.some("events"), Option.some("session")]);
    const legacy = yield* statement(
      "SELECT count(*) AS count FROM usine_attempt_coordination WHERE json_type(request, '$.spec.parent') IS NOT NULL",
    );
    assert.deepStrictEqual(legacy, [{ count: 0 }]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
