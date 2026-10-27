import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { UsineConfig } from "@usine/config/factory";
import { LoadedInstance } from "@usine/config/instance";
import { Agent } from "@usine/core/agent";
import { InstanceDirectory } from "@usine/core/instance";
import * as RunState from "@usine/core/run/state";
import { EnginePersistenceError } from "@usine/engine/engine";
import { localSqliteLayer } from "@usine/engine/local-sqlite";
import { ProjectionRevision, RunReader } from "@usine/engine/run-reader";
import { DateTime, Deferred, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { cacheStatistics } from "../../src/operator/statistics/cache.ts";
import { submission } from "../local-worker/support.ts";

const instance = new LoadedInstance({
  config: Schema.decodeUnknownSync(UsineConfig)({
    version: 1,
    repos: [],
    workers: [{ name: "local", kind: "local", max_concurrent_attempts: 1 }],
  }),
  agents: [],
  invalidAgents: [],
  loops: [],
  quarantinedLoops: [],
  warnings: [],
});
const revision = () => Effect.succeed(Option.some(ProjectionRevision.make(0)));

describe("Statistics cache", () => {
  it.effect(
    "shares concurrent reads and keeps each window until five minutes after computation",
    () =>
      Effect.gen(function* () {
        let reads = 0;
        const cached = cacheStatistics(revision, () =>
          Effect.gen(function* () {
            reads += 1;
            yield* Effect.yieldNow;
            return reads;
          }),
        );
        assert.deepStrictEqual(
          yield* Effect.all([cached(instance, "7d"), cached(instance, "7d")], {
            concurrency: "unbounded",
          }),
          [1, 1],
        );
        assert.strictEqual(yield* cached(instance, "30d"), 2);
        assert.strictEqual(yield* cached(instance, "all"), 3);
        yield* TestClock.adjust("4 minutes");
        assert.strictEqual(yield* cached(instance, "7d"), 1);
        assert.strictEqual(yield* cached(instance, "30d"), 2);
        assert.strictEqual(yield* cached(instance, "all"), 3);
        yield* TestClock.adjust("1 minute");
        assert.strictEqual(yield* cached(instance, "7d"), 4);
        yield* TestClock.adjust(1);
        assert.strictEqual(yield* cached(instance, "30d"), 5);
        assert.strictEqual(yield* cached(instance, "all"), 6);
      }),
  );

  it.effect("recomputes after an instance reload and bypasses a missing revision", () =>
    Effect.gen(function* () {
      let current = Option.some(ProjectionRevision.make(0));
      let reads = 0;
      const cached = cacheStatistics(
        () => Effect.sync(() => current),
        () => Effect.sync(() => ++reads),
      );
      assert.strictEqual(yield* cached(instance, "7d"), 1);
      const reloaded = new LoadedInstance({ ...instance });
      assert.strictEqual(yield* cached(reloaded, "7d"), 2);
      current = Option.none();
      assert.strictEqual(yield* cached(reloaded, "7d"), 3);
      assert.strictEqual(yield* cached(reloaded, "7d"), 4);
      current = Option.some(ProjectionRevision.make(0));
      assert.strictEqual(yield* cached(reloaded, "7d"), 5);
      assert.strictEqual(yield* cached(reloaded, "7d"), 5);
    }),
  );

  it.effect("retries a failed computation instead of caching the error", () =>
    Effect.gen(function* () {
      const failure = new EnginePersistenceError({
        operation: "read statistics",
        cause: "unavailable",
      });
      let reads = 0;
      const cached = cacheStatistics(revision, () =>
        Effect.gen(function* () {
          reads += 1;
          if (reads === 1) return yield* failure;
          return reads;
        }),
      );
      assert.deepStrictEqual(yield* Effect.flip(cached(instance, "7d")), failure);
      assert.strictEqual(yield* cached(instance, "7d"), 2);
      assert.strictEqual(yield* cached(instance, "7d"), 2);
    }),
  );

  it.effect("does not reuse a view computed while the store revision changed", () =>
    Effect.gen(function* () {
      let current = 0;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let reads = 0;
      const cached = cacheStatistics(
        () => Effect.sync(() => Option.some(ProjectionRevision.make(current))),
        () =>
          Effect.gen(function* () {
            reads += 1;
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return reads;
          }),
      );
      yield* Effect.all(
        [
          cached(instance, "7d"),
          Effect.gen(function* () {
            yield* Deferred.await(started);
            current += 1;
            yield* Deferred.succeed(release, undefined);
          }),
        ],
        { concurrency: "unbounded" },
      );
      assert.strictEqual(yield* cached(instance, "7d"), 2);
      assert.strictEqual(yield* cached(instance, "7d"), 2);
    }),
  );

  it.effect("invalidates every window when a stored run closes or its close time changes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fs.makeTempDirectoryScoped({ prefix: "usine-statistics-cache-" }),
      );
      const database = localSqliteLayer(directory);
      const services = RunReader.layer.pipe(Layer.provideMerge(database));
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const reader = yield* RunReader;
        const input = submission(1);
        const agent = JSON.stringify(Schema.encodeSync(Agent)(input.agent));
        yield* sql`INSERT INTO usine_events (event_id, dedup_key, payload_json, received_at)
          VALUES (${input.event.id}, ${input.event.dedupKey}, '{}', '2026-10-25T00:00:00.000Z')`;
        yield* sql`INSERT INTO usine_trigger_events (event_id, item_key, loop_name, step_name, approval, repository, revision, task, agent_json)
          VALUES (${input.event.id}, ${input.itemKey}, ${input.loop}, ${input.step}, 'none', ${input.repository}, ${input.revision}, ${input.task}, ${agent})`;
        const pending = JSON.stringify(
          Schema.encodeSync(RunState.RunState)(new RunState.Pending()),
        );
        yield* sql`INSERT INTO usine_runs (run_id, event_id, loop_name, state_json, opened_at, repository, revision, task, agent_json)
          VALUES ('cached-run', ${input.event.id}, ${input.loop}, ${pending}, '2026-10-25T00:00:00.000Z', ${input.repository}, ${input.revision}, ${input.task}, ${agent})`;
        yield* sql`INSERT INTO usine_steps (run_id, step_name) VALUES ('cached-run', ${input.step})`;
        let reads = 0;
        const cached = cacheStatistics(reader.revision, () =>
          reader.closedSince(Option.none()).pipe(Effect.tap(() => Effect.sync(() => (reads += 1)))),
        );
        for (const window of ["7d", "30d", "all"] as const) {
          assert.isEmpty(yield* cached(instance, window));
          assert.isEmpty(yield* cached(instance, window));
        }
        assert.strictEqual(reads, 3);
        const failed = JSON.stringify(Schema.encodeSync(RunState.RunState)(new RunState.Failed()));
        yield* sql`UPDATE usine_runs SET state_json = ${failed}, closed_at = '2026-10-25T01:00:00.000Z' WHERE run_id = 'cached-run'`;
        for (const window of ["7d", "30d", "all"] as const) {
          assert.lengthOf(yield* cached(instance, window), 1);
          assert.lengthOf(yield* cached(instance, window), 1);
        }
        assert.strictEqual(reads, 6);
        yield* sql`UPDATE usine_runs SET closed_at = '2026-10-25T02:00:00.000Z' WHERE run_id = 'cached-run'`;
        for (const window of ["7d", "30d", "all"] as const) {
          const [closed] = yield* cached(instance, window);
          assert.deepStrictEqual(
            closed?.closedAt,
            Option.some(DateTime.makeUnsafe("2026-10-25T02:00:00.000Z")),
          );
        }
        assert.strictEqual(reads, 9);
        yield* sql`UPDATE usine_runs SET state_json = ${pending}, closed_at = NULL WHERE run_id = 'cached-run'`;
        assert.isEmpty(yield* cached(instance, "7d"));
        yield* sql`UPDATE usine_runs SET state_json = ${failed}, closed_at = '2026-10-25T03:00:00.000Z' WHERE run_id = 'cached-run'`;
        const [retried] = yield* cached(instance, "7d");
        assert.deepStrictEqual(
          retried?.closedAt,
          Option.some(DateTime.makeUnsafe("2026-10-25T03:00:00.000Z")),
        );
        assert.strictEqual(reads, 11);
      }).pipe(Effect.provide(services));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
