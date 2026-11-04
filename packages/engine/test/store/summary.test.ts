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
import { ReadSnapshot, RunDatabase } from "../../src/database/database.ts";
import { localSqliteLayer } from "../../src/database/local-sqlite.ts";
import { withReadWorker } from "../../src/database/sqlite-reader/reader.ts";
import { Submission } from "../../src/engine/submission.ts";
import { RunReader } from "../../src/run-reader/run-reader.ts";
import { RunStore } from "../../src/store/store.ts";
import { lifecycleSubmission } from "./support.ts";

for (const [method, phase, selection, transition] of [
  ["list", "closed runs", /"closed_at" is not null/u, "completion"],
  ["list", "attempts", /from "usine_attempts"/u, "completion"],
  ["inspect", "attempts", /from "usine_attempts"/u, "completion"],
  ["evidence", "attempts", /from "usine_attempts"/u, "completion"],
  ["summary", "attempts", /from "usine_attempts"/u, "completion"],
  ["forItems", "attempts", /from "usine_attempts"/u, "completion"],
  ["board", "loop history", /"board_loop_history"/u, "completion"],
  ["board", "current runs", /from "usine_attempts"/u, "completion"],
  ["closed", "attempts", /from "usine_attempts"/u, "retry"],
  ["closedSince", "attempts", /from "usine_attempts"/u, "retry"],
] as const) {
  it.live(`${method} stays coherent when ${transition} commits before reading ${phase}`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const currentDirectory = yield* fs.makeTempDirectoryScoped({
        directory: sqliteTempDirectory(),
      });
      const directory = InstanceDirectory.make(currentDirectory);
      yield* Effect.gen(function* () {
        const store = yield* RunStore;
        const runId = RunId.make("changing-during-summary");
        yield* store.recordAndClaim(lifecycleSubmission, runId);
        const started = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
        assert(started._tag === "AttemptStarted");
        if (transition === "retry") {
          yield* store.finishAttempt(
            started.execution.attempt,
            Result.fail(AgentFailure.make({ message: "Retry during summary read" })),
          );
        }
        // The worker snapshot lets the other connection commit between SELECTs.
        const connection = yield* SqliteClient.make({
          filename: `${directory}/.usine/runtime.sqlite`,
        });
        const routed = yield* withReadWorker(connection);
        let changed = false;
        const logger = Layer.succeed(EffectLogger)({
          logQuery: (query) =>
            Effect.gen(function* () {
              if (changed || !selection.test(query)) return;
              if (transition === "completion") {
                yield* store.finishAttempt(
                  started.execution.attempt,
                  Result.succeed(
                    StepResult.make({ message: "Completed during summary read", facts: [] }),
                  ),
                );
              } else {
                const retryResult = yield* store.retry(runId);
                assert(retryResult);
                const retried = yield* store.beginAttempt(
                  runId,
                  WorkerName.make("local"),
                  Option.none(),
                );
                assert(retried._tag === "AttemptStarted");
              }
              changed = true;
            }).pipe(Effect.orDie),
        });
        const database = yield* SQLiteDrizzle.make().pipe(
          Effect.provide(logger.pipe(Layer.provideMerge(SQLiteDrizzle.DefaultServices))),
          Effect.provideService(SqliteClient.SqliteClient, routed.client),
        );
        yield* Effect.gen(function* () {
          const reader = yield* RunReader;
          const read = () => {
            switch (method) {
              case "list":
                return reader.list({ closedLimit: 10 });
              case "inspect":
                return reader.inspect(runId).pipe(Effect.map((snapshot) => [snapshot]));
              case "evidence":
                return reader.evidence(runId).pipe(Effect.map(({ snapshot }) => [snapshot]));
              case "summary":
                return reader.summary(runId).pipe(Effect.map((summary) => [summary]));
              case "forItems":
                return reader.forItems([lifecycleSubmission.itemKey]);
              case "board":
                return reader.board([lifecycleSubmission.itemKey], []).pipe(
                  Effect.map((history) => {
                    const item = history.items[0];
                    const run = history.runs[0];
                    assert(item !== undefined && run !== undefined);
                    assert.strictEqual(item.loops[0]?.state._tag, run.run.state._tag);
                    assert.strictEqual(item.attemptCount, run.attempts.length);
                    assert.strictEqual(
                      item.runningSince.length,
                      run.attempts.filter(({ endedAt }) => Option.isNone(endedAt)).length,
                    );
                    assert.strictEqual(
                      item.usageSources[0]?.attempts[0]?.ended,
                      Option.isSome(run.attempts[0]?.outcome ?? Option.none()),
                    );
                    return history.runs;
                  }),
                );
              case "closed":
                return reader.closed({ limit: 10 });
              case "closedSince":
                return reader.closedSince(Option.none());
            }
          };
          const listed = yield* read();
          assert(changed, "lifecycle change must commit between summary queries");
          assert.strictEqual(listed.length, 1);
          const summary = listed[0];
          assert(summary !== undefined);
          assert.strictEqual(summary.run.id, runId);
          assert.strictEqual(
            summary.run.state._tag,
            transition === "completion" ? "Running" : "Failed",
          );
          assert.strictEqual(summary.attempts.length, 1);
          const attempt = summary.attempts[0];
          assert(attempt !== undefined);
          assert.strictEqual(Option.isSome(attempt.outcome), transition === "retry");
          assert.strictEqual(Option.isSome(attempt.endedAt), transition === "retry");
          const after = yield* reader.forItems([lifecycleSubmission.itemKey]);
          assert.strictEqual(after.length, 1);
          const finished = after[0];
          assert(finished !== undefined);
          assert.strictEqual(finished.run.id, runId);
          assert.strictEqual(
            finished.run.state._tag,
            transition === "completion" ? "Succeeded" : "Running",
          );
          assert.strictEqual(finished.attempts.length, transition === "completion" ? 1 : 2);
          const finishedAttempt = finished.attempts[0];
          assert(finishedAttempt !== undefined);
          assert.strictEqual(
            Option.getOrNull(finishedAttempt.outcome)?._tag,
            transition === "completion" ? "Succeeded" : "Failed",
          );
          assert(Option.isSome(finishedAttempt.endedAt));
        }).pipe(
          Effect.provide(RunReader.layer.pipe(Layer.provideMerge(RunDatabase.layer(database)))),
          Effect.provideService(ReadSnapshot, {
            run: (_database, effect) => routed.readSnapshot(effect),
          }),
        );
      }).pipe(Effect.provide(RunStore.layer.pipe(Layer.provideMerge(localSqliteLayer(directory)))));
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer.pipe(Layer.provideMerge(Reactivity.layer))),
    ),
  );
}

it.effect(
  "polling SQL excludes long text and selects recent and current runs before decoding",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const currentDirectory = yield* fs.makeTempDirectoryScoped({
        directory: sqliteTempDirectory(),
        prefix: "usine-summary-",
      });
      const directory = InstanceDirectory.make(currentDirectory);
      yield* Effect.gen(function* () {
        const store = yield* RunStore;
        const task = AttemptTask.make("Saved prompt. ".repeat(10_000));
        const message = "Saved result. ".repeat(10_000);
        const comment = Comment.make({
          url: new URL("https://github.com/basaltbytes/usine/issues/1#issuecomment-1"),
          kind: "issue-comment",
          at: Option.none(),
        });
        const pullRequest = PullRequest.make({
          number: 2,
          url: new URL("https://github.com/basaltbytes/usine/pull/2"),
        });
        const laterPullRequest = PullRequest.make({
          number: 3,
          url: new URL("https://github.com/basaltbytes/usine/pull/3"),
        });
        const ids: Array<RunId> = [];
        for (let index = 0; index < 5; index++) {
          const runId = RunId.make(`summary-${index}`);
          ids.push(runId);
          const submission = Submission.make({
            ...lifecycleSubmission,
            task,
            loop: LoopName.make(index === 0 ? "plan" : "implement"),
            cycleLimit: Option.some(CycleLimit.make(10)),
            event: Event.make({
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
                ? Result.fail(AgentFailure.make({ message: "Unresolved earlier failure" }))
                : Result.succeed(
                    StepResult.make({
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
          Effect.provide(logger.pipe(Layer.provideMerge(SQLiteDrizzle.DefaultServices))),
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
        }).pipe(
          Effect.provide(RunReader.layer.pipe(Layer.provideMerge(RunDatabase.layer(database)))),
        );
      }).pipe(Effect.provide(RunStore.layer.pipe(Layer.provideMerge(localSqliteLayer(directory)))));
    }).pipe(Effect.provide(NodeServices.layer)),
);
