import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { AttemptId } from "@usine/core/attempt";
import { DedupKey } from "@usine/core/event";
import { InstanceDirectory } from "@usine/core/instance";
import { ItemKey } from "@usine/core/item";
import { RunId } from "@usine/core/run";
import { EffectLogger } from "drizzle-orm/effect-core";
import * as SQLiteDrizzle from "drizzle-orm/effect-sqlite-node";
import { Config, Context, DateTime, Effect, FileSystem, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { sqliteTempDirectory } from "../../../../../tooling/test/sqlite.mts";
import { RunDatabase } from "../../../src/database/database.ts";
import { localSqliteLayer } from "../../../src/database/local-sqlite.ts";
import { RunReader } from "../../../src/run-reader/run-reader.ts";
import { RunStore } from "../../../src/store/store.ts";
import {
  TranscriptPageQuery,
  TranscriptSessionsQuery,
  TranscriptUsageQuery,
  TranscriptWorkerQuery,
} from "../../../src/transcript.ts";
import { queriesFor } from "../../../src/store/queries.ts";
import { lifecycleSubmission } from "../support.ts";
import { seedReadFixture } from "./fixture.ts";

it.live(
  "hot non-transcript runtime reads search indexes on a history-sized store",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const savedDirectory = yield* Config.String("USINE_STORE_BENCHMARK_DIRECTORY").pipe(
        Config.option,
      );
      const reportPath = yield* Config.String("USINE_STORE_BENCHMARK_REPORT").pipe(Config.option);
      const directory = InstanceDirectory.make(
        Option.isSome(savedDirectory)
          ? savedDirectory.value
          : yield* fs.makeTempDirectoryScoped({
              directory: sqliteTempDirectory(),
              prefix: "usine-read-plans-",
            }),
      );
      const exists = yield* fs.exists(`${directory}/.usine/runtime.sqlite`);
      const startup = performance.now();
      const context = yield* Layer.build(localSqliteLayer(directory));
      const migrationMillis = performance.now() - startup;
      const client = Context.get(context, SqlClient.SqlClient);
      if (!exists)
        yield* seedReadFixture(Option.isSome(savedDirectory) ? 3000 : 20).pipe(
          Effect.provideContext(context),
        );
      const statements: Array<{ reader: string; sql: string; params: ReadonlyArray<unknown> }> = [];
      const readerTimes: Array<{ reader: string; millis: number }> = [];
      let currentReader = "";
      const logger = Layer.succeed(EffectLogger)({
        logQuery: (sql, params) =>
          Effect.sync(() => {
            if (/^select\b/iu.test(sql)) statements.push({ reader: currentReader, sql, params });
          }),
      });
      const database = yield* SQLiteDrizzle.make().pipe(
        Effect.provide(logger),
        Effect.provide(SQLiteDrizzle.DefaultServices),
        Effect.provideContext(context),
      );
      yield* Effect.gen(function* () {
        const reader = yield* RunReader;
        const store = yield* RunStore;
        const query = queriesFor(database);
        const runId = RunId.make("run-0");
        const itemKey = ItemKey.make("item-0");
        const attemptId = AttemptId.make("attempt-0");
        const capture = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
          Effect.gen(function* () {
            currentReader = name;
            const start = performance.now();
            const value = yield* effect;
            readerTimes.push({ reader: name, millis: performance.now() - start });
            return value;
          });
        yield* capture("overview/desk open runs", reader.list({ closedLimit: 0 }));
        yield* capture("overview recent history", reader.list({ closedLimit: 50 }));
        yield* capture("desk recently closed", reader.closed({ limit: 20 }));
        yield* capture(
          "desk project closed",
          reader.closed({ limit: 20, repositories: [lifecycleSubmission.repository] }),
        );
        yield* capture(
          "statistics window",
          reader.closedSince(Option.some(DateTime.makeUnsafe("2026-11-01T00:10:00.000Z"))),
        );
        yield* capture("statistics all history", reader.closedSince(Option.none()));
        const board = yield* capture(
          "board history/current runs",
          reader.board(
            Array.from({ length: 100 }, (_, i) => ItemKey.make(`item-${i}`)),
            [],
          ),
        );
        assert(board.runs.some(({ run }) => run.id === "run-888"));
        yield* capture("task history", reader.forItems([itemKey]));
        yield* capture("run detail", reader.inspect(runId));
        yield* capture("run summary", reader.summary(runId));
        yield* capture("run events", reader.events([runId]));
        if (Option.isSome(reportPath)) {
          yield* capture(
            "run transcript page",
            reader.transcript(
              new TranscriptPageQuery({ attemptId, before: Option.none(), limit: 50 }),
            ),
          );
          yield* capture(
            "run session state",
            reader.transcript(new TranscriptSessionsQuery({ attemptId })),
          );
          yield* capture(
            "run worker state",
            reader.transcript(new TranscriptWorkerQuery({ attemptId })),
          );
          yield* capture(
            "usage per attempt",
            reader.transcript(new TranscriptUsageQuery({ attemptId })),
          );
          yield* capture(
            "usage across all runs",
            Effect.forEach(
              Array.from({ length: 1000 }, (_, i) => AttemptId.make(`attempt-${i}`)),
              (attemptId) => reader.transcript(new TranscriptUsageQuery({ attemptId })),
              { discard: true },
            ),
          );
          yield* capture("usage pool limits", reader.latestPoolRateLimits());
        }
        yield* capture("CI wait reconciliation", store.awaitingCi());
        yield* capture("polling admitted event", reader.runForEvent(DedupKey.make("dedup-0")));
        yield* capture(
          "polling blocking run",
          query.blockingRun(lifecycleSubmission.loop, itemKey),
        );
        yield* capture("polling next queued", query.nextQueued(runId));
        yield* capture("reconciliation runs to drive", query.runIdsToDrive());
      }).pipe(
        Effect.provide(Layer.merge(RunReader.layer, RunStore.layer)),
        Effect.provide(RunDatabase.layer(database)),
      );
      const unique = [
        ...new Map(
          statements.map((statement) => [`${statement.reader}:${statement.sql}`, statement]),
        ).values(),
      ];
      const measurements = yield* Effect.forEach(unique, (statement) =>
        Effect.gen(function* () {
          const plan = (yield* client.unsafe<{ detail: string }>(
            `EXPLAIN QUERY PLAN ${statement.sql}`,
            statement.params,
          )).map(({ detail }) => detail);
          const samples: Array<number> = [];
          let rows = 0;
          for (let repeat = 0; repeat < 5; repeat++) {
            const start = performance.now();
            rows = (yield* client.unsafe(statement.sql, statement.params)).length;
            samples.push(performance.now() - start);
          }
          samples.sort((a, b) => a - b);
          return { ...statement, plan, rows, medianMillis: samples[2] };
        }),
      );
      yield* client`PRAGMA wal_checkpoint(TRUNCATE)`;
      const size = yield* fs.stat(`${directory}/.usine/runtime.sqlite`);
      if (Option.isSome(reportPath))
        yield* fs.writeFileString(
          reportPath.value,
          JSON.stringify(
            { bytes: Number(size.size), migrationMillis, readerTimes, queries: measurements },
            null,
            2,
          ) + "\n",
        );
      for (const { reader, sql, plan } of measurements) {
        if (/usine_attempt_transcripts/iu.test(sql)) continue;
        for (const detail of plan)
          assert.notMatch(
            detail,
            /\bSCAN usine_(?!attempt_transcripts\b)\w+\b/iu,
            `${reader}: ${detail}\n${sql}`,
          );
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  120_000,
);
