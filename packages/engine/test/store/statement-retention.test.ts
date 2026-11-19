import { jsonKey } from "@usine/core/json-key";
import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { InstanceDirectory } from "@usine/core/instance";
import { Context, Effect, FileSystem, Layer } from "effect";
import { SqlClient, Statement } from "effect/sql";
import { TestClock } from "effect/testing";
// The retention assertion must run after Node’s check phase releases native async handles.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { setImmediate } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { sqliteTempDirectory } from "../../../../tooling/test/sqlite.mts";
import { localSqliteLayer } from "../../src/database/local-sqlite.ts";

it.effect("cached SQLite statements release completed responses across six hours of polling", () =>
  Effect.gen(function* () {
    const json1 = jsonKey({
      data: "x".repeat(1024 * 1024),
    });
    class ResponsePayload {
      readonly body = json1;
    }

    const fs = yield* FileSystem.FileSystem;
    const currentDirectory = yield* fs.makeTempDirectoryScoped({
      directory: sqliteTempDirectory(),
      prefix: "usine-statement-retention-",
    });
    const directory = InstanceDirectory.make(currentDirectory);
    const database = yield* Layer.build(localSqliteLayer(directory));
    const sql = Context.get(database, SqlClient.SqlClient);
    const context = (yield* Effect.context<never>()).pipe(Context.merge(database));

    for (let hour = 0; hour <= 6; hour++) {
      for (let index = 0; index < 8; index++) {
        for (const method of ["execute", "raw", "values"] as const) {
          for (const propagate of [false, true]) {
            const query = sql.unsafe(`SELECT ${index} AS value /* ${method}-${propagate} */`);
            const operation = method === "execute" ? query : query[method];
            const request = operation.pipe(
              Effect.tap((rows) =>
                Effect.sync(() =>
                  assert.deepStrictEqual(
                    rows,
                    method === "values" ? [[index]] : [{ value: index }],
                  ),
                ),
              ),
              Effect.andThen(Effect.sync(() => new ResponsePayload())),
              Effect.withSpan("http.request"),
              Effect.asVoid,
              Effect.provideService(Statement.SpanPropagationEnabled, propagate),
              Effect.provideContext(context),
            );
            yield* request;
          }
        }
      }
      // Allow promise and async context cleanup between full collections, with the cache open.
      yield* Effect.promise(() => setImmediate());
      queryObjects(ResponsePayload, { format: "count" });
      yield* Effect.promise(() => setImmediate());
      assert.strictEqual(queryObjects(ResponsePayload, { format: "count" }), 0);
      const currentRows = yield* sql`SELECT 42 AS value`;
      assert.deepStrictEqual(currentRows, [{ value: 42 }]);
      if (hour < 6) yield* TestClock.adjust("1 hour");
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
