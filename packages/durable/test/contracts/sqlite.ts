import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, FileSystem, Layer } from "effect";
import { SqlClient } from "effect/sql";

import { sqliteTempDirectory } from "../../../../tooling/test/sqlite.mts";
import { sqliteAttemptJournalLayer } from "../../src/coordinator/sqlite/store.ts";
import type { FailingJournalFixture, JournalAdapter } from "./adapter.ts";

export const sqliteAdapter: JournalAdapter<FailingJournalFixture> = {
  name: "sqlite",
  fixture: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({
      directory: sqliteTempDirectory(),
      prefix: "usine-journal-contract-",
    });
    const database = () => SqliteClient.layer({ filename: `${directory}/runtime.sqlite` });
    const statement = (query: string) =>
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(query)).pipe(
        Effect.provide(database()),
        Effect.orDie,
      );
    return {
      open: Layer.fresh(sqliteAttemptJournalLayer.pipe(Layer.provide(database()), Layer.orDie)),
      rejectOutboxInsert: statement(
        "CREATE TRIGGER reject_outbox BEFORE INSERT ON usine_attempt_outbox BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END",
      ).pipe(Effect.as(statement("DROP TRIGGER reject_outbox").pipe(Effect.asVoid))),
    };
  }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
};
