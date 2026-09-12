import { fileURLToPath } from "node:url";
import { SqliteClient } from "@effect/sql-sqlite-node";
import * as SQLiteDrizzle from "drizzle-orm/effect-sqlite-node";
import { migrate } from "drizzle-orm/effect-sqlite-node/migrator";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";

import { BrainSpec } from "@usine/core/agent/brain";

import { RunId } from "@usine/core/run";

import { Effect, FileSystem, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

import { RunDatabase } from "../../src/database/database.ts";
import { localSqliteLayer } from "../../src/database/local-sqlite.ts";

import { TranscriptAllQuery } from "../../src/transcript.ts";
import { InstanceDirectory } from "@usine/core/instance";

import { RunStore } from "../../src/store/store.ts";

import { testAgent, lifecycleSubmission } from "./support.ts";
describe("Attempt migrations", () => {
  it.live("upgrades populated Attempts without losing transcripts or disabling foreign keys", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fs.makeTempDirectoryScoped({ prefix: "usine-intervention-upgrade-" }),
      );
      const historical = yield* fs.makeTempDirectoryScoped({
        prefix: "usine-historical-migrations-",
      });
      const source = fileURLToPath(new URL("../../drizzle", import.meta.url));
      for (const name of yield* fs.readDirectory(source)) {
        if (name === "20260912111855_operator_intervention") continue;
        yield* fs.copy(`${source}/${name}`, `${historical}/${name}`);
      }
      yield* fs.makeDirectory(`${directory}/.usine`);
      const oldDatabase = Layer.effect(
        RunDatabase,
        Effect.gen(function* () {
          const database = yield* SQLiteDrizzle.makeWithDefaults();
          yield* migrate(database, {
            migrationsFolder: historical,
            migrationsTable: "usine_migrations",
          });
          return database;
        }),
      ).pipe(
        Layer.provideMerge(SqliteClient.layer({ filename: `${directory}/.usine/runtime.sqlite` })),
      );
      const runId = RunId.make("upgrade-run");
      const id = "upgrade-attempt";
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* RunStore;
          yield* store.recordAndClaim(lifecycleSubmission, runId);
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO usine_attempts (attempt_id, run_id, step_name, worker_name, attempt_number, brain_json, started_at)
        VALUES (${id}, ${runId}, ${lifecycleSubmission.step}, 'local', 1, ${JSON.stringify(Schema.encodeSync(BrainSpec)(testAgent.brain))}, '2026-09-12T00:00:00.000Z')`;
          const envelope = JSON.stringify({
            _tag: "OutboundEnvelope",
            version: 4,
            attemptId: id,
            sequence: 1,
            sentAt: "2026-09-12T00:00:00.000Z",
            payload: { _tag: "Started", parentModel: "openai/model" },
          });
          yield* sql`INSERT INTO usine_attempt_transcripts (attempt_id, direction, channel_sequence, envelope, received_at) VALUES (${id}, 'outbound', 1, ${envelope}, '2026-09-12T00:00:00.000Z')`;
        }).pipe(Effect.provide(RunStore.layer), Effect.provide(oldDatabase)),
      );
      yield* Effect.gen(function* () {
        const store = yield* RunStore;
        const snapshot = yield* store.snapshot(runId);
        assert.strictEqual(snapshot.attempts[0]?.task, lifecycleSubmission.task);
        assert.strictEqual(snapshot.attempts[0]?.agent, testAgent.name);
        assert.strictEqual(snapshot.attempts[0]?.operatorIntervened, false);
        const attempt = snapshot.attempts[0];
        assert(attempt !== undefined);
        assert.strictEqual(
          (yield* store.transcript(new TranscriptAllQuery({ attemptId: attempt.id }))).length,
          1,
        );
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
        assert.strictEqual((yield* sql`PRAGMA foreign_keys`)[0]?.foreign_keys, 1);
        const before = (yield* sql`SELECT revision FROM usine_projection_revision`)[0]?.revision;
        yield* sql`UPDATE usine_attempts SET operator_intervened = 1 WHERE attempt_id = ${id}`;
        const after = (yield* sql`SELECT revision FROM usine_projection_revision`)[0]?.revision;
        assert(Schema.is(Schema.Int)(before));
        assert.strictEqual(after, before + 1);
      }).pipe(Effect.provide(RunStore.layer), Effect.provide(localSqliteLayer(directory)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
