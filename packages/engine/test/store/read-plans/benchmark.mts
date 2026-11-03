import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { InstanceDirectory } from "@usine/core/instance";
import { Console, Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createServer } from "node:http";
import { stat } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
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
      const effectContext = yield* Effect.context<never>();

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
      yield* Effect.promise(
        () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
      );
      const address = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Finite }))(
        server.address(),
      );
      const health = `http://127.0.0.1:${address.port}/health`;
      const measure = async (name: string, read: () => Promise<object>) => {
        await read();
        const histogram = monitorEventLoopDelay({ resolution: 10 });
        histogram.enable();
        const queryMillis: number[] = [];
        const appendAndHealthMillis: number[] = [];
        for (let sample = 0; sample < 3; sample++) {
          await setTimeout(30);
          const started = performance.now();
          const reading = read();
          const writing = (async () => {
            await setTimeout(20);
            await Effect.runPromiseWith(effectContext)(
              sql`INSERT INTO event_loop_appends VALUES ('progress')`,
            );
            await (await fetch(health)).text();
            appendAndHealthMillis.push(performance.now() - started);
          })();
          await reading;
          queryMillis.push(performance.now() - started);
          await writing;
          await setTimeout(30);
        }
        histogram.disable();
        report.push({
          name,
          queryMillis,
          appendAndHealthMillis,
          p99Millis: histogram.percentile(99) / 1e6,
          maxMillis: histogram.max / 1e6,
        });
      };
      yield* Effect.promise(async () => {
        try {
          await measure("main node:sqlite (before)", () =>
            Effect.runPromiseWith(effectContext)(before.unsafe(query)),
          );
          await measure("read worker (after)", () =>
            Effect.runPromiseWith(effectContext)(sql.unsafe(query)),
          );
          if (process.argv[3] !== undefined) {
            const { connect } = await import(pathToFileURL(process.argv[3]).href);
            const turso = await connect(`${directory}/.usine/runtime.sqlite`, {
              experimental: ["generated_columns"],
            });
            try {
              await measure("Turso 0.8.3 promise API", () => turso.prepare(query).all());
            } finally {
              await turso.close();
            }
          }
          if (process.argv[4] !== undefined) {
            const sqlite3 = (await import(pathToFileURL(process.argv[4]).href)).default;
            const asyncDb = new sqlite3.Database(
              `${directory}/.usine/runtime.sqlite`,
              sqlite3.OPEN_READONLY,
            );
            try {
              await measure(
                "sqlite3 5.1.7 async API",
                () =>
                  new Promise<object[]>((resolve, reject) => {
                    asyncDb.all(query, (error: Error | null, rows: object[]) =>
                      error === null ? resolve(rows) : reject(error),
                    );
                  }),
              );
            } finally {
              await new Promise<void>((resolve, reject) =>
                asyncDb.close((error: Error | null) =>
                  error === null ? resolve() : reject(error),
                ),
              );
            }
          }
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        await Effect.runPromiseWith(effectContext)(
          Console.log(
            JSON.stringify(
              {
                node: process.version,
                bytes: (await stat(`${directory}/.usine/runtime.sqlite`)).size,
                query,
                rows: (
                  await Effect.runPromiseWith(effectContext)(
                    sql`SELECT count(*) AS count FROM usine_attempt_transcripts`,
                  )
                )[0],
                report,
              },
              null,
              2,
            ),
          ),
        );
      });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
