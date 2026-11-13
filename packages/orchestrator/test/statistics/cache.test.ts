import { jsonKey } from "@usine/core/json-key";
import { CompletionCheck } from "@usine/engine/completion-check";
import { WorkerStatus } from "../../src/worker-status.ts";
import { sqliteTempDirectory } from "../../../../tooling/test/sqlite.mts";
import { configurationLayer } from "../support/configuration.ts";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { UsineConfig } from "@usine/config/factory";
import { LoadedInstance } from "@usine/config/instance";
import { Agent } from "@usine/core/agent";
import { AgentFailure } from "@usine/core/attempt/failure";
import { OperatorLogin } from "@usine/core/operator";
import { WorkerName } from "@usine/core/worker";
import { InstanceDirectory } from "@usine/core/instance";
import * as RunState from "@usine/core/run/state";
import { EnginePersistenceError, RunEngine } from "@usine/engine/engine";
import { localSqliteLayer, layer as localEngineLayer } from "@usine/engine/local-sqlite";
import { StepExecutor } from "@usine/engine/step-executor";
import { ProjectionRevision, RunReader } from "@usine/engine/run-reader";
import { DateTime, Deferred, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { OperatorStatistics } from "../../src/operator/statistics/statistics.ts";
import { RunUsageReader } from "../../src/operator/usage.ts";
import { alwaysHoldsLayer } from "../support/polling.ts";
import { cacheStatistics } from "../../src/operator/statistics/cache.ts";
import { submission } from "../local-worker/support.ts";

const instance = Effect.gen(function* () {
  const decodedValue1 = yield* Schema.decodeEffect(UsineConfig)({
    version: 1,
    repos: [],
    workers: [{ name: "local", kind: "local", max_concurrent_attempts: 1 }],
  });
  return LoadedInstance.make({
    config: decodedValue1,
    agents: [],
    invalidAgents: [],
    loops: [],
    quarantinedLoops: [],
    warnings: [],
  });
});
const revision = Effect.succeedSome(ProjectionRevision.make(0));

describe("Statistics cache", () => {
  it.effect(
    "shares concurrent reads and keeps each window until five minutes after computation",
    () =>
      Effect.gen(function* () {
        const fixtureInstance = yield* instance;
        let reads = 0;
        const cached = cacheStatistics(revision, () =>
          Effect.gen(function* () {
            reads += 1;
            yield* Effect.yieldNow;
            return reads;
          }),
        );
        const results = yield* Effect.all(
          [cached(fixtureInstance, "7d"), cached(fixtureInstance, "7d")],
          {
            concurrency: "unbounded",
          },
        );
        assert.deepStrictEqual(results, [1, 1]);

        const statistics = yield* cached(fixtureInstance, "30d");
        assert.strictEqual(statistics, 2);

        const currentStatistics = yield* cached(fixtureInstance, "all");
        assert.strictEqual(currentStatistics, 3);
        yield* TestClock.adjust("4 minutes");

        const nextStatistics = yield* cached(fixtureInstance, "7d");
        assert.strictEqual(nextStatistics, 1);

        const updatedStatistics = yield* cached(fixtureInstance, "30d");
        assert.strictEqual(updatedStatistics, 2);

        const latestStatistics = yield* cached(fixtureInstance, "all");
        assert.strictEqual(latestStatistics, 3);
        yield* TestClock.adjust("1 minute");

        const secondStatistics = yield* cached(fixtureInstance, "7d");
        assert.strictEqual(secondStatistics, 4);
        yield* TestClock.adjust(1);

        const thirdStatistics = yield* cached(fixtureInstance, "30d");
        assert.strictEqual(thirdStatistics, 5);

        const fourthStatistics = yield* cached(fixtureInstance, "all");
        assert.strictEqual(fourthStatistics, 6);
      }),
  );

  it.effect("recomputes after an instance reload and bypasses a missing revision", () =>
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      let current = Option.some(ProjectionRevision.make(0));
      let reads = 0;
      const cached = cacheStatistics(
        Effect.sync(() => current),
        () => Effect.sync(() => ++reads),
      );

      const statistics = yield* cached(fixtureInstance, "7d");
      assert.strictEqual(statistics, 1);
      const reloaded = LoadedInstance.make({ ...fixtureInstance });
      const currentStatistics = yield* cached(reloaded, "7d");
      assert.strictEqual(currentStatistics, 2);
      current = Option.none();
      const nextStatistics = yield* cached(reloaded, "7d");
      assert.strictEqual(nextStatistics, 3);
      const updatedStatistics = yield* cached(reloaded, "7d");
      assert.strictEqual(updatedStatistics, 4);
      current = Option.some(ProjectionRevision.make(0));
      const latestStatistics = yield* cached(reloaded, "7d");
      assert.strictEqual(latestStatistics, 5);
      const secondStatistics = yield* cached(reloaded, "7d");
      assert.strictEqual(secondStatistics, 5);
    }),
  );

  it.effect("retries a failed computation instead of caching the error", () =>
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const failure = EnginePersistenceError.make({
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

      const currentFailure = yield* Effect.flip(cached(fixtureInstance, "7d"));
      assert.deepStrictEqual(currentFailure, failure);

      const statistics = yield* cached(fixtureInstance, "7d");
      assert.strictEqual(statistics, 2);

      const currentStatistics = yield* cached(fixtureInstance, "7d");
      assert.strictEqual(currentStatistics, 2);
    }),
  );

  it.effect("does not reuse a view computed while the store revision changed", () =>
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      let current = 0;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let reads = 0;
      const cached = cacheStatistics(
        Effect.sync(() => Option.some(ProjectionRevision.make(current))),
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
          cached(fixtureInstance, "7d"),
          Effect.gen(function* () {
            yield* Deferred.await(started);
            current += 1;
            yield* Deferred.succeed(release, undefined);
          }),
        ],
        { concurrency: "unbounded" },
      );

      const statistics = yield* cached(fixtureInstance, "7d");
      assert.strictEqual(statistics, 2);

      const currentStatistics = yield* cached(fixtureInstance, "7d");
      assert.strictEqual(currentStatistics, 2);
    }),
  );

  it.effect("invalidates every window when a stored run closes or its close time changes", () =>
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const fs = yield* FileSystem.FileSystem;
      const currentDirectory = yield* fs.makeTempDirectoryScoped({
        directory: sqliteTempDirectory(),
        prefix: "usine-statistics-cache-",
      });
      const directory = InstanceDirectory.make(currentDirectory);
      const database = localSqliteLayer(directory);
      const services = RunReader.layer.pipe(Layer.provideMerge(database));
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const reader = yield* RunReader;
        const input = submission(1);
        const valueDecoded1 = yield* Schema.encodeEffect(Agent)(input.agent);
        const json1 = jsonKey(valueDecoded1);
        const agent = json1;
        yield* sql`INSERT INTO usine_events (event_id, dedup_key, payload_json, received_at)
          VALUES (${input.event.id}, ${input.event.dedupKey}, '{}', '2026-10-25T00:00:00.000Z')`;
        yield* sql`INSERT INTO usine_trigger_events (event_id, item_key, loop_name, step_name, approval, repository, revision, task, agent_json)
          VALUES (${input.event.id}, ${input.itemKey}, ${input.loop}, ${input.step}, 'none', ${input.repository}, ${input.revision}, ${input.task}, ${agent})`;
        const valueDecoded2 = yield* Schema.encodeEffect(RunState.RunState)(
          RunState.Pending.make(),
        );
        const json2 = jsonKey(valueDecoded2);
        const pending = json2;
        yield* sql`INSERT INTO usine_runs (run_id, event_id, loop_name, state_json, opened_at, repository, revision, task, agent_json)
          VALUES ('cached-run', ${input.event.id}, ${input.loop}, ${pending}, '2026-10-25T00:00:00.000Z', ${input.repository}, ${input.revision}, ${input.task}, ${agent})`;
        yield* sql`INSERT INTO usine_steps (run_id, step_name) VALUES ('cached-run', ${input.step})`;
        let reads = 0;
        const cached = cacheStatistics(reader.revision, () =>
          reader.closedSince(Option.none()).pipe(Effect.tap(() => Effect.sync(() => (reads += 1)))),
        );
        for (const window of ["7d", "30d", "all"] as const) {
          const statistics = yield* cached(fixtureInstance, window);
          assert.isEmpty(statistics);

          const currentStatistics = yield* cached(fixtureInstance, window);
          assert.isEmpty(currentStatistics);
        }
        assert.strictEqual(reads, 3);
        const valueDecoded3 = yield* Schema.encodeEffect(RunState.RunState)(RunState.Failed.make());
        const json3 = jsonKey(valueDecoded3);
        const failed = json3;
        yield* sql`UPDATE usine_runs SET state_json = ${failed}, closed_at = '2026-10-25T01:00:00.000Z' WHERE run_id = 'cached-run'`;
        for (const window of ["7d", "30d", "all"] as const) {
          const nextStatistics = yield* cached(fixtureInstance, window);
          assert.lengthOf(nextStatistics, 1);

          const updatedStatistics = yield* cached(fixtureInstance, window);
          assert.lengthOf(updatedStatistics, 1);
        }
        assert.strictEqual(reads, 6);
        yield* sql`UPDATE usine_runs SET closed_at = '2026-10-25T02:00:00.000Z' WHERE run_id = 'cached-run'`;
        for (const window of ["7d", "30d", "all"] as const) {
          const [closed] = yield* cached(fixtureInstance, window);
          assert.deepStrictEqual(
            closed?.closedAt,
            Option.some(DateTime.makeUnsafe("2026-10-25T02:00:00.000Z")),
          );
        }
        assert.strictEqual(reads, 9);
        yield* sql`UPDATE usine_runs SET state_json = ${pending}, closed_at = NULL WHERE run_id = 'cached-run'`;

        const latestStatistics = yield* cached(fixtureInstance, "7d");
        assert.isEmpty(latestStatistics);
        yield* sql`UPDATE usine_runs SET state_json = ${failed}, closed_at = '2026-10-25T03:00:00.000Z' WHERE run_id = 'cached-run'`;

        const [retried] = yield* cached(fixtureInstance, "7d");
        assert.deepStrictEqual(
          retried?.closedAt,
          Option.some(DateTime.makeUnsafe("2026-10-25T03:00:00.000Z")),
        );
        assert.strictEqual(reads, 11);
      }).pipe(Effect.provide(services));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refreshes every cached run statistics window after a failure is resolved", () =>
    Effect.gen(function* () {
      const fixtureInstance = yield* instance;
      const fs = yield* FileSystem.FileSystem;
      const currentDirectory = yield* fs.makeTempDirectoryScoped({
        directory: sqliteTempDirectory(),
        prefix: "usine-resolution-statistics-",
      });
      const directory = InstanceDirectory.make(currentDirectory);
      const worker = WorkerName.make("local");
      const executor = Layer.succeed(StepExecutor)({
        workers: Effect.succeed([worker]),
        isLive: () => Effect.succeed(false),
        outcome: () => Effect.succeedNone,
        recover: () => Effect.succeed("found" as const),
        intervene: () => Effect.void,
        interrupt: () => Effect.void,
        occupy: () => Effect.succeed({ worker, kind: "local", release: Effect.void }),
        sweep: Effect.void,
        discard: () => Effect.void,
        reserve: () => Effect.succeed({ worker, kind: "local", release: Effect.void }),
        execute: () => Effect.fail(AgentFailure.make({ message: "Needs operator input" })),
      });
      const engineLayer = localEngineLayer(directory).pipe(
        Layer.provide(executor),
        Layer.provide(alwaysHoldsLayer),
        Layer.provide(CompletionCheck.unverified),
      );
      const services = OperatorStatistics.layer.pipe(
        Layer.provide(WorkerStatus.idle),
        Layer.provide(configurationLayer),
        Layer.provide(RunUsageReader.layer),
        Layer.provideMerge(engineLayer),
      );
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-25T00:00:00Z")));
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const statistics = yield* OperatorStatistics;
        const claim = yield* engine.submit(submission(1));
        assert(claim._tag === "Claimed");
        const failed = yield* engine.inspect(claim.runId).pipe(
          Effect.tap(() => Effect.yieldNow),
          Effect.repeat({ until: ({ run }) => run.state._tag === "Failed" }),
        );
        const attempt = failed.attempts[0];
        assert(attempt !== undefined);
        yield* TestClock.adjust("15 minutes");
        const windows = ["7d", "30d", "all"] as const;
        for (const window of windows) {
          const before = yield* statistics.runStatistics(fixtureInstance, window);
          assert.strictEqual(before.needsAttention.failureWait, null);

          const currentRunStatistics = yield* statistics.runStatistics(fixtureInstance, window);
          assert.strictEqual(currentRunStatistics, before);
        }
        const operator = Option.some(OperatorLogin.make("Philippe"));
        yield* engine.resolveFailure(claim.runId, attempt.id, operator);
        for (const window of windows) {
          const after = yield* statistics.runStatistics(fixtureInstance, window);
          assert.deepStrictEqual(
            { ...after.needsAttention.failureWait },
            {
              count: 1,
              medianMillis: 15 * 60_000,
            },
          );
          assert.deepStrictEqual(
            after.needsAttention.resolutionWait,
            after.needsAttention.failureWait,
          );
          assert.strictEqual(after.needsAttention.retryWait, null);

          const nextRunStatistics = yield* statistics.runStatistics(fixtureInstance, window);
          assert.strictEqual(nextRunStatistics, after);
        }
      }).pipe(Effect.provide(services));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
