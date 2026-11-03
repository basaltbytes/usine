import { sqliteTempDirectory } from "../../../../tooling/test/sqlite.mts";
import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { assert, it } from "@effect/vitest";
import { CycleLimit } from "@usine/core/cycle-budget";
import { AgentFailure } from "@usine/core/attempt/failure";
import { AttemptTask } from "@usine/core/attempt";
import { DedupKey, Event, EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { InstanceDirectory } from "@usine/core/instance";
import { RunId } from "@usine/core/run";
import { Comment, PullRequest, StepResult } from "@usine/core/step/result";
import { WorkerName } from "@usine/core/worker";
import { EffectLogger } from "drizzle-orm/effect-core";
import * as SQLiteDrizzle from "drizzle-orm/effect-sqlite-node";
import { DateTime, Effect, FileSystem, Layer, Option, Result } from "effect";
import { Reactivity } from "effect/reactivity";
import { TestClock } from "effect/testing";
import { RunDatabase } from "../../src/database/database.ts";
import { localSqliteLayer } from "../../src/database/local-sqlite.ts";
import { withReadWorker } from "../../src/database/sqlite-reader/reader.ts";
import { Submission } from "../../src/engine/submission.ts";
import { RunReader } from "../../src/run-reader/run-reader.ts";
import { RunStore } from "../../src/store/store.ts";
import { lifecycleSubmission } from "./support.ts";

for (const [phase, selection] of [
  ["closed runs", /"closed_at" is not null/u],
  ["attempts", /from "usine_attempts"/u],
] as const) {
  it.live(`run lists stay coherent when completion commits before reading ${phase}`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fs.makeTempDirectoryScoped({ directory: sqliteTempDirectory() }),
      );
      yield* Effect.gen(function* () {
        const store = yield* RunStore;
        const runId = RunId.make("completing-during-list");
        yield* store.recordAndClaim(lifecycleSubmission, runId);
        const started = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
        assert(started._tag === "AttemptStarted");
        // A read-only transaction lets the other connection commit between SELECTs.
        const connection = yield* SqliteClient.make({
          filename: `${directory}/.usine/runtime.sqlite`,
          readonly: true,
        });
        const routed = yield* withReadWorker(connection);
        let completed = false;
        const logger = Layer.succeed(EffectLogger)({
          logQuery: (query) =>
            Effect.gen(function* () {
              if (completed || !selection.test(query)) return;
              yield* store.finishAttempt(
                started.execution.attempt,
                Result.succeed(new StepResult({ message: "Completed during listing", facts: [] })),
              );
              completed = true;
            }).pipe(Effect.orDie),
        });
        const database = yield* SQLiteDrizzle.make().pipe(
          Effect.provide(logger),
          Effect.provide(SQLiteDrizzle.DefaultServices),
          Effect.provideService(SqliteClient.SqliteClient, routed.client),
        );
        yield* Effect.gen(function* () {
          const reader = yield* RunReader;
          const listed = yield* reader.list({ closedLimit: 10 });
          assert(completed, "completion must commit between list queries");
          assert.strictEqual(listed.length, 1);
          const summary = listed[0];
          assert(summary !== undefined);
          assert.strictEqual(summary.run.id, runId);
          assert.strictEqual(summary.run.state._tag, "Running");
          assert.strictEqual(summary.attempts.length, 1);
          const attempt = summary.attempts[0];
          assert(attempt !== undefined);
          assert(Option.isNone(attempt.outcome));
          assert(Option.isNone(attempt.endedAt));
          const after = yield* reader.list({ closedLimit: 10 });
          assert.strictEqual(after.length, 1);
          const finished = after[0];
          assert(finished !== undefined);
          assert.strictEqual(finished.run.id, runId);
          assert.strictEqual(finished.run.state._tag, "Succeeded");
          const finishedAttempt = finished.attempts[0];
          assert(finishedAttempt !== undefined);
          assert.strictEqual(Option.getOrNull(finishedAttempt.outcome)?._tag, "Succeeded");
          assert(Option.isSome(finishedAttempt.endedAt));
        }).pipe(Effect.provide(RunReader.layer), Effect.provide(RunDatabase.layer(database)));
      }).pipe(Effect.provide(RunStore.layer), Effect.provide(localSqliteLayer(directory)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.provide(Reactivity.layer)),
  );
}

it.effect(
  "polling SQL excludes long text and selects recent and current runs before decoding",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fs.makeTempDirectoryScoped({
          directory: sqliteTempDirectory(),
          prefix: "usine-summary-",
        }),
      );
      yield* Effect.gen(function* () {
        const store = yield* RunStore;
        const task = AttemptTask.make("Saved prompt. ".repeat(10_000));
        const message = "Saved result. ".repeat(10_000);
        const comment = new Comment({
          url: new URL("https://github.com/basaltbytes/usine/issues/1#issuecomment-1"),
          kind: "issue-comment",
          at: Option.none(),
        });
        const pullRequest = new PullRequest({
          number: 2,
          url: new URL("https://github.com/basaltbytes/usine/pull/2"),
        });
        const laterPullRequest = new PullRequest({
          number: 3,
          url: new URL("https://github.com/basaltbytes/usine/pull/3"),
        });
        const ids: Array<RunId> = [];
        for (let index = 0; index < 5; index++) {
          const runId = RunId.make(`summary-${index}`);
          ids.push(runId);
          const submission = new Submission({
            ...lifecycleSubmission,
            task,
            loop: LoopName.make(index === 0 ? "plan" : "implement"),
            cycleLimit: Option.some(CycleLimit.make(10)),
            event: new Event({
              ...lifecycleSubmission.event,
              id: EventId.make(runId),
              dedupKey: DedupKey.make(runId),
            }),
          });
          const claim = yield* store.recordAndClaim(submission, runId);
          assert.strictEqual(claim.result._tag, "Claimed");
          const started = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
          assert(started._tag === "AttemptStarted");
          yield* store.recordComments(started.execution.attempt.id, [comment]);
          yield* TestClock.adjust("1 second");
          if (index < 4)
            yield* store.finishAttempt(
              started.execution.attempt,
              index === 1 || index === 2
                ? Result.fail(new AgentFailure({ message: "Unresolved earlier failure" }))
                : Result.succeed(
                    new StepResult({
                      message,
                      facts: index === 0 ? [pullRequest, laterPullRequest, comment] : [],
                    }),
                  ),
            );
          if (index === 2)
            yield* store.resolveFailure(runId, started.execution.attempt.id, Option.none());
        }
        const statements: Array<string> = [];
        const parameterCounts: Array<number> = [];
        const logger = Layer.succeed(EffectLogger)({
          logQuery: (query, params) =>
            Effect.sync(() => {
              statements.push(query);
              parameterCounts.push(params.length);
            }),
        });
        const database = yield* SQLiteDrizzle.make().pipe(
          Effect.provide(logger),
          Effect.provide(SQLiteDrizzle.DefaultServices),
        );
        yield* Effect.gen(function* () {
          const reader = yield* RunReader;
          const itemKey = lifecycleSubmission.itemKey;
          const recent = yield* reader.list({ closedLimit: 2 });
          assert.deepStrictEqual(
            recent.map(({ run }) => run.id),
            ids.slice(2).reverse(),
          );
          assert.deepStrictEqual(
            (yield* reader.closed({ limit: 1 })).map(({ run }) => run.id),
            [ids[3]],
          );
          yield* reader.closedSince(Option.some(DateTime.makeUnsafe("2026-01-01T00:00:00Z")));
          const history = yield* reader.forItems([itemKey]);
          assert.strictEqual(history.length, 5);
          assert.strictEqual(history.at(-1)?.pullRequestUrl, pullRequest.url.toString());
          const board = yield* reader.board([itemKey], []);
          assert.deepStrictEqual(
            board.runs.map(({ run }) => run.id),
            [ids[4], ids[1]],
          );
          assert.strictEqual(board.items[0]?.runCount, 5);
          assert.strictEqual(board.items[0]?.attemptCount, 5);
          assert.strictEqual(board.items[0]?.durationMillis, 4000);
          assert.deepStrictEqual(board.items[0]?.pullRequestUrls, [pullRequest.url.toString()]);
          assert.strictEqual(
            board.items[0]?.loops.find(({ loop }) => loop === "implement")?.state._tag,
            "Running",
          );
          assert.strictEqual(
            board.items[0]?.loops.find(({ loop }) => loop === "plan")?.state._tag,
            "Succeeded",
          );
          assert.strictEqual(board.items[0]?.runningSince.length, 1);
          const firstId = ids[0];
          assert(firstId !== undefined);
          yield* reader.summary(firstId);
          assert.deepStrictEqual(
            (yield* reader.board([itemKey], [firstId])).runs.map(({ run }) => run.id),
            [ids[4], ids[1], firstId],
          );
          yield* reader.board(
            [itemKey, ...Array.from({ length: 101 }, (_, i) => ItemKey.make(`missing-item-${i}`))],
            Array.from({ length: 101 }, (_, i) => RunId.make(`missing-stop-${i}`)),
          );
          assert.isAtMost(Math.max(...parameterCounts), 100);
          const empty = yield* reader.board([], []);
          assert.deepStrictEqual([empty.runs, empty.items], [[], []]);
          for (const query of statements) {
            assert.notMatch(query, /[".]task"|comments_?json"/iu, query);
            // JSON expressions may read a result's PR URL, but never return the result column.
            assert.notMatch(query, /(?:select|,)\s*(?:"[^"]+"\.)?"result"\s*(?:,|from)/iu, query);
          }
          assert(statements.some((query) => /row_number\(\) over/iu.test(query)));
          assert(statements.some((query) => /limit \?/iu.test(query)));
          for (const run of history) {
            assert.notProperty(run, "task");
            assert.notProperty(run, "step");
            assert.notProperty(run.agent, "persona");
            for (const attempt of run.attempts) {
              assert.notProperty(attempt, "task");
              assert.notProperty(attempt, "comments");
            }
          }
          statements.length = 0;
          const detail = yield* reader.inspect(firstId);
          assert.strictEqual(detail.task, task);
          assert.strictEqual(detail.attempts[0]?.task, task);
          assert.deepStrictEqual(detail.attempts[0]?.comments, [comment]);
          assert.strictEqual(Option.getOrNull(detail.step.result)?.message, message);
          assert(statements.some((query) => /"task"/u.test(query)));
        }).pipe(Effect.provide(RunReader.layer), Effect.provide(RunDatabase.layer(database)));
      }).pipe(Effect.provide(RunStore.layer), Effect.provide(localSqliteLayer(directory)));
    }).pipe(Effect.provide(NodeServices.layer)),
);
