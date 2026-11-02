import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { InstanceDirectory } from "@usine/core/instance";
import { Context, Effect, FileSystem, Layer, Option, Tracer } from "effect";
import { SqlClient, Statement } from "effect/sql";
import { TestClock } from "effect/testing";
import { setImmediate } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { sqliteTempDirectory } from "../../../../tooling/test/sqlite.mts";
import { localSqliteLayer } from "../../src/database/local-sqlite.ts";

it.effect("cached SQLite statements release completed responses across six hours of polling", () =>
  Effect.gen(function* () {
    class ResponsePayload {
      readonly body = JSON.stringify({ data: "x".repeat(1024 * 1024) });
    }

    const fs = yield* FileSystem.FileSystem;
    const directory = InstanceDirectory.make(
      yield* fs.makeTempDirectoryScoped({
        directory: sqliteTempDirectory(),
        prefix: "usine-statement-retention-",
      }),
    );
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
            yield* Effect.promise(() => Effect.runPromise(request));
          }
        }
      }
      // Allow promise and async context cleanup between full collections, with the cache open.
      yield* Effect.promise(() => setImmediate());
      queryObjects(ResponsePayload, { format: "count" });
      yield* Effect.promise(() => setImmediate());
      assert.strictEqual(queryObjects(ResponsePayload, { format: "count" }), 0);
      assert.deepStrictEqual(yield* sql`SELECT 42 AS value`, [{ value: 42 }]);
      if (hour < 6) yield* TestClock.adjust("1 hour");
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("SQLite queries keep their request trace and SQL attributes", () =>
  Effect.gen(function* () {
    const spans: Array<{
      readonly name: string;
      readonly traceId: string;
      readonly spanId: string;
      readonly parentId: Option.Option<string>;
      readonly attributes: ReadonlyMap<string, unknown>;
    }> = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        spans.push({
          name: span.name,
          traceId: span.traceId,
          spanId: span.spanId,
          parentId: Option.map(span.parent, (parent) => parent.spanId),
          attributes: span.attributes,
        });
        return span;
      },
    });
    const fs = yield* FileSystem.FileSystem;
    const directory = InstanceDirectory.make(
      yield* fs.makeTempDirectoryScoped({
        directory: sqliteTempDirectory(),
        prefix: "usine-statement-trace-",
      }),
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(yield* sql`SELECT 42 AS value`, [{ value: 42 }]);
    }).pipe(
      Effect.withSpan("http.request"),
      Effect.provideService(Statement.SpanPropagationEnabled, true),
      Effect.provide(localSqliteLayer(directory)),
      Effect.provideService(Tracer.Tracer, tracer),
    );
    const request = spans.find(({ name }) => name === "http.request");
    assert(request !== undefined);
    const query = spans.find(
      ({ attributes }) => attributes.get("db.query.text") === "SELECT 42 AS value",
    );
    assert(query !== undefined);
    assert.strictEqual(query.traceId, request.traceId);
    assert.deepStrictEqual(query.parentId, Option.some(request.spanId));
    assert.strictEqual(query.attributes.get("db.system.name"), "sqlite");
  }).pipe(Effect.provide(NodeServices.layer)),
);
