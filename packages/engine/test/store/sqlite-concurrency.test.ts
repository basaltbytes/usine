import { assert, it } from "@effect/vitest";
import { AgentSessionId, ParentSession, TextOutput } from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import { DateTime, Effect, Fiber, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { createServer } from "node:http";
import { RunStore } from "../../src/store/store.ts";
import { lifecycleSubmission, testAgent, withRunStore } from "./support.ts";

it.live("transcript appends and HTTP health finish within 100 ms during a one-second read", () =>
  withRunStore(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* RunStore;
      const runId = RunId.make("concurrent-read");
      yield* store.recordAndClaim(lifecycleSubmission, runId);
      const started = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
      assert(started._tag === "AttemptStarted");
      const envelope = new AttemptChannel.OutboundEnvelope({
        version: AttemptChannel.PROTOCOL_VERSION,
        attemptId: started.execution.attempt.id,
        sequence: AttemptChannel.Sequence.make(1),
        sentAt: DateTime.makeUnsafe("2026-11-03T00:00:00Z"),
        payload: new AttemptChannel.SessionEvent({
          event: new TextOutput({
            session: new ParentSession({
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
      const address = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Number }))(
        server.address(),
      );
      yield* Effect.promise(async () =>
        (await fetch(`http://127.0.0.1:${address.port}/health`)).text(),
      );
      const readStarted = performance.now();
      const slow = yield* sql`WITH RECURSIVE numbers(i) AS (
        VALUES(1) UNION ALL SELECT i + 1 FROM numbers WHERE i < 32000000
      ) SELECT sum(i) AS total FROM numbers`.pipe(Effect.forkScoped);
      for (let sequence = 1; sequence <= 3; sequence++) {
        const start = performance.now();
        yield* Effect.sleep("20 millis");
        yield* store.appendTranscript(
          "outbound",
          new AttemptChannel.OutboundEnvelope({
            ...envelope,
            sequence: AttemptChannel.Sequence.make(sequence),
          }),
        );
        const response = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${address.port}/health`),
        );
        assert.strictEqual(yield* Effect.promise(() => response.text()), "ok");
        assert(
          performance.now() - start < 100,
          "append and HTTP health exceeded 100 ms, including timer delay",
        );
        assert(slow.pollUnsafe() === undefined, "the read must still be running");
      }
      assert.deepStrictEqual(yield* Fiber.join(slow), [{ total: 512000016000000 }]);
      assert(performance.now() - readStarted >= 1000, "the read must run for at least one second");
      assert.deepStrictEqual(
        yield* sql`SELECT count(*) AS count FROM usine_attempt_transcripts WHERE attempt_id = ${started.execution.attempt.id}`,
        [{ count: 3 }],
      );
    }).pipe(Effect.scoped),
  ),
);

it.live(
  "WAL reads preserve SQL results, transaction isolation, savepoints, and reserved connection state",
  () =>
    withRunStore(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE reader_contract (value INTEGER NOT NULL)`;
        const inserted = yield* sql`INSERT INTO reader_contract VALUES (1)`.raw;
        assert.deepStrictEqual(inserted, { changes: 1, lastInsertRowid: 1 });
        assert.deepStrictEqual(yield* sql`SELECT value FROM reader_contract`.values, [[1]]);
        assert.deepStrictEqual(yield* sql`SELECT value FROM reader_contract`.raw, [{ value: 1 }]);
        assert.deepStrictEqual(
          yield* sql`SELECT 9007199254740993 AS value`.pipe(
            Effect.provideService(SqlClient.SafeIntegers, true),
          ),
          [{ value: 9007199254740993n }],
        );
        assert.deepStrictEqual(yield* sql`SELECT ${new Uint8Array([1, 2])} AS value`, [
          { value: new Uint8Array([1, 2]) },
        ]);
        assert.deepStrictEqual(yield* sql`SELECT ${new Uint16Array([1, 2])} AS value`, [
          { value: new Uint8Array([1, 0, 2, 0]) },
        ]);
        yield* sql`-- SELECT in a comment
        WITH candidate AS (SELECT ')' AS hint, 2 AS value)
        INSERT INTO reader_contract SELECT value FROM candidate`;
        assert.deepStrictEqual(
          yield* sql`/* INSERT in a comment */
        WITH "DELETE"(value) AS NOT MATERIALIZED (SELECT value FROM reader_contract),
        other AS (SELECT ')' AS hint) SELECT sum(value) AS total FROM "DELETE" CROSS JOIN other`,
          [{ total: 3 }],
        );
        let committed = false;
        yield* Effect.gen(function* () {
          yield* sql`INSERT INTO reader_contract VALUES (3)`;
          assert.deepStrictEqual(yield* sql`SELECT sum(value) AS total FROM reader_contract`, [
            { total: 6 },
          ]);
          yield* Effect.gen(function* () {
            yield* sql`INSERT INTO reader_contract VALUES (4)`;
            return yield* Effect.fail("rollback savepoint");
          }).pipe(sql.withTransaction, Effect.result);
          assert.deepStrictEqual(yield* sql`SELECT sum(value) AS total FROM reader_contract`, [
            { total: 6 },
          ]);
          yield* sql.afterCommit(
            Effect.sync(() => {
              committed = true;
            }),
          );
        }).pipe(sql.withTransaction);
        assert(committed);
        assert.deepStrictEqual(yield* sql`SELECT sum(value) AS total FROM reader_contract`, [
          { total: 6 },
        ]);
        yield* Effect.gen(function* () {
          yield* sql`INSERT INTO reader_contract VALUES (9)`;
          return yield* Effect.fail("rollback transaction");
        }).pipe(sql.withTransaction, Effect.result);
        assert.deepStrictEqual(yield* sql`SELECT sum(value) AS total FROM reader_contract`, [
          { total: 6 },
        ]);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* sql.reserve;
            yield* connection.executeUnprepared(
              "CREATE TEMP TABLE local_state AS SELECT 42 AS value",
              [],
              undefined,
            );
            assert.deepStrictEqual(
              yield* connection.execute("SELECT value FROM local_state", [], undefined),
              [{ value: 42 }],
            );
          }),
        );
        const invalid = yield* sql`SELECT missing FROM reader_contract`.pipe(Effect.flip);
        assert.strictEqual(invalid._tag, "SqlError");
        const invalidBinding = yield* sql.unsafe("SELECT ?", [new Date()]).pipe(Effect.flip);
        assert.strictEqual(invalidBinding._tag, "SqlError");
        assert.deepStrictEqual(yield* sql`SELECT 42 AS value`, [{ value: 42 }]);
      }),
    ),
);
