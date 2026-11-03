import { sqliteTempDirectory } from "../../../../tooling/test/sqlite.mts";
import { OperatorLogin } from "@usine/core/operator";
import { fileURLToPath } from "node:url";
import { SqliteClient } from "@effect/sql-sqlite-node";
import * as SQLiteDrizzle from "drizzle-orm/effect-sqlite-node";
import { migrate } from "drizzle-orm/effect-sqlite-node/migrator";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";

import { Agent } from "@usine/core/agent";
import {
  AgentSessionId,
  ParentSession,
  ChildSession,
  SessionTokensUpdated,
  TokenCount,
  UsdAmount,
  PoolRateLimitsUpdated,
  RateLimitsSnapshot,
  PoolLogin,
} from "@usine/core/agent/session";
import { AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { BrainSpec } from "@usine/core/agent/brain";

import { RunId } from "@usine/core/run";
import { RunApproval, ApprovalSource } from "@usine/core/run/approval";

import { DateTime, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { RunDatabase } from "../../src/database/database.ts";
import { localSqliteLayer } from "../../src/database/local-sqlite.ts";

import { TranscriptAllQuery } from "../../src/transcript.ts";
import { InstanceDirectory } from "@usine/core/instance";

import { RunStore } from "../../src/store/store.ts";

import { testAgent, lifecycleSubmission } from "./support.ts";

/** Seeds a pending Run in an old schema directly, because the current store writes columns from later migrations. */
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
        yield* fs.makeTempDirectoryScoped({
          directory: sqliteTempDirectory(),
          prefix: "usine-intervention-upgrade-",
        }),
      );
      const historical = yield* fs.makeTempDirectoryScoped({
        directory: sqliteTempDirectory(),
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
          // Seeds the old schema directly, because the current store writes columns from later migrations.
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
          // v7 changed only the unstored `Start` frame; bumping the envelope literal alone once made
          // every v6 transcript unreadable.
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
        assert.deepStrictEqual(attempt.failureResolution, Option.none());
        const transcript = yield* store.transcript(
          TranscriptAllQuery.make({ attemptId: attempt.id }),
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
      }).pipe(Effect.provide(RunStore.layer.pipe(Layer.provideMerge(localSqliteLayer(directory)))));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("Run driver migration", () => {
  it.live("drops the Effect workflow and cluster tables from an existing instance", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fs.makeTempDirectoryScoped({
          directory: sqliteTempDirectory(),
          prefix: "usine-workflow-upgrade-",
        }),
      );
      const historical = yield* fs.makeTempDirectoryScoped({
        directory: sqliteTempDirectory(),
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
          // The tables that Effect's SingleRunner created next to usine's, and a pending command.
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
      }).pipe(Effect.provide(RunStore.layer.pipe(Layer.provideMerge(localSqliteLayer(directory)))));
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
          yield* fs.makeTempDirectoryScoped({
            directory: sqliteTempDirectory(),
            prefix: "usine-reopening-upgrade-",
          }),
        );
        const historical = yield* fs.makeTempDirectoryScoped({
          directory: sqliteTempDirectory(),
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
        }).pipe(
          Effect.provide(RunStore.layer.pipe(Layer.provideMerge(localSqliteLayer(directory)))),
        );
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
          yield* fs.makeTempDirectoryScoped({
            directory: sqliteTempDirectory(),
            prefix: "usine-salvage-check-upgrade-",
          }),
        );
        const historical = yield* fs.makeTempDirectoryScoped({
          directory: sqliteTempDirectory(),
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
        }).pipe(
          Effect.provide(RunStore.layer.pipe(Layer.provideMerge(localSqliteLayer(directory)))),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("Attempt start migration", () => {
  it.live(
    "records earlier first Attempts as begun from their Event and later ones as unknown",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = InstanceDirectory.make(
          yield* fs.makeTempDirectoryScoped({
            directory: sqliteTempDirectory(),
            prefix: "usine-attempt-start-upgrade-",
          }),
        );
        const historical = yield* fs.makeTempDirectoryScoped({
          directory: sqliteTempDirectory(),
          prefix: "usine-attempt-start-migrations-",
        });
        const source = fileURLToPath(new URL("../../drizzle", import.meta.url));
        for (const name of yield* fs.readDirectory(source)) {
          if (name >= "20261020103746_attempt_start") continue;
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
        const runId = RunId.make("attempt-start-run");
        const brain = JSON.stringify(Schema.encodeSync(BrainSpec)(testAgent.brain));
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* seedPendingRun(runId);
            const sql = yield* SqlClient.SqlClient;
            for (const number of [1, 2]) {
              yield* sql`INSERT INTO usine_attempts (attempt_id, run_id, step_name, worker_name, attempt_number, brain_json, task, agent, started_at, outcome_json)
            VALUES (${`attempt-start-${number}`}, ${runId}, ${lifecycleSubmission.step}, 'local', ${number}, ${brain}, ${lifecycleSubmission.task}, ${testAgent.name}, '2026-10-19T00:00:00.000Z', '{"_tag":"Canceled"}')`;
            }
          }).pipe(Effect.provide(previousDatabase)),
        );
        yield* Effect.gen(function* () {
          const store = yield* RunStore;
          const attempts = (yield* store.snapshot(runId)).attempts;
          assert.deepStrictEqual(
            attempts.map(({ start }) => Option.map(start, ({ _tag }) => _tag)),
            [Option.some("Event"), Option.none()],
          );
          assert(attempts.every(({ reattachedAt }) => Option.isNone(reattachedAt)));
        }).pipe(
          Effect.provide(RunStore.layer.pipe(Layer.provideMerge(localSqliteLayer(directory)))),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("Run approval source migration", () => {
  it.live("renames an applied approval migration without replaying it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fs.makeTempDirectoryScoped({
          directory: sqliteTempDirectory(),
          prefix: "usine-approval-rename-",
        }),
      );
      const previous = yield* Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE usine_migrations SET name = '20261029101340_bored_paladin' WHERE name = '20261029101340_member_approval_source'`;
          return yield* sql`SELECT id, hash, created_at, applied_at FROM usine_migrations ORDER BY id`;
        }).pipe(Effect.provide(localSqliteLayer(directory))),
      );
      for (let start = 0; start < 2; start++)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.deepStrictEqual(
              yield* sql`SELECT id, hash, created_at, applied_at FROM usine_migrations ORDER BY id`,
              previous,
            );
            assert.strictEqual(
              (yield* sql`SELECT name FROM usine_migrations WHERE name = '20261029101340_member_approval_source'`)
                .length,
              1,
            );
            assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
          }).pipe(Effect.provide(localSqliteLayer(directory))),
        );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  for (const recorded of [false, true])
    it.live(
      `preserves the approver when upgrading ${recorded ? "a GitHub approval" : "an unrecorded approval"}`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = InstanceDirectory.make(
            yield* fs.makeTempDirectoryScoped({
              directory: sqliteTempDirectory(),
              prefix: "usine-approval-source-upgrade-",
            }),
          );
          const historical = yield* fs.makeTempDirectoryScoped({
            directory: sqliteTempDirectory(),
            prefix: "usine-approval-source-migrations-",
          });
          const source = fileURLToPath(new URL("../../drizzle", import.meta.url));
          for (const name of yield* fs.readDirectory(source)) {
            if (
              name >=
              (recorded
                ? "20261029101340_member_approval_source"
                : "20261019104043_run_approval_source")
            )
              continue;
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
              if (recorded)
                yield* sql`UPDATE usine_approvals SET channel = 'github-ask', approver = 'alice' WHERE run_id = ${runId}`;
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
                RunApproval.make({
                  approvedAt: DateTime.makeUnsafe("2026-10-01T00:05:00.000Z"),
                  source: recorded
                    ? Option.some(
                        ApprovalSource.make({
                          channel: "ui",
                          approver: Option.some(OperatorLogin.make("alice")),
                        }),
                      )
                    : Option.none(),
                }),
              ),
            );
            const sql = yield* SqlClient.SqlClient;
            assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
            assert.strictEqual((yield* sql`PRAGMA foreign_keys`)[0]?.foreign_keys, 1);
            const rejected =
              yield* sql`UPDATE usine_approvals SET channel = 'invalid' WHERE run_id = ${runId}`.pipe(
                Effect.flip,
              );
            assert.include(String(rejected.reason.cause), "CHECK constraint failed");
          }).pipe(
            Effect.provide(RunStore.layer.pipe(Layer.provideMerge(localSqliteLayer(directory)))),
          );
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
});

describe("Run close time migration", () => {
  it.live("dates a Run closed before the upgrade by its last Attempt's end or start", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fs.makeTempDirectoryScoped({
          directory: sqliteTempDirectory(),
          prefix: "usine-run-closed-at-upgrade-",
        }),
      );
      const historical = yield* fs.makeTempDirectoryScoped({
        directory: sqliteTempDirectory(),
        prefix: "usine-run-closed-at-migrations-",
      });
      const source = fileURLToPath(new URL("../../drizzle", import.meta.url));
      for (const name of yield* fs.readDirectory(source)) {
        if (name >= "20261020191320_run_closed_at") continue;
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
        Layer.provideMerge(SqliteClient.layer({ filename: `${directory}/.usine/runtime.sqlite` })),
      );
      const runId = RunId.make("closed-before-upgrade");
      const brain = JSON.stringify(Schema.encodeSync(BrainSpec)(testAgent.brain));
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* seedPendingRun(runId);
          const sql = yield* SqlClient.SqlClient;
          // The first Attempt recorded its end; the second ended before end times were recorded.
          yield* sql`INSERT INTO usine_attempts (attempt_id, run_id, step_name, worker_name, attempt_number, brain_json, task, agent, started_at, outcome_json, ended_at)
            VALUES ('closed-before-upgrade-1', ${runId}, ${lifecycleSubmission.step}, 'local', 1, ${brain}, ${lifecycleSubmission.task}, ${testAgent.name}, '2026-10-19T00:00:00.000Z', '{"_tag":"Canceled"}', '2026-10-19T00:10:00.000Z')`;
          yield* sql`INSERT INTO usine_attempts (attempt_id, run_id, step_name, worker_name, attempt_number, brain_json, task, agent, started_at, outcome_json)
            VALUES ('closed-before-upgrade-2', ${runId}, ${lifecycleSubmission.step}, 'local', 2, ${brain}, ${lifecycleSubmission.task}, ${testAgent.name}, '2026-10-19T01:00:00.000Z', '{"_tag":"Canceled"}')`;
          yield* sql`UPDATE usine_runs SET state_json = '{"_tag":"Canceled","reason":{"_tag":"OperatorCanceled"}}' WHERE run_id = ${runId}`;
        }).pipe(Effect.provide(previousDatabase)),
      );
      yield* Effect.gen(function* () {
        const store = yield* RunStore;
        assert.deepStrictEqual(
          (yield* store.snapshot(runId)).closedAt,
          Option.some(DateTime.makeUnsafe("2026-10-19T01:00:00.000Z")),
        );
      }).pipe(Effect.provide(RunStore.layer.pipe(Layer.provideMerge(localSqliteLayer(directory)))));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("Transcript read model migration", () => {
  it.live(
    "backfills the same usage and pool snapshots as transcript grouping and preserves envelopes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = InstanceDirectory.make(
          yield* fs.makeTempDirectoryScoped({
            directory: sqliteTempDirectory(),
            prefix: "usine-transcript-upgrade-",
          }),
        );
        const historical = yield* fs.makeTempDirectoryScoped({
          directory: sqliteTempDirectory(),
          prefix: "usine-transcript-migrations-",
        });
        const source = fileURLToPath(new URL("../../drizzle", import.meta.url));
        for (const name of yield* fs.readDirectory(source)) {
          if (name >= "20261103105216_transcript_read_models") continue;
          yield* fs.copy(`${source}/${name}`, `${historical}/${name}`);
        }
        yield* fs.makeDirectory(`${directory}/.usine`);
        const previous = Layer.effect(
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
        const expected = yield* Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const runId = RunId.make("transcript-upgrade");
            yield* seedPendingRun(runId);
            const at = DateTime.makeUnsafe("2026-11-01T00:00:00.000Z");
            const brain = JSON.stringify(Schema.encodeSync(BrainSpec)(testAgent.brain));
            for (const attempt of [1, 2]) {
              const attemptId = AttemptId.make(`transcript-upgrade-${attempt}`);
              yield* sql`INSERT INTO usine_attempts (attempt_id, run_id, step_name, worker_name, attempt_number, brain_json, task, agent, started_at, outcome_json)
            VALUES (${attemptId}, ${runId}, ${lifecycleSubmission.step}, 'local', ${attempt}, ${brain}, ${lifecycleSubmission.task}, ${testAgent.name}, '2026-11-01T00:00:00.000Z', '{"_tag":"Succeeded"}')`;
              const parent = ParentSession.make({
                id: AgentSessionId.make("shared-parent"),
                agent: testAgent.name,
                brain: testAgent.brain,
              });
              const child = ChildSession.make({
                id: AgentSessionId.make("shared-child"),
                parentId: parent.id,
                agent: testAgent.name,
                brain: testAgent.brain,
              });
              const events = [
                SessionTokensUpdated.make({
                  session: parent,
                  totalTokens: TokenCount.make(100 * attempt),
                }),
                SessionTokensUpdated.make({
                  session: child,
                  totalTokens: TokenCount.make(40 * attempt),
                }),
                SessionTokensUpdated.make({
                  session: parent,
                  totalTokens: TokenCount.make(250 * attempt),
                }),
                SessionTokensUpdated.make({
                  session: child,
                  totalTokens: TokenCount.make(90 * attempt),
                  costUsd: Option.some(UsdAmount.make(1)),
                }),
                SessionTokensUpdated.make({
                  session: parent,
                  totalTokens: TokenCount.make(200 * attempt),
                }),
                SessionTokensUpdated.make({
                  session: child,
                  totalTokens: TokenCount.make(90 * attempt),
                  costUsd: Option.some(UsdAmount.make(2)),
                }),
                ...(["chatgptPlan", "claudePlan"] as const).map((pool) =>
                  PoolRateLimitsUpdated.make({
                    session: parent,
                    pool,
                    login: Option.some(PoolLogin.make(`login-${attempt}`)),
                    rateLimits: RateLimitsSnapshot.make({
                      limitId: Option.none(),
                      limitName: Option.none(),
                      primary: Option.none(),
                      secondary: Option.none(),
                    }),
                  }),
                ),
              ];
              for (const [i, event] of events.entries()) {
                const envelope = JSON.stringify(
                  Schema.encodeSync(AttemptChannel.Envelope)(
                    AttemptChannel.OutboundEnvelope.make({
                      version: AttemptChannel.PROTOCOL_VERSION,
                      attemptId,
                      sequence: AttemptChannel.Sequence.make(i + 1),
                      sentAt: at,
                      payload: AttemptChannel.SessionEvent.make({ event }),
                    }),
                  ),
                );
                yield* sql`INSERT INTO usine_attempt_transcripts (attempt_id, direction, channel_sequence, envelope, received_at)
              VALUES (${attemptId}, 'outbound', ${i + 1}, ${envelope}, '2026-11-01T00:00:00.000Z')`;
                yield* sql`INSERT INTO usine_attempt_transcripts (attempt_id, direction, channel_sequence, envelope, received_at)
              VALUES (${attemptId}, 'outbound', ${i + 1}, ${envelope}, '2026-11-02T00:00:00.000Z') ON CONFLICT DO NOTHING`;
              }
            }
            return {
              all: yield* sql`SELECT * FROM usine_attempt_transcripts ORDER BY sequence`,
              usage:
                yield* sql`SELECT attempt_id, json_extract(envelope, '$.payload.event.session.id') AS session_id,
            max(json_extract(envelope, '$.payload.event.totalTokens')) AS total_tokens, sequence, received_at, envelope
            FROM usine_attempt_transcripts WHERE direction = 'outbound'
            AND json_extract(envelope, '$.payload._tag') = 'SessionEvent'
            AND json_extract(envelope, '$.payload.event._tag') = 'SessionTokensUpdated'
            GROUP BY attempt_id, json_extract(envelope, '$.payload.event.session.id') ORDER BY attempt_id, session_id`,
              pools:
                yield* sql`SELECT json_extract(envelope, '$.payload.event.pool') AS pool, max(sequence) AS sequence, attempt_id, received_at, envelope
            FROM usine_attempt_transcripts WHERE direction = 'outbound'
            AND json_extract(envelope, '$.payload._tag') = 'SessionEvent'
            AND json_extract(envelope, '$.payload.event._tag') = 'PoolRateLimitsUpdated'
            GROUP BY json_extract(envelope, '$.payload.event.pool') ORDER BY pool`,
            };
          }).pipe(Effect.provide(previous)),
        );
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(
            yield* sql`SELECT * FROM usine_session_usage ORDER BY attempt_id, session_id`,
            expected.usage,
          );
          assert.deepStrictEqual(
            yield* sql`SELECT * FROM usine_pool_rate_limits ORDER BY pool`,
            expected.pools,
          );
          assert.deepStrictEqual(
            yield* sql`SELECT sequence, attempt_id, direction, channel_sequence, envelope, received_at FROM usine_attempt_transcripts ORDER BY sequence`,
            expected.all,
          );
          const columns = yield* sql`PRAGMA table_xinfo(usine_attempt_transcripts)`;
          assert.deepStrictEqual(
            columns.filter(({ hidden }) => hidden === 2).map(({ name }) => name),
            ["payload_tag", "event_tag", "session_id"],
          );
          assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
          assert.strictEqual((yield* sql`PRAGMA foreign_keys`)[0]?.foreign_keys, 1);
        }).pipe(Effect.provide(localSqliteLayer(directory)));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
