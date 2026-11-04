import { assert, describe, it } from "@effect/vitest";
import { Attempt } from "@usine/core/attempt";
import { DedupKey, Event, EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { ActingMember, OperatorLogin } from "@usine/core/operator";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import * as RunState from "@usine/core/run/state";
import { PullRequest, StepResult } from "@usine/core/step/result";
import { WorkerName } from "@usine/core/worker";
import { DateTime, Effect, Option, Result } from "effect";
import { TestClock } from "effect/testing";

import { Submission } from "../../src/engine/submission.ts";
import { RunReader } from "../../src/run-reader/run-reader.ts";
import { RunStore } from "../../src/store/store.ts";
import { lifecycleSubmission } from "../store/fixtures.ts";
import { type PersistenceAdapter, withPersistence } from "./adapter.ts";

export const runReaderContract = (adapter: PersistenceAdapter) => {
  describe(`${adapter.name} RunReader contract`, () => {
    it.live("lists the settled Runs that closed last, whenever they opened", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        yield* Effect.gen(function* () {
          const store = yield* RunStore;
          const reader = yield* RunReader;
          const claim = (name: string, repository = lifecycleSubmission.repository) => {
            const runId = RunId.make(name);
            return store
              .recordAndClaim(
                Submission.make({
                  ...lifecycleSubmission,
                  repository,
                  event: Event.make({
                    ...lifecycleSubmission.event,
                    id: EventId.make(name),
                    dedupKey: DedupKey.make(`${name}/revision`),
                  }),
                  itemKey: ItemKey.make(name),
                }),
                runId,
              )
              .pipe(
                Effect.as(runId),
                Effect.tap(() => Effect.sleep("5 millis")),
              );
          };
          const begin = (runId: RunId) =>
            store
              .beginAttempt(runId, WorkerName.make("local"), Option.none())
              .pipe(
                Effect.flatMap((started) =>
                  started._tag === "AttemptStarted"
                    ? Effect.succeed(started.execution.attempt)
                    : Effect.die(`Run ${runId} did not start`),
                ),
              );
          const finish = (attempt: Attempt) =>
            store
              .finishAttempt(
                attempt,
                Result.succeed(StepResult.make({ message: "Done", facts: [] })),
              )
              .pipe(Effect.tap(() => Effect.sleep("5 millis")));

          // The Run that opened first closes last, as a Run retried hours later does.
          const old = yield* claim("opened-first");
          const oldAttempt = yield* begin(old);
          const middle = yield* claim("opened-second");
          const middleAttempt = yield* begin(middle);
          yield* finish(middleAttempt);
          const newest = yield* claim("opened-third");
          const newestAttempt = yield* begin(newest);
          yield* finish(newestAttempt);
          yield* finish(oldAttempt);

          assert.deepStrictEqual(
            (yield* reader.closed({ limit: 2 })).map(({ run }) => run.id),
            [old, newest],
          );
          // Ordered by opening, the same window misses the Run that closed last.
          assert.deepStrictEqual(
            (yield* reader.list({ closedLimit: 2 })).map(({ run }) => run.id),
            [newest, middle],
          );
          const newestClosedAt = (yield* store.snapshot(newest)).closedAt;
          assert(Option.isSome(newestClosedAt));
          assert.deepStrictEqual(
            (yield* reader.closedSince(newestClosedAt)).map(({ run }) => run.id),
            [old, newest],
          );
          assert.deepStrictEqual(
            (yield* reader.closedSince(Option.none())).map(({ run }) => run.id),
            [old, newest, middle],
          );

          // A Run canceled before any Attempt closes at the cancel time, not at its open time.
          const waited = yield* claim("waited-for-approval");
          const meanwhileRunId = yield* claim("finished-meanwhile");
          const meanwhileAttempt = yield* begin(meanwhileRunId);
          yield* finish(meanwhileAttempt);
          yield* store
            .cancel(waited)
            .pipe(Effect.provideService(ActingMember, Option.some(OperatorLogin.make("alice"))));
          const canceled = yield* store.snapshot(waited);
          assert.deepStrictEqual(
            canceled.run.state,
            RunState.Canceled.make({
              reason: RunState.OperatorCanceled.make({
                by: Option.some(OperatorLogin.make("alice")),
              }),
            }),
          );
          assert.strictEqual(canceled.attempts.length, 0);
          assert.isTrue(
            Option.exists(
              canceled.closedAt,
              (closedAt) =>
                DateTime.toEpochMillis(closedAt) > DateTime.toEpochMillis(canceled.run.openedAt),
            ),
          );
          assert.strictEqual((yield* reader.closed({ limit: 1 }))[0]?.run.id, waited);

          const otherRepository = RepositoryName.make("acme/hidden");
          for (const name of ["hidden-first", "hidden-second", "hidden-third"]) {
            const hiddenRunId = yield* claim(name, otherRepository);
            const hiddenAttempt = yield* begin(hiddenRunId);
            yield* finish(hiddenAttempt);
          }
          const visible = yield* reader.closed({
            limit: 2,
            repositories: [RepositoryName.make(lifecycleSubmission.repository.toUpperCase())],
          });
          assert.deepStrictEqual(
            visible.map(({ run }) => run.id),
            [waited, RunId.make("finished-meanwhile")],
          );
          const runsWithoutRepositories = yield* reader.closed({ limit: 2, repositories: [] });
          assert.deepStrictEqual(runsWithoutRepositories, []);
          assert.deepStrictEqual(
            (yield* reader.closed({ limit: 2 })).map(({ run }) => run.id),
            [RunId.make("hidden-third"), RunId.make("hidden-second")],
          );
        }).pipe(Effect.provide(fixture.open));
      }).pipe(Effect.scoped),
    );
    it.effect(
      "keeps full item history while selecting current board runs and recent summaries",
      () =>
        withPersistence(
          adapter,
          Effect.gen(function* () {
            const store = yield* RunStore;
            const reader = yield* RunReader;
            const ids: RunId[] = [];
            const link = PullRequest.make({
              number: 12,
              url: new URL("https://github.com/basaltbytes/usine/pull/12"),
            });
            for (let index = 0; index < 5; index++) {
              const id = RunId.make(`history-${index}`);
              ids.push(id);
              const event = Event.make({
                ...lifecycleSubmission.event,
                id: EventId.make(id),
                dedupKey: DedupKey.make(id),
              });
              yield* store.recordAndClaim(
                Submission.make({ ...lifecycleSubmission, event, cycleLimit: Option.none() }),
                id,
              );
              const started = yield* store.beginAttempt(
                id,
                WorkerName.make("local"),
                Option.none(),
              );
              assert(started._tag === "AttemptStarted");
              yield* TestClock.adjust("2 seconds");
              if (index < 4)
                yield* store.finishAttempt(
                  started.execution.attempt,
                  Result.succeed(
                    StepResult.make({ message: "Done", facts: index === 0 ? [link] : [] }),
                  ),
                );
              yield* TestClock.adjust("1 second");
            }
            const latest = ids[4];
            assert(latest !== undefined);
            assert.deepStrictEqual(
              (yield* reader.list({ closedLimit: 1 })).map(({ run }) => run.id),
              [latest, ids[3]],
            );
            assert.deepStrictEqual(
              (yield* reader.forItems([lifecycleSubmission.itemKey])).map(({ run }) => run.id),
              [...ids].reverse(),
            );
            const board = yield* reader.board([lifecycleSubmission.itemKey], []);
            assert.deepStrictEqual(
              board.runs.map(({ run }) => run.id),
              [latest],
            );
            const [history] = board.items;
            assert(history !== undefined);
            assert.strictEqual(history.runCount, 5);
            assert.strictEqual(history.attemptCount, 5);
            assert.strictEqual(history.durationMillis, 8000);
            assert.strictEqual(history.unmeasured, 0);
            assert.strictEqual(history.runningSince.length, 1);
            assert.deepStrictEqual(history.pullRequestUrls, [link.url.href]);
            assert.deepStrictEqual(
              history.usageSources.flatMap(({ attempts }) => attempts.map(({ ended }) => ended)),
              [true, true, true, true, false],
            );
            assert.deepStrictEqual(
              history.loops.map(({ firstRunId, latestRunId }) => [firstRunId, latestRunId]),
              [[ids[0], latest]],
            );
            assert.strictEqual((yield* reader.events([...ids, latest])).length, 5);
            const runId = yield* reader.runForEvent(DedupKey.make(latest));
            assert.deepStrictEqual(runId, Option.some(latest));
            const evidence = yield* reader.evidence(latest);
            assert.strictEqual(evidence.snapshot.run.state._tag, "Running");
            assert.deepStrictEqual(evidence.transcript, []);
            assert.deepStrictEqual(
              (yield* reader.attemptsByWorker).map(({ attempts, running }) => [attempts, running]),
              [[5, 1]],
            );
            assert.deepStrictEqual((yield* reader.board([], [])).items, []);
          }),
        ),
    );
  });
};
