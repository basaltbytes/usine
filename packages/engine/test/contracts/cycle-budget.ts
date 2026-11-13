import { assert, describe, it } from "@effect/vitest";
import { CycleGeneration, CycleLimit } from "@usine/core/cycle-budget";
import { DedupKey, Event, EventId } from "@usine/core/event";
import { RunId } from "@usine/core/run";
import { StepResult } from "@usine/core/step/result";
import { WorkerName } from "@usine/core/worker";
import { Effect, Option, Result } from "effect";

import { CycleBudgets } from "../../src/cycle-budget/cycle-budget.ts";
import { CycleBudgetReset } from "../../src/cycle-budget/model.ts";
import { Submission } from "../../src/engine/submission.ts";
import { RunStore } from "../../src/store/store.ts";
import { lifecycleSubmission } from "../store/fixtures.ts";
import { type PersistenceAdapter, withPersistence } from "./adapter.ts";

export const cycleBudgetContract = (adapter: PersistenceAdapter) => {
  describe(`${adapter.name} CycleBudgets contract`, () => {
    it.effect("resets an exhausted budget once and acknowledges only its own generation", () =>
      withPersistence(
        adapter,
        Effect.gen(function* () {
          const store = yield* RunStore;
          const budgets = yield* CycleBudgets;
          const first = Submission.make({
            ...lifecycleSubmission,
            cycleLimit: Option.some(CycleLimit.make(1)),
          });
          const runId = RunId.make("budget-first");
          yield* store.recordAndClaim(first, runId);
          const started = yield* store.beginAttempt(
            runId,
            WorkerName.make("local"),
            "local",
            Option.none(),
          );
          assert(started._tag === "AttemptStarted");
          yield* store.finishAttempt(
            started.execution.attempt,
            Result.succeed(StepResult.make({ message: "Done", facts: [] })),
          );
          const event = Event.make({
            ...first.event,
            id: EventId.make("budget-next"),
            dedupKey: DedupKey.make("budget-next"),
          });
          const blocked = yield* store.recordAndClaim(
            Submission.make({ ...first, event }),
            RunId.make("budget-blocked"),
          );
          assert(blocked.result._tag === "CycleBlocked");
          const ask = blocked.result.ask;
          const currentAsks = yield* budgets.asks;
          assert.deepStrictEqual(currentAsks, [ask]);
          const currentGeneration = yield* budgets.generation(first.itemKey);
          assert.strictEqual(currentGeneration, 0);
          const answer = Event.make({
            ...event,
            id: EventId.make("budget-answer"),
            dedupKey: DedupKey.make("budget-answer"),
          });
          yield* Effect.all([budgets.reset(ask.id, answer), budgets.reset(ask.id, answer)], {
            concurrency: "unbounded",
          });
          const nextGeneration = yield* budgets.generation(first.itemKey);
          assert.strictEqual(nextGeneration, 1);
          const nextAsks = yield* budgets.asks;
          assert.deepStrictEqual(nextAsks, []);
          const [reset] = yield* budgets.pendingResets;
          assert(reset !== undefined);
          yield* budgets.acknowledgeReset(
            CycleBudgetReset.make({ ...reset, generation: CycleGeneration.make(0) }),
          );
          const currentPendingResets = yield* budgets.pendingResets;
          assert.deepStrictEqual(currentPendingResets, [reset]);
          yield* budgets.acknowledgeReset(reset);
          yield* budgets.acknowledgeReset(reset);
          const nextPendingResets = yield* budgets.pendingResets;
          assert.deepStrictEqual(nextPendingResets, []);
          assert.strictEqual(
            (yield* budgets.reset(ask.id, event).pipe(Effect.flip))._tag,
            "CycleBudgetResetRejectedError",
          );
          const closed = yield* budgets.close(ask.id, "ItemClosed");
          assert.strictEqual(closed, false);
        }),
      ),
    );
  });
};
