import { fileURLToPath } from "node:url";
import { SqliteClient } from "@effect/sql-sqlite-node";
import * as SQLiteDrizzle from "drizzle-orm/effect-sqlite-node";
import { migrate } from "drizzle-orm/effect-sqlite-node/migrator";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";

import { Agent } from "@usine/core/agent";
import { BrainSpec } from "@usine/core/agent/brain";

import { RunId } from "@usine/core/run";
import { RunApproval } from "@usine/core/run/approval";

import { DateTime, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

import { RunDatabase } from "../../src/database/database.ts";
import { localSqliteLayer } from "../../src/database/local-sqlite.ts";

import { TranscriptAllQuery } from "../../src/transcript.ts";
import { InstanceDirectory } from "@usine/core/instance";

import { RunStore } from "../../src/store/store.ts";

import { testAgent, lifecycleSubmission } from "./support.ts";

/** Seeds a pending Run in a historical schema: today's store writes columns added by later migrations. */
const seedPendingRun = (runId: RunId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const agent = JSON.stringify(Schema.encodeSync(Agent)(testAgent));
    const eventId = lifecycleSubmission.event.id;
    yield* sql`INSERT INTO usine_events (event_id, dedup_key, payload_json, received_at)
      VALUES (${eventId}, ${lifecycleSubmission.event.dedupKey}, '{}', '2026-10-01T00:00:00.000Z')`;
    yield* sql`INSERT INTO usine_trigger_events (event_id, item_key, loop_name, step_name, approval, repository, revision, task, agent_json)
      VALUES (${eventId}, ${lifecycleSubmission.itemKey}, ${lifecycleSubmission.loop}, ${lifecycleSubmission.step}, 'none', ${lifecycleSubmission.repository}, ${lifecycleSubmission.revision}, ${lifecycleSubmission.task}, ${agent})`;
    yield* sql`INSERT INTO usine_runs (run_id, event_id, loop_name, state_json, opened_at, repository, revision, task, agent_json)
      VALUES (${runId}, ${eventId}, ${lifecycleSubmission.loop}, '{"_tag":"Pending"}', '2026-10-01T00:00:00.000Z', ${lifecycleSubmission.repository}, ${lifecycleSubmission.revision}, ${lifecycleSubmission.task}, ${agent})`;
    yield* sql`INSERT INTO usine_steps (run_id, step_name) VALUES (${runId}, ${lifecycleSubmission.step})`;
  });

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
        if (name >= "20260912111855_operator_intervention") continue;
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
          const sql = yield* SqlClient.SqlClient;
          // Seed the historical schema directly: today's store writes columns added by later migrations.
          const agent = JSON.stringify(Schema.encodeSync(Agent)(testAgent));
          const eventId = lifecycleSubmission.event.id;
          yield* sql`INSERT INTO usine_events (event_id, dedup_key, payload_json, received_at)
            VALUES (${eventId}, 'upgrade-event', '{}', '2026-09-12T00:00:00.000Z')`;
          yield* sql`INSERT INTO usine_trigger_events (event_id, item_key, loop_name, step_name, approval, repository, revision, task, agent_json)
            VALUES (${eventId}, ${lifecycleSubmission.itemKey}, ${lifecycleSubmission.loop}, ${lifecycleSubmission.step}, 'none', ${lifecycleSubmission.repository}, ${lifecycleSubmission.revision}, ${lifecycleSubmission.task}, ${agent})`;
          yield* sql`INSERT INTO usine_runs (run_id, event_id, loop_name, state_json, opened_at, repository, revision, task, agent_json)
            VALUES (${runId}, ${eventId}, ${lifecycleSubmission.loop}, '{"_tag":"Pending"}', '2026-09-12T00:00:00.000Z', ${lifecycleSubmission.repository}, ${lifecycleSubmission.revision}, ${lifecycleSubmission.task}, ${agent})`;
          yield* sql`INSERT INTO usine_steps (run_id, step_name) VALUES (${runId}, ${lifecycleSubmission.step})`;
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
          // v6 was the live version until v7 changed only the unstored `Start` frame;
          // bumping the envelope literal alone once made every existing transcript unreadable.
          const previousVersion = JSON.stringify({
            _tag: "OutboundEnvelope",
            version: 6,
            attemptId: id,
            sequence: 2,
            sentAt: "2026-09-12T00:00:01.000Z",
            payload: { _tag: "Final", result: { message: "done", facts: [] } },
          });
          yield* sql`INSERT INTO usine_attempt_transcripts (attempt_id, direction, channel_sequence, envelope, received_at) VALUES (${id}, 'outbound', 2, ${previousVersion}, '2026-09-12T00:00:01.000Z')`;
        }).pipe(Effect.provide(oldDatabase)),
      );
      yield* Effect.gen(function* () {
        const store = yield* RunStore;
        const snapshot = yield* store.snapshot(runId);
        assert(Option.isNone(snapshot.resolvedFailureAttemptId));
        assert.strictEqual(snapshot.attempts[0]?.task, lifecycleSubmission.task);
        assert.strictEqual(snapshot.attempts[0]?.agent, testAgent.name);
        assert.strictEqual(snapshot.attempts[0]?.operatorIntervened, false);
        const attempt = snapshot.attempts[0];
        assert(attempt !== undefined);
        const transcript = yield* store.transcript(
          new TranscriptAllQuery({ attemptId: attempt.id }),
        );
        assert.deepStrictEqual(
          transcript.map(({ envelope }) => [envelope.version, envelope.payload._tag]),
          [
            [4, "Started"],
            [6, "Final"],
          ],
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

describe("Run driver migration", () => {
  it.live("drops the Effect workflow and cluster tables from an existing instance", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fs.makeTempDirectoryScoped({ prefix: "usine-workflow-upgrade-" }),
      );
      const historical = yield* fs.makeTempDirectoryScoped({
        prefix: "usine-workflow-migrations-",
      });
      const source = fileURLToPath(new URL("../../drizzle", import.meta.url));
      for (const name of yield* fs.readDirectory(source)) {
        if (name >= "20261011153856_drop_workflow_tables") continue;
        yield* fs.copy(`${source}/${name}`, `${historical}/${name}`);
      }
      yield* fs.makeDirectory(`${directory}/.usine`);
      const workflowEraDatabase = Layer.effect(
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
      const runId = RunId.make("workflow-era-run");
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* seedPendingRun(runId);
          const sql = yield* SqlClient.SqlClient;
          // The tables Effect's SingleRunner kept beside usine's, and a pending command.
          yield* sql`CREATE TABLE cluster_migrations (migration_id integer PRIMARY KEY)`;
          yield* sql`CREATE TABLE cluster_messages (id text PRIMARY KEY)`;
          yield* sql`CREATE TABLE cluster_replies (id text PRIMARY KEY)`;
          yield* sql`INSERT INTO usine_workflow_commands (run_id, command) VALUES (${runId}, 'Resume')`;
        }).pipe(Effect.provide(workflowEraDatabase)),
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const remaining = yield* sql`SELECT name FROM sqlite_master
          WHERE type = 'table' AND (name LIKE 'cluster_%' OR name = 'usine_workflow_commands')`;
        assert.deepStrictEqual(remaining, []);
        const store = yield* RunStore;
        assert.strictEqual((yield* store.snapshot(runId)).run.state._tag, "Pending");
      }).pipe(Effect.provide(RunStore.layer), Effect.provide(localSqliteLayer(directory)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("Event reopening migration", () => {
  it.live(
    "keeps a canceled Run's Event after the upgrade until the Loop sees the Item leave and come back",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = InstanceDirectory.make(
          yield* fs.makeTempDirectoryScoped({ prefix: "usine-reopening-upgrade-" }),
        );
        const historical = yield* fs.makeTempDirectoryScoped({
          prefix: "usine-reopening-migrations-",
        });
        const source = fileURLToPath(new URL("../../drizzle", import.meta.url));
        for (const name of yield* fs.readDirectory(source)) {
          if (name >= "20261018172605_loop_items_and_reopenings") continue;
          yield* fs.copy(`${source}/${name}`, `${historical}/${name}`);
        }
        yield* fs.makeDirectory(`${directory}/.usine`);
        const previousDatabase = Layer.effect(
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
          Layer.provideMerge(
            SqliteClient.layer({ filename: `${directory}/.usine/runtime.sqlite` }),
          ),
        );
        const runId = RunId.make("canceled-before-upgrade");
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* seedPendingRun(runId);
            const sql = yield* SqlClient.SqlClient;
            yield* sql`UPDATE usine_runs SET state_json = '{"_tag":"Canceled","reason":{"_tag":"OperatorCanceled"}}' WHERE run_id = ${runId}`;
          }).pipe(Effect.provide(previousDatabase)),
        );
        yield* Effect.gen(function* () {
          const store = yield* RunStore;
          const first = yield* store.recordAndClaim(lifecycleSubmission, RunId.make("unused"));
          assert(first.result._tag === "Claimed");
          assert.strictEqual(first.result.runId, runId);
          yield* store.revoke(lifecycleSubmission.loop, lifecycleSubmission.itemKey);
          const returned = yield* store.recordAndClaim(lifecycleSubmission, RunId.make("unused"));
          assert(returned.result._tag === "Claimed");
          assert.notStrictEqual(returned.result.runId, runId);
          assert.strictEqual(
            (yield* store.snapshot(returned.result.runId)).run.state._tag,
            "Pending",
          );
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
        }).pipe(Effect.provide(RunStore.layer), Effect.provide(localSqliteLayer(directory)));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("Attempt salvage check migration", () => {
  it.live(
    "keeps stored salvage, rejects invalid salvage JSON, and drops the duplicate Item index",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = InstanceDirectory.make(
          yield* fs.makeTempDirectoryScoped({ prefix: "usine-salvage-check-upgrade-" }),
        );
        const historical = yield* fs.makeTempDirectoryScoped({
          prefix: "usine-salvage-check-migrations-",
        });
        const source = fileURLToPath(new URL("../../drizzle", import.meta.url));
        for (const name of yield* fs.readDirectory(source)) {
          if (name >= "20261017155043_attempt_salvage_check") continue;
          yield* fs.copy(`${source}/${name}`, `${historical}/${name}`);
        }
        yield* fs.makeDirectory(`${directory}/.usine`);
        const previousDatabase = Layer.effect(
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
          Layer.provideMerge(
            SqliteClient.layer({ filename: `${directory}/.usine/runtime.sqlite` }),
          ),
        );
        const runId = RunId.make("salvage-check-run");
        const id = "salvage-check-attempt";
        const salvage = JSON.stringify({
          _tag: "Pushed",
          ref: "usine/salvage/salvage-check-run/1",
          commit: "0123456789abcdef0123456789abcdef01234567",
        });
        const brain = JSON.stringify(Schema.encodeSync(BrainSpec)(testAgent.brain));
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* seedPendingRun(runId);
            const sql = yield* SqlClient.SqlClient;
            yield* sql`INSERT INTO usine_attempts (attempt_id, run_id, step_name, worker_name, attempt_number, brain_json, task, agent, started_at, outcome_json, salvage_json)
            VALUES (${id}, ${runId}, ${lifecycleSubmission.step}, 'local', 1, ${brain}, ${lifecycleSubmission.task}, ${testAgent.name}, '2026-10-17T00:00:00.000Z', '{"_tag":"Canceled"}', ${salvage})`;
          }).pipe(Effect.provide(previousDatabase)),
        );
        yield* Effect.gen(function* () {
          const store = yield* RunStore;
          const attempt = (yield* store.snapshot(runId)).attempts[0];
          assert(attempt !== undefined && Option.isSome(attempt.salvage));
          assert.strictEqual(attempt.salvage.value._tag, "Pushed");
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(
            yield* sql`SELECT name FROM sqlite_master WHERE name = 'usine_item_projection_repository'`,
            [],
          );
          const rejected =
            yield* sql`UPDATE usine_attempts SET salvage_json = 'not json' WHERE attempt_id = ${id}`.pipe(
              Effect.flip,
            );
          assert.include(String(rejected.reason.cause), "CHECK constraint failed");
          assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
          const before = (yield* sql`SELECT revision FROM usine_projection_revision`)[0]?.revision;
          yield* sql`UPDATE usine_attempts SET salvage_json = NULL WHERE attempt_id = ${id}`;
          const after = (yield* sql`SELECT revision FROM usine_projection_revision`)[0]?.revision;
          assert(Schema.is(Schema.Int)(before));
          assert.strictEqual(after, before + 1);
        }).pipe(Effect.provide(RunStore.layer), Effect.provide(localSqliteLayer(directory)));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("Run approval source migration", () => {
  it.live(
    "reads an earlier approval as approved with no source and rejects an Ask approval without its approver",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = InstanceDirectory.make(
          yield* fs.makeTempDirectoryScoped({ prefix: "usine-approval-source-upgrade-" }),
        );
        const historical = yield* fs.makeTempDirectoryScoped({
          prefix: "usine-approval-source-migrations-",
        });
        const source = fileURLToPath(new URL("../../drizzle", import.meta.url));
        for (const name of yield* fs.readDirectory(source)) {
          if (name >= "20261019104043_run_approval_source") continue;
          yield* fs.copy(`${source}/${name}`, `${historical}/${name}`);
        }
        yield* fs.makeDirectory(`${directory}/.usine`);
        const previousDatabase = Layer.effect(
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
          Layer.provideMerge(
            SqliteClient.layer({ filename: `${directory}/.usine/runtime.sqlite` }),
          ),
        );
        const runId = RunId.make("approved-before-upgrade");
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* seedPendingRun(runId);
            const sql = yield* SqlClient.SqlClient;
            yield* sql`INSERT INTO usine_events (event_id, dedup_key, payload_json, received_at)
              VALUES ('approval-before-upgrade', 'approval-before-upgrade', '{}', '2026-10-01T00:05:00.000Z')`;
            yield* sql`INSERT INTO usine_approvals (run_id, event_id) VALUES (${runId}, 'approval-before-upgrade')`;
            yield* sql`UPDATE usine_runs SET state_json = '{"_tag":"Queued"}' WHERE run_id = ${runId}`;
          }).pipe(Effect.provide(previousDatabase)),
        );
        yield* Effect.gen(function* () {
          const store = yield* RunStore;
          const snapshot = yield* store.snapshot(runId);
          assert.strictEqual(snapshot.run.state._tag, "Queued");
          assert.deepStrictEqual(
            snapshot.approval,
            Option.some(
              new RunApproval({
                approvedAt: DateTime.makeUnsafe("2026-10-01T00:05:00.000Z"),
                source: Option.none(),
              }),
            ),
          );
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
          assert.strictEqual((yield* sql`PRAGMA foreign_keys`)[0]?.foreign_keys, 1);
          const rejected =
            yield* sql`UPDATE usine_approvals SET channel = 'github-ask' WHERE run_id = ${runId}`.pipe(
              Effect.flip,
            );
          assert.include(String(rejected.reason.cause), "CHECK constraint failed");
        }).pipe(Effect.provide(RunStore.layer), Effect.provide(localSqliteLayer(directory)));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
