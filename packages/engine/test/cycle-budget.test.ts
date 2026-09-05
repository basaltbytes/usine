import { NodeServices } from "@effect/platform-node";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Agent, AgentName, AgentPersona } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AttemptTask } from "@usine/core/attempt";
import { InfraFailure } from "@usine/core/attempt/failure";
import { CycleLimit } from "@usine/core/cycle-budget";
import { Event, EventId, DedupKey } from "@usine/core/event";
import { InstanceDirectory } from "@usine/core/instance";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { StepName } from "@usine/core/step";
import { StepResult } from "@usine/core/step/result";
import { WorkerName } from "@usine/core/worker";
import { DateTime, Effect, FileSystem, Layer, Option, Result } from "effect";
import { CycleBudgets } from "../src/cycle-budget/cycle-budget.ts";
import { localSqliteLayer } from "../src/database/local-sqlite.ts";
import { Submission } from "../src/engine/submission.ts";
import { RunStore } from "../src/store/store.ts";

const agent = new Agent({
  name: AgentName.make("reviewer"),
  persona: AgentPersona.make("Review the PR."),
  brain: new BrainSpec({ harness: "codex", model: ModelId.make("test-model"), effort: "high" }),
  parentModel: Option.none(),
  parentEffort: Option.none(),
});
const worker = WorkerName.make("test-worker");
const success = Result.succeed(new StepResult({ message: "Round complete", facts: [] }));
const event = (key: string) =>
  new Event({
    id: EventId.make(key),
    dedupKey: DedupKey.make(key),
    receivedAt: DateTime.makeUnsafe("2026-09-05T00:00:00Z"),
    payload: { key },
  });
const submission = (loop: string, round: number, item = "pr-72") =>
  new Submission({
    event: event(`${item}/${loop}/${round}`),
    itemKey: ItemKey.make(item),
    loop: LoopName.make(loop),
    step: StepName.make("run"),
    approval: "none",
    repository: RepositoryName.make("basaltbytes/usine"),
    revision: RepositoryRevision.make(`commit-${round}`),
    task: AttemptTask.make("Work on this Item"),
    agent,
    parentModel: Option.none(),
  });
const idFor = (value: Submission) => RunId.make(value.event.id);
const services = Layer.mergeAll(RunStore.layer, CycleBudgets.layer);
const inDatabase = <A, E>(
  directory: InstanceDirectory,
  work: Effect.Effect<A, E, RunStore | CycleBudgets>,
) =>
  work.pipe(Effect.provide(services), Effect.provide(localSqliteLayer(directory)), Effect.scoped);
const withDirectory = <A, E, R>(work: (directory: InstanceDirectory) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = InstanceDirectory.make(
      yield* fs.makeTempDirectoryScoped({ prefix: "usine-cycle-budget-" }),
    );
    return yield* work(directory);
  }).pipe(Effect.provide(NodeServices.layer));

const complete = Effect.fn("test.completeCycleRun")(function* (value: Submission) {
  const store = yield* RunStore;
  const runId = idFor(value);
  const claim = yield* store.recordAndClaim(value, runId);
  assert.strictEqual(claim.result._tag, "Claimed");
  const started = yield* store.beginAttempt(runId, worker);
  assert(started._tag === "AttemptStarted");
  yield* store.finishAttempt(started.execution.attempt, success);
});

describe("Item cycle budgets", () => {
  it.live("selects confirmed queued work even when a newer stale Event exists", () =>
    withDirectory((directory) =>
      inDatabase(
        directory,
        Effect.gen(function* () {
          const store = yield* RunStore;
          const budgets = yield* CycleBudgets;
          for (let round = 1; round <= 3; round += 1) yield* complete(submission("review", round));
          const running = submission("fix", 1);
          yield* store.recordAndClaim(running, idFor(running));
          const started = yield* store.beginAttempt(idFor(running), worker);
          assert(started._tag === "AttemptStarted");
          const older = submission("fix", 2);
          const newer = new Submission({
            ...submission("fix", 3),
            event: new Event({
              ...event("newer-stale-event"),
              receivedAt: DateTime.makeUnsafe("2026-09-05T01:00:00Z"),
            }),
          });
          yield* store.recordAndClaim(older, idFor(older));
          yield* store.recordAndClaim(newer, idFor(newer));
          const blocked = yield* store.recordAndClaim(
            submission("review", 4),
            RunId.make("blocked"),
          );
          assert(blocked.result._tag === "CycleBlocked");
          yield* budgets.reset(blocked.result.ask.id, event("reset-ordering"));
          assert(Option.isNone(yield* store.nextQueued(idFor(running))));
          yield* store.recordAndClaim(older, idFor(older));
          yield* store.finishAttempt(started.execution.attempt, success);
          const eligible = yield* store.nextQueued(idFor(running));
          assert(Option.isSome(eligible));
          assert.strictEqual(eligible.value.event.id, older.event.id);
          assert(Option.isSome(yield* store.claimQueued(eligible.value, idFor(eligible.value))));
        }),
      ),
    ),
  );

  it.live(
    "applies the default limit to queued Item Events when upgrading an existing database",
    () =>
      withDirectory((directory) =>
        Effect.gen(function* () {
          const legacy = (round: number) =>
            new Submission({ ...submission("review", round), cycleLimit: Option.none() });
          const third = legacy(3);
          const scheduled = new Submission({
            ...submission("schedule", 1, JSON.stringify(["github", "basaltbytes/usine"])),
            cycleLimit: Option.none(),
          });
          yield* inDatabase(
            directory,
            Effect.gen(function* () {
              const store = yield* RunStore;
              yield* complete(legacy(1));
              yield* complete(legacy(2));
              yield* store.recordAndClaim(third, idFor(third));
              const started = yield* store.beginAttempt(idFor(third), worker);
              assert(started._tag === "AttemptStarted");
              yield* store.recordAndClaim(legacy(4), idFor(legacy(4)));
              yield* store.finishAttempt(started.execution.attempt, success);
              yield* store.recordAndClaim(scheduled, idFor(scheduled));
              yield* store.beginAttempt(idFor(scheduled), worker);
              const nextTick = new Submission({ ...scheduled, event: event("legacy-next-tick") });
              yield* store.recordAndClaim(nextTick, idFor(nextTick));
            }),
          );
          // Reconstruct the pre-feature schema around real Run history, then let
          // the normal local adapter apply the upgrade on its next startup.
          yield* Effect.sync(() => {
            const database = new DatabaseSync(join(directory, ".usine/runtime.sqlite"));
            try {
              database.exec(`
            PRAGMA foreign_keys = OFF;
            DROP TRIGGER usine_projection_cycle_budgets_insert;
            DROP TRIGGER usine_projection_cycle_budgets_update;
            DROP TRIGGER usine_projection_cycle_budgets_delete;
            DROP TABLE usine_cycle_resets;
            DROP TABLE usine_cycle_reservations;
            DROP TABLE usine_item_cycle_budgets;
            ALTER TABLE usine_trigger_events DROP COLUMN cycle_limit;
            ALTER TABLE usine_trigger_events DROP COLUMN cycle_generation;
            DELETE FROM usine_migrations WHERE name = '20260905150403_item_cycle_budgets';
          `);
            } finally {
              database.close();
            }
          });
          yield* inDatabase(
            directory,
            Effect.gen(function* () {
              const store = yield* RunStore;
              const queued = yield* store.nextQueued(idFor(third));
              assert(Option.isSome(queued));
              assert.deepStrictEqual(queued.value.cycleLimit, Option.some(CycleLimit.make(3)));
              assert(Option.isNone(yield* store.claimQueued(queued.value, idFor(queued.value))));
              assert.strictEqual((yield* (yield* CycleBudgets).asks())[0]?.completedCycles, 3);
              const tick = yield* store.nextQueued(idFor(scheduled));
              assert(Option.isSome(tick) && Option.isNone(tick.value.cycleLimit));
            }),
          );
        }),
      ),
  );

  it.live("requires a fresh trigger submission before a pre-reset queued Event can continue", () =>
    withDirectory((directory) =>
      inDatabase(
        directory,
        Effect.gen(function* () {
          const store = yield* RunStore;
          const budgets = yield* CycleBudgets;
          for (let round = 1; round <= 3; round += 1) yield* complete(submission("review", round));
          const sibling = submission("fix", 1);
          yield* store.recordAndClaim(sibling, idFor(sibling));
          const running = yield* store.beginAttempt(idFor(sibling), worker);
          assert(running._tag === "AttemptStarted");
          const queued = submission("fix", 2);
          yield* store.recordAndClaim(queued, idFor(queued));
          const next = submission("review", 4);
          const blocked = yield* store.recordAndClaim(next, idFor(next));
          assert(blocked.result._tag === "CycleBlocked");
          yield* budgets.reset(blocked.result.ask.id, event("reset-with-sibling"));
          yield* store.finishAttempt(running.execution.attempt, success);
          assert(Option.isNone(yield* store.claimQueued(queued, idFor(queued))));
          // Even after the first polling page commits, an Item on a later page must
          // receive fresh evaluation before its old continuation is eligible.
          const reset = (yield* budgets.pendingResets())[0];
          assert(reset !== undefined);
          yield* budgets.acknowledgeReset(reset);
          assert(Option.isNone(yield* store.claimQueued(queued, idFor(queued))));
          assert.strictEqual(
            (yield* store.recordAndClaim(queued, idFor(queued))).result._tag,
            "Claimed",
          );
        }),
      ),
    ),
  );

  it.live(
    "persists oscillation limits, blocks sibling Loops, and requires an Ask-bound reset",
    () =>
      withDirectory((directory) =>
        Effect.gen(function* () {
          const ask = yield* inDatabase(
            directory,
            Effect.gen(function* () {
              const store = yield* RunStore;
              const budgets = yield* CycleBudgets;
              for (let round = 1; round <= 3; round += 1) {
                yield* complete(submission("review", round));
                yield* complete(submission("fix", round));
              }
              const next = submission("review", 4);
              const blocked = yield* store.recordAndClaim(next, idFor(next));
              assert(blocked.result._tag === "CycleBlocked");
              assert.strictEqual(blocked.result.ask.completedCycles, 3);
              assert.deepStrictEqual(
                blocked.result.ask.counts.map(({ admitted, completed }) => [admitted, completed]),
                [
                  [3, 3],
                  [3, 3],
                ],
              );
              assert.strictEqual(
                (yield* Effect.flip(store.snapshot(idFor(next))))._tag,
                "RunNotFoundError",
              );
              assert.deepStrictEqual(yield* budgets.asks(), [blocked.result.ask]);
              return blocked.result.ask;
            }),
          );
          yield* inDatabase(
            directory,
            Effect.gen(function* () {
              const store = yield* RunStore;
              const budgets = yield* CycleBudgets;
              assert.deepStrictEqual(yield* budgets.asks(), [ask]);
              for (const value of [
                submission("review", 4),
                submission("review", 5),
                submission("finisher", 1),
              ]) {
                const blocked = yield* store.recordAndClaim(value, idFor(value));
                assert(blocked.result._tag === "CycleBlocked");
                assert.strictEqual(blocked.result.ask.id, ask.id);
              }
              yield* store.revoke(LoopName.make("fix"), ItemKey.make("pr-72"));
              assert.deepStrictEqual(yield* budgets.asks(), [ask]);
              yield* complete(submission("review", 1, "another-pr"));
              yield* budgets.reset(ask.id, event("operator-reset-1"));
              assert.deepStrictEqual(yield* budgets.asks(), []);
            }),
          );
          yield* inDatabase(
            directory,
            Effect.gen(function* () {
              const store = yield* RunStore;
              const budgets = yield* CycleBudgets;
              assert.strictEqual((yield* budgets.pendingResets()).length, 1);
              yield* budgets.reset(ask.id, event("operator-reset-1"));
              for (let round = 5; round <= 7; round += 1)
                yield* complete(submission("review", round));
              const next = submission("review", 8);
              const blocked = yield* store.recordAndClaim(next, idFor(next));
              assert(blocked.result._tag === "CycleBlocked");
              const newerAsk = blocked.result.ask;
              yield* budgets.reset(ask.id, event("operator-reset-1"));
              assert.deepStrictEqual(yield* budgets.asks(), [newerAsk]);
              assert.strictEqual(
                (yield* Effect.flip(budgets.reset(ask.id, event("different-answer"))))._tag,
                "CycleBudgetResetRejectedError",
              );
            }),
          );
        }),
      ),
  );

  it.live(
    "does not charge duplicates, superseded unstarted Runs, or infrastructure retries twice",
    () =>
      withDirectory((directory) =>
        inDatabase(
          directory,
          Effect.gen(function* () {
            const store = yield* RunStore;
            const budgets = yield* CycleBudgets;
            const first = submission("review", 1);
            const second = submission("review", 2);
            yield* store.recordAndClaim(first, idFor(first));
            yield* store.recordAndClaim(second, idFor(second));
            yield* store.recordAndClaim(second, idFor(second));
            const started = yield* store.beginAttempt(idFor(second), worker);
            assert(started._tag === "AttemptStarted");
            yield* store.finishAttempt(
              started.execution.attempt,
              Result.fail(
                new InfraFailure({ message: "transport failed", cause: new Error("test") }),
              ),
            );
            const retried = yield* store.beginAttempt(idFor(second), worker);
            assert(retried._tag === "AttemptStarted");
            yield* store.finishAttempt(retried.execution.attempt, success);
            yield* complete(submission("review", 3));
            yield* complete(submission("review", 4));
            assert.deepStrictEqual(yield* budgets.asks(), []);
            const next = submission("review", 5);
            const blocked = yield* store.recordAndClaim(next, idFor(next));
            assert(blocked.result._tag === "CycleBlocked");
            assert.strictEqual(blocked.result.ask.counts[0].completed, 3);
          }),
        ),
      ),
  );

  it.live("guards queued continuations and keeps schedule ticks outside the Item budget", () =>
    withDirectory((directory) =>
      inDatabase(
        directory,
        Effect.gen(function* () {
          const store = yield* RunStore;
          const first = new Submission({
            ...submission("review", 1),
            cycleLimit: Option.some(CycleLimit.make(1)),
          });
          yield* store.recordAndClaim(first, idFor(first));
          const started = yield* store.beginAttempt(idFor(first), worker);
          assert(started._tag === "AttemptStarted");
          const next = new Submission({ ...submission("review", 2), cycleLimit: first.cycleLimit });
          assert.strictEqual(
            (yield* store.recordAndClaim(next, idFor(next))).result._tag,
            "Queued",
          );
          yield* store.finishAttempt(started.execution.attempt, success);
          assert(Option.isNone(yield* store.claimQueued(next, idFor(next))));
          assert.strictEqual((yield* (yield* CycleBudgets).asks()).length, 1);
          for (let tick = 1; tick <= 5; tick += 1)
            yield* complete(
              new Submission({
                ...submission("schedule", tick, "repository-schedule"),
                cycleLimit: Option.none(),
              }),
            );
        }),
      ),
    ),
  );
});
