import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { sqliteTempDirectory } from "../../../../tooling/test/sqlite.mts";
import { assert, it } from "@effect/vitest";
import { AgentSessionId, ParentSession, TextOutput } from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { InstanceDirectory } from "@usine/core/instance";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import {
  DateTime,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Ref,
  Schedule,
  Schema,
} from "effect";
import { EffectLogger } from "drizzle-orm/effect-core";
import * as SQLiteDrizzle from "drizzle-orm/effect-sqlite-node";
import { RunDatabase } from "../../src/database/database.ts";
import { localSqliteLayer } from "../../src/database/local-sqlite.ts";
import { RunReader } from "../../src/run-reader/run-reader.ts";
import { SqlClient } from "effect/sql";
import { Reactivity } from "effect/reactivity";
import { TestClock } from "effect/testing";
import { Worker } from "node:worker_threads";
import { spawnWorker } from "../../src/database/sqlite-reader/connection.ts";
import { withReadWorker } from "../../src/database/sqlite-reader/reader.ts";
import { createServer } from "node:http";
import { RunStore } from "../../src/store/store.ts";
import { lifecycleSubmission, testAgent, withRunStore } from "./support.ts";

for (const method of ["standalone", "list", "board"] as const) {
  it.live(
    `transcript appends and HTTP health finish within 100 ms during a one-second ${method} read`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const currentDirectory = yield* fs.makeTempDirectoryScoped({
          directory: sqliteTempDirectory(),
        });
        const directory = InstanceDirectory.make(currentDirectory);
        return yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const store = yield* RunStore;
          const runId = RunId.make("concurrent-read");
          yield* store.recordAndClaim(lifecycleSubmission, runId);
          const started = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
          assert(started._tag === "AttemptStarted");
          const envelope = AttemptChannel.OutboundEnvelope.make({
            version: AttemptChannel.PROTOCOL_VERSION,
            attemptId: started.execution.attempt.id,
            sequence: AttemptChannel.Sequence.make(1),
            sentAt: DateTime.makeUnsafe("2026-11-03T00:00:00Z"),
            payload: AttemptChannel.SessionEvent.make({
              event: TextOutput.make({
                session: ParentSession.make({
                  id: AgentSessionId.make("concurrent-session"),
                  agent: testAgent.name,
                  brain: testAgent.brain,
                }),
                text: "append while reading",
              }),
            }),
          });
          const server = yield* Effect.acquireRelease(
            Effect.promise(
              () =>
                new Promise<ReturnType<typeof createServer>>((resolve) => {
                  const server = createServer((_request, response) => response.end("ok"));
                  server.listen(0, "127.0.0.1", () => resolve(server));
                }),
            ),
            (server) =>
              Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
          );
          const address = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Finite }))(
            server.address(),
          );
          yield* Effect.promise(async () =>
            (await fetch(`http://127.0.0.1:${address.port}/health`)).text(),
          );
          const heavyRead = sql`WITH RECURSIVE numbers(i) AS (
        VALUES(1) UNION ALL SELECT i + 1 FROM numbers WHERE i < 32000000
      ) SELECT sum(i) AS total FROM numbers`;
          const entered = yield* Deferred.make<void>();
          const injected = yield* Ref.make(false);
          const logger = Layer.succeed(EffectLogger)({
            // Add expensive SQL to the first summary query in its actual connection scope.
            logQuery: () =>
              Effect.gen(function* () {
                if (yield* Ref.getAndSet(injected, true)) return;
                yield* Deferred.succeed(entered, undefined);
                yield* heavyRead;
              }).pipe(Effect.orDie),
          });
          const database = yield* SQLiteDrizzle.make().pipe(
            Effect.provide(logger.pipe(Layer.provideMerge(SQLiteDrizzle.DefaultServices))),
          );
          const read =
            method === "standalone"
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(heavyRead), Effect.asVoid)
              : Effect.gen(function* () {
                  const reader = yield* RunReader;
                  if (method === "list") {
                    assert.strictEqual((yield* reader.list({ closedLimit: 10 }))[0]?.run.id, runId);
                  } else {
                    assert.strictEqual(
                      (yield* reader.board([lifecycleSubmission.itemKey], [])).runs[0]?.run.id,
                      runId,
                    );
                  }
                }).pipe(
                  Effect.provide(
                    RunReader.layer.pipe(Layer.provideMerge(RunDatabase.layer(database))),
                  ),
                );
          const readStarted = performance.now();
          const slow = yield* read.pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          for (let sequence = 1; sequence <= 3; sequence++) {
            const start = performance.now();
            yield* Effect.sleep("20 millis");
            yield* store.appendTranscript(
              "outbound",
              AttemptChannel.OutboundEnvelope.make({
                ...envelope,
                sequence: AttemptChannel.Sequence.make(sequence),
              }),
            );
            const response = yield* Effect.promise(() =>
              fetch(`http://127.0.0.1:${address.port}/health`),
            );
            const responseBody = yield* Effect.promise(() => response.text());
            assert.strictEqual(responseBody, "ok");
            assert(
              performance.now() - start < 100,
              "append and HTTP health exceeded 100 ms, including timer delay",
            );
            assert(slow.pollUnsafe() === undefined, "the read must still be running");
          }
          yield* Fiber.join(slow);
          assert(
            performance.now() - readStarted >= 1000,
            "the read must run for at least one second",
          );
          const rows =
            yield* sql`SELECT count(*) AS count FROM usine_attempt_transcripts WHERE attempt_id = ${started.execution.attempt.id}`;
          assert.deepStrictEqual(rows, [{ count: 3 }]);
        }).pipe(
          Effect.provide(RunStore.layer.pipe(Layer.provideMerge(localSqliteLayer(directory)))),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.live(
  "WAL reads preserve SQL results, transaction isolation, savepoints, and reserved connection state",
  () =>
    withRunStore(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE reader_contract (value INTEGER NOT NULL)`;
        const inserted = yield* sql`INSERT INTO reader_contract VALUES (1)`.raw;
        assert.deepStrictEqual(inserted, { changes: 1, lastInsertRowid: 1 });
        const rows = yield* sql`SELECT value FROM reader_contract`.values;
        assert.deepStrictEqual(rows, [[1]]);
        const currentRows = yield* sql`SELECT value FROM reader_contract`.raw;
        assert.deepStrictEqual(currentRows, [{ value: 1 }]);
        const nextRows = yield* sql`SELECT 9007199254740993 AS value`.pipe(
          Effect.provideService(SqlClient.SafeIntegers, true),
        );
        assert.deepStrictEqual(nextRows, [{ value: 9007199254740993n }]);
        const updatedRows = yield* sql`SELECT ${new Uint8Array([1, 2])} AS value`;
        assert.deepStrictEqual(updatedRows, [{ value: new Uint8Array([1, 2]) }]);
        const latestRows = yield* sql`SELECT ${new Uint16Array([1, 2])} AS value`;
        assert.deepStrictEqual(latestRows, [{ value: new Uint8Array([1, 0, 2, 0]) }]);
        yield* sql`-- SELECT in a comment
        WITH candidate AS (SELECT ')' AS hint, 2 AS value)
        INSERT INTO reader_contract SELECT value FROM candidate`;
        const secondRows = yield* sql`/* INSERT in a comment */
        WITH "DELETE"(value) AS NOT MATERIALIZED (SELECT value FROM reader_contract),
        other AS (SELECT ')' AS hint) SELECT sum(value) AS total FROM "DELETE" CROSS JOIN other`;
        assert.deepStrictEqual(secondRows, [{ total: 3 }]);
        let committed = false;
        yield* Effect.gen(function* () {
          yield* sql`INSERT INTO reader_contract VALUES (3)`;
          const rows = yield* sql`SELECT sum(value) AS total FROM reader_contract`;
          assert.deepStrictEqual(rows, [{ total: 6 }]);
          yield* Effect.gen(function* () {
            yield* sql`INSERT INTO reader_contract VALUES (4)`;
            return yield* Effect.fail("rollback savepoint");
          }).pipe(sql.withTransaction, Effect.result);
          const currentRows = yield* sql`SELECT sum(value) AS total FROM reader_contract`;
          assert.deepStrictEqual(currentRows, [{ total: 6 }]);
          yield* sql.afterCommit(
            Effect.sync(() => {
              committed = true;
            }),
          );
        }).pipe(sql.withTransaction);
        assert(committed);
        const thirdRows = yield* sql`SELECT sum(value) AS total FROM reader_contract`;
        assert.deepStrictEqual(thirdRows, [{ total: 6 }]);
        yield* Effect.gen(function* () {
          yield* sql`INSERT INTO reader_contract VALUES (9)`;
          return yield* Effect.fail("rollback transaction");
        }).pipe(sql.withTransaction, Effect.result);
        const fourthRows = yield* sql`SELECT sum(value) AS total FROM reader_contract`;
        assert.deepStrictEqual(fourthRows, [{ total: 6 }]);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* sql.reserve;
            yield* connection.executeUnprepared(
              "CREATE TEMP TABLE local_state AS SELECT 42 AS value",
              [],
              undefined,
            );
            const rows = yield* connection.execute("SELECT value FROM local_state", [], undefined);
            assert.deepStrictEqual(rows, [{ value: 42 }]);
          }),
        );
        const invalid = yield* sql`SELECT missing FROM reader_contract`.pipe(Effect.flip);
        assert.strictEqual(invalid._tag, "SqlError");
        const invalidBinding = yield* sql.unsafe("SELECT ?", [new Date()]).pipe(Effect.flip);
        assert.strictEqual(invalidBinding._tag, "SqlError");
        const fifthRows = yield* sql`SELECT 42 AS value`;
        assert.deepStrictEqual(fifthRows, [{ value: 42 }]);
      }),
    ),
);

it.live(
  "a killed reader exposes worker, fallback, respawning, and worker states and resets its backoff",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ directory: sqliteTempDirectory() });
      const writer = yield* SqliteClient.make({ filename: `${directory}/runtime.sqlite` });
      const workers: Worker[] = [];
      const gate = new Int32Array(new SharedArrayBuffer(4));
      const respawned = yield* Deferred.make<void>();
      const reader = yield* withReadWorker(writer, (filename) => {
        const worker =
          workers.length === 0
            ? spawnWorker(filename)
            : new Worker(
                `
        const { workerData } = require("node:worker_threads");
        Atomics.wait(workerData.gate, 0, 0);
        import(workerData.module);
      `,
                {
                  eval: true,
                  execArgv: ["--experimental-strip-types"],
                  workerData: {
                    filename,
                    gate,
                    module: new URL("../../src/database/sqlite-reader/worker.ts", import.meta.url)
                      .href,
                  },
                },
              );
        workers.push(worker);
        if (workers.length === 2) Deferred.doneUnsafe(respawned, Effect.void);
        return worker;
      });
      const first = workers[0];
      assert(first !== undefined);
      const sql = reader.client;
      yield* sql`CREATE TABLE shared_value AS SELECT 42 AS value`;
      yield* sql`CREATE TEMP TABLE writer_only AS SELECT 1 AS value`;
      const states = [yield* reader.state];
      assert.strictEqual(states[0], "worker");
      const slow = yield* reader
        .readSnapshot(sql`WITH RECURSIVE numbers(i) AS (
      VALUES(1) UNION ALL SELECT i + 1 FROM numbers WHERE i < 32000000
    ) SELECT sum(i) AS total FROM numbers`)
        .pipe(Effect.result, Effect.forkScoped);
      yield* Effect.sleep("20 millis");
      assert(slow.pollUnsafe() === undefined);
      yield* Effect.promise(() => first.terminate());
      const interrupted = yield* Fiber.join(slow);
      assert(interrupted._tag === "Failure");
      assert.strictEqual(interrupted.failure.reason._tag, "ConnectionError");
      const currentState = yield* reader.state;
      states.push(currentState);
      assert.strictEqual(states[1], "fallback");
      const rows = yield* sql`SELECT value FROM shared_value`;
      assert.deepStrictEqual(rows, [{ value: 42 }]);
      const snapshot = yield* reader.readSnapshot(sql`SELECT value FROM writer_only`.values);
      assert.deepStrictEqual(snapshot, [[1]]);
      const currentRows = yield* sql`SELECT value FROM writer_only`.raw;
      assert.deepStrictEqual(currentRows, [{ value: 1 }]);
      const nextRows = yield* sql`SELECT 9007199254740993 AS value`.pipe(
        Effect.provideService(SqlClient.SafeIntegers, true),
      );
      assert.deepStrictEqual(nextRows, [{ value: 9007199254740993n }]);
      yield* Deferred.await(respawned);
      const nextState = yield* reader.state;
      states.push(nextState);
      assert.strictEqual(states[2], "respawning");
      const updatedRows = yield* sql`SELECT value FROM writer_only`;
      assert.deepStrictEqual(updatedRows, [{ value: 1 }]);
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
      const updatedState = yield* reader.state.pipe(
        Effect.repeat({
          until: (state) => state === "worker",
          schedule: Schedule.spaced("10 millis"),
        }),
        Effect.timeout("5 seconds"),
      );
      states.push(updatedState);
      assert.deepStrictEqual(states, ["worker", "fallback", "respawning", "worker"]);
      const latestRows = yield* sql`SELECT value FROM shared_value`;
      assert.deepStrictEqual(latestRows, [{ value: 42 }]);
      const workerRead = yield* sql`SELECT value FROM writer_only`.pipe(Effect.flip);
      assert.strictEqual(workerRead._tag, "SqlError");
      const latestState = yield* reader.state;
      assert.strictEqual(latestState, "worker");
      const recovered = workers[1];
      assert(recovered !== undefined);
      yield* Effect.promise(() => recovered.terminate());
      const secondState = yield* reader.state;
      assert.strictEqual(secondState, "fallback");
      yield* reader.state.pipe(
        Effect.repeat({
          until: (state) => state === "worker",
          schedule: Schedule.spaced("10 millis"),
        }),
        Effect.timeout("3 seconds"),
      );
      const secondRows = yield* sql`SELECT value FROM shared_value`;
      assert.deepStrictEqual(secondRows, [{ value: 42 }]);
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer.pipe(Layer.provideMerge(Reactivity.layer))),
    ),
);

it.live(
  "worker snapshots release their session after failure and interruption and exclude unrelated reads",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ directory: sqliteTempDirectory() });
      const writer = yield* SqliteClient.make({ filename: `${directory}/runtime.sqlite` });
      const reader = yield* withReadWorker(writer);
      const sql = reader.client;
      yield* sql`CREATE TABLE snapshot_value AS SELECT 1 AS value`;
      yield* Effect.gen(function* () {
        yield* sql`UPDATE snapshot_value SET value = 2`;
        const snapshot = yield* reader.readSnapshot(sql`SELECT value FROM snapshot_value`);
        assert.deepStrictEqual(snapshot, [{ value: 2 }]);
        return yield* Effect.fail("rollback writer");
      }).pipe(writer.withTransaction, Effect.result);
      const entered = yield* Deferred.make<void>();
      const slow = yield* reader
        .readSnapshot(
          Effect.gen(function* () {
            const rows = yield* sql`SELECT value FROM snapshot_value`;
            assert.deepStrictEqual(rows, [{ value: 1 }]);
            yield* Deferred.succeed(entered, undefined);
            yield* sql`WITH RECURSIVE numbers(i) AS (
        VALUES(1) UNION ALL SELECT i + 1 FROM numbers WHERE i < 32000000
      ) SELECT sum(i) AS total FROM numbers`;
            return yield* Effect.never;
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* writer`UPDATE snapshot_value SET value = 3`;
      const unrelated = yield* sql`SELECT value FROM snapshot_value`.pipe(Effect.forkScoped);
      yield* Effect.sleep("20 millis");
      assert(
        unrelated.pollUnsafe() === undefined,
        "standalone reads must wait outside the snapshot",
      );
      yield* Fiber.interrupt(slow);
      const unrelatedResult = yield* Fiber.join(unrelated);
      assert.deepStrictEqual(unrelatedResult, [{ value: 3 }]);
      const failed = yield* reader
        .readSnapshot(sql`SELECT value FROM missing_snapshot_table`)
        .pipe(Effect.result);
      assert(failed._tag === "Failure");
      const currentState = yield* reader.state;
      assert.strictEqual(currentState, "worker");
      const snapshot = yield* reader.readSnapshot(sql`SELECT value FROM snapshot_value`);
      assert.deepStrictEqual(snapshot, [{ value: 3 }]);
      const nextState = yield* reader.state;
      assert.strictEqual(nextState, "worker");
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer.pipe(Layer.provideMerge(Reactivity.layer))),
    ),
);

it.effect(
  "failed worker starts back off to five minutes and stop retrying when the scope closes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ directory: sqliteTempDirectory() });
      const writer = yield* SqliteClient.make({ filename: `${directory}/runtime.sqlite` });
      let starts = 0;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reader = yield* withReadWorker(writer, () => {
            starts++;
            throw new Error("worker creation failed");
          });
          const currentState = yield* reader.state;
          assert.strictEqual(currentState, "fallback");
          const rows = yield* reader.client`SELECT 42 AS value`;
          assert.deepStrictEqual(rows, [{ value: 42 }]);
          for (const delay of [1000, 5000, 30000, 300000, 300000]) {
            const before = starts;
            yield* TestClock.adjust(delay - 1);
            assert.strictEqual(starts, before);
            yield* TestClock.adjust(1);
            assert.strictEqual(starts, before + 1);
          }
        }),
      );
      const closedStarts = starts;
      yield* TestClock.adjust("10 minutes");
      assert.strictEqual(starts, closedStarts);
    }).pipe(Effect.provide(NodeServices.layer.pipe(Layer.provideMerge(Reactivity.layer)))),
);
