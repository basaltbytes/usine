import { FetchHttpClient } from "effect/http";
import { webRequest } from "../../../../../tooling/test/http.mts";
import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { InstanceDirectory } from "@usine/core/instance";
import { Console, Context, Effect, Fiber, Layer, Schema, FileSystem } from "effect";
import { SqlClient } from "effect/sql";
import { monitorEventLoopDelay } from "node:perf_hooks";
// The Node server adapter requires native HTTP server and connection types.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { localSqliteLayer } from "../../../src/database/local-sqlite.ts";
import { seedReadFixture } from "./fixture.ts";

// Run with Node's type stripping from packages/engine; the optional second argument is
// an absolute path to Turso 0.8.3's ESM entry. A third argument compares sqlite3 5.1.7.
// Install comparison drivers outside the repo.
const directory = InstanceDirectory.make(process.argv[2] ?? "/tmp/usine-event-loop-fixture");
const query =
  "SELECT sum(json_extract(envelope, '$.payload.event.totalTokens')) AS total FROM usine_attempt_transcripts";
const report: Array<object> = [];
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const database = yield* Layer.build(localSqliteLayer(directory));
      const sql = Context.get(database, SqlClient.SqlClient);
      const count = yield* sql`SELECT count(*) AS count FROM usine_attempt_transcripts`;
      if (count[0]?.count === 0) yield* seedReadFixture(3000).pipe(Effect.provideContext(database));
      yield* sql`CREATE TABLE IF NOT EXISTS event_loop_appends (value TEXT)`;
      const baseline = yield* Layer.build(
        SqliteClient.layer({
          filename: `${directory}/.usine/runtime.sqlite`,
          readonly: true,
          disableWAL: true,
        }),
      );
      const before = Context.get(baseline, SqlClient.SqlClient);
      const server = createServer((_request, response) => response.end("ok"));
      yield* Effect.callback<void>((resume) => {
        const resolve = (value: void) => resume(Effect.succeed(value));
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Finite }))(
        server.address(),
      );
      const health = `http://127.0.0.1:${address.port}/health`;
      const measure = <E, R>(name: string, read: Effect.Effect<object, E, R>) =>
        Effect.gen(function* () {
          yield* read;
          const histogram = monitorEventLoopDelay({ resolution: 10 });
          histogram.enable();
          const queryMillis: number[] = [];
          const appendAndHealthMillis: number[] = [];
          try {
            for (let sample = 0; sample < 3; sample++) {
              yield* Effect.sleep(30);
              const started = performance.now();
              const reading = yield* Effect.forkChild(read, { startImmediately: true });
              const writing = yield* Effect.gen(function* () {
                yield* Effect.sleep(20);
                yield* sql`INSERT INTO event_loop_appends VALUES ('progress')`;
                const response = yield* webRequest(health);
                yield* Effect.promise(() => response.text());
                appendAndHealthMillis.push(performance.now() - started);
              }).pipe(Effect.forkChild({ startImmediately: true }));
              yield* Fiber.join(reading);
              queryMillis.push(performance.now() - started);
              yield* Fiber.join(writing);
              yield* Effect.sleep(30);
            }
          } finally {
            histogram.disable();
          }
          report.push({
            name,
            queryMillis,
            appendAndHealthMillis,
            p99Millis: histogram.percentile(99) / 1e6,
            maxMillis: histogram.max / 1e6,
          });
        });
      try {
        yield* measure("main node:sqlite (before)", before.unsafe(query));
        yield* measure("read worker (after)", sql.unsafe(query));
        const tursoPath = process.argv[3];
        if (tursoPath !== undefined) {
          interface TursoConnection {
            prepare(query: string): { all(): Promise<object[]> };
            close(): Promise<void>;
          }
          const { connect } = yield* Effect.promise<{
            connect(path: string, options: { experimental: string[] }): Promise<TursoConnection>;
          }>(() => import(pathToFileURL(tursoPath).href));
          const turso = yield* Effect.promise(() =>
            connect(`${directory}/.usine/runtime.sqlite`, { experimental: ["generated_columns"] }),
          );
          try {
            yield* measure(
              "Turso 0.8.3 promise API",
              Effect.promise(() => turso.prepare(query).all()),
            );
          } finally {
            yield* Effect.promise(() => turso.close());
          }
        }
        const sqlitePath = process.argv[4];
        if (sqlitePath !== undefined) {
          interface SqliteConnection {
            all(query: string, complete: (error: Error | null, rows: object[]) => void): void;
            close(complete: (error: Error | null) => void): void;
          }
          const { default: sqlite3 } = yield* Effect.promise<{
            default: {
              Database: new (path: string, mode: number) => SqliteConnection;
              OPEN_READONLY: number;
            };
          }>(() => import(pathToFileURL(sqlitePath).href));
          const asyncDb = new sqlite3.Database(
            `${directory}/.usine/runtime.sqlite`,
            sqlite3.OPEN_READONLY,
          );
          try {
            yield* measure(
              "sqlite3 5.1.7 async API",
              Effect.callback<object[]>((resume) => {
                asyncDb.all(query, (error, rows) =>
                  resume(error === null ? Effect.succeed(rows) : Effect.die(error)),
                );
              }),
            );
          } finally {
            yield* Effect.callback<void>((resume) => {
              asyncDb.close((error) => resume(error === null ? Effect.void : Effect.die(error)));
            });
          }
        }
      } finally {
        yield* Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void));
        });
      }
      const file = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.stat(`${directory}/.usine/runtime.sqlite`),
      );
      const rows = yield* sql`SELECT count(*) AS count FROM usine_attempt_transcripts`;
      const json = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))({
        node: process.version,
        bytes: Number(file.size),
        query,
        rows: rows[0],
        report,
      });
      yield* Console.log(json);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer))),
);
