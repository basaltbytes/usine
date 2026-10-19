import { assert, describe, it } from "@effect/vitest";
import { AttemptContext, AttemptTask } from "@usine/core/attempt";
import { AgentFailure } from "@usine/core/attempt/failure";
import { CycleLimit, DEFAULT_CYCLE_LIMIT } from "@usine/core/cycle-budget";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { OperatorLogin } from "@usine/core/operator";
import { StepName } from "@usine/core/step";
import { Effect, Option, Ref } from "effect";
import { CycleBudgets } from "../src/cycle-budget/cycle-budget.ts";
import { RunEngine } from "../src/engine/engine.ts";
import { RunAgainRequest } from "../src/engine/run-again.ts";
import { Submission } from "../src/engine/submission.ts";
import { RunReader } from "../src/run-reader/run-reader.ts";
import {
  type AttemptPlan,
  engineLayer,
  executorLayer,
  stepResult,
  submission,
  testAgent,
  waitFor,
  withInstance,
} from "./support.ts";

const loop = LoopName.make("review");
const operator = OperatorLogin.make("operator");

const request = (fields: Partial<ConstructorParameters<typeof RunAgainRequest>[0]> = {}) =>
  new RunAgainRequest({
    step: StepName.make("run"),
    approval: "none",
    cycleLimit: Option.some(DEFAULT_CYCLE_LIMIT),
    context: new AttemptContext({
      task: AttemptTask.make("Finish the review"),
      agent: testAgent,
      parentModel: Option.none(),
    }),
    requestedBy: Option.some(operator),
    ...fields,
  });

const historyOf = (item: string) =>
  Effect.gen(function* () {
    const runs = yield* (yield* RunReader).forItems([ItemKey.make(item)]);
    return runs.map(({ run }) => run.id);
  });

describe("Run again", () => {
  it.live("opens a new Run for a succeeded Run's Item state, which an unchanged poll joins", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          Effect.succeed(stepResult("Stopped on a blocker")),
          Effect.succeed(stepResult("Finished")),
        ]);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const sighting = submission({ number: 1, item: "succeeded-item" });
          const first = yield* engine.submit(sighting);
          assert(first._tag === "Claimed");
          yield* waitFor(engine, first.runId, ({ run }) => run.state._tag === "Succeeded");

          const again = yield* engine.runAgain(first.runId, request());
          assert(again._tag === "Claimed");
          assert.notStrictEqual(again.runId, first.runId);
          const reran = yield* waitFor(
            engine,
            again.runId,
            ({ run }) => run.state._tag === "Succeeded",
          );
          assert.strictEqual(reran.attempts.length, 1);
          assert.strictEqual(reran.attempts[0]?.task, "Finish the review");
          assert.strictEqual(reran.itemKey, sighting.itemKey);
          assert.deepStrictEqual(reran.event.payload, sighting.event.payload);
          assert.strictEqual(
            reran.event.dedupKey,
            JSON.stringify(["operator-run-again", 1, sighting.event.dedupKey]),
          );
          assert(Option.isSome(reran.runAgain));
          assert.strictEqual(reran.runAgain.value.from, first.runId);
          assert.strictEqual(Option.getOrNull(reran.runAgain.value.requestedBy), operator);
          const original = yield* engine.inspect(first.runId);
          assert.strictEqual(original.run.state._tag, "Succeeded");
          assert(Option.isNone(original.runAgain));

          // The unchanged Item still opens nothing: its Event joins the newest Run.
          const polled = yield* engine.submit(sighting);
          assert(polled._tag === "Claimed");
          assert.strictEqual(polled.runId, again.runId);
          assert.sameMembers([...(yield* historyOf("succeeded-item"))], [first.runId, again.runId]);
        }).pipe(Effect.provide(engineLayer(directory, executorLayer(plans))));
      }),
    ),
  );

  it.live(
    "runs a canceled Run again behind the Loop's approval after a relabel within one poll (#342)",
    () =>
      withInstance((directory) =>
        Effect.gen(function* () {
          const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([]);
          yield* Effect.gen(function* () {
            const engine = yield* RunEngine;
            const item = ItemKey.make("relabeled-item");
            const sighting = submission({ number: 2, item, approval: "required" });
            const first = yield* engine.submit(sighting);
            assert(first._tag === "Claimed");
            yield* waitFor(engine, first.runId, ({ run }) => run.state._tag === "Waiting");
            yield* engine.cancel(first.runId);

            // A label round trip within one poll is seen only as its end state.
            const relabeled = yield* engine.submit(sighting);
            assert(relabeled._tag === "Claimed");
            assert.strictEqual(relabeled.runId, first.runId);

            const again = yield* engine.runAgain(first.runId, request({ approval: "required" }));
            assert(again._tag === "Claimed");
            assert.notStrictEqual(again.runId, first.runId);
            yield* waitFor(engine, again.runId, ({ run }) => run.state._tag === "Waiting");
            const polled = yield* engine.submit(sighting);
            assert(polled._tag === "Claimed");
            assert.strictEqual(polled.runId, again.runId);

            // A comeback after the new Run's cancel reopens the state with the next number.
            yield* engine.cancel(again.runId);
            yield* engine.revoke(loop, item);
            const reopened = yield* engine.submit(sighting);
            assert(reopened._tag === "Claimed");
            assert.notInclude([first.runId, again.runId], reopened.runId);
            assert.strictEqual(
              (yield* engine.inspect(reopened.runId)).event.dedupKey,
              JSON.stringify(["reopened", 2, sighting.event.dedupKey]),
            );
          }).pipe(Effect.provide(engineLayer(directory, executorLayer(plans))));
        }),
      ),
  );

  it.live("opens the Item's cycle-budget Ask instead of a Run once the budget is used up", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          Effect.succeed(stepResult("First round")),
        ]);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const limit = Option.some(CycleLimit.make(1));
          const first = yield* engine.submit(
            new Submission({
              ...submission({ number: 3, item: "budget-item" }),
              cycleLimit: limit,
            }),
          );
          assert(first._tag === "Claimed");
          yield* waitFor(engine, first.runId, ({ run }) => run.state._tag === "Succeeded");

          const blocked = yield* engine.runAgain(first.runId, request({ cycleLimit: limit }));
          assert(blocked._tag === "CycleBlocked");
          const asks = yield* (yield* CycleBudgets).asks();
          assert.deepStrictEqual(
            asks.map(({ id }) => id),
            [blocked.ask.id],
          );
          assert.deepStrictEqual(yield* historyOf("budget-item"), [first.runId]);
        }).pipe(Effect.provide(engineLayer(directory, executorLayer(plans))));
      }),
    ),
  );

  it.live("refuses a failed or open Run, and a Run whose Item has another open Run", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          Effect.fail(new AgentFailure({ message: "Needs the operator" })),
          Effect.succeed(stepResult("Reviewed")),
        ]);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const failed = yield* engine.submit(submission({ number: 4, item: "failed-item" }));
          assert(failed._tag === "Claimed");
          yield* waitFor(engine, failed.runId, ({ run }) => run.state._tag === "Failed");
          const refused = yield* engine.runAgain(failed.runId, request()).pipe(Effect.flip);
          assert(refused._tag === "RunOperationRejectedError");
          assert.strictEqual(refused.operation, "runAgain");

          const succeeded = yield* engine.submit(submission({ number: 5, item: "busy-item" }));
          assert(succeeded._tag === "Claimed");
          yield* waitFor(engine, succeeded.runId, ({ run }) => run.state._tag === "Succeeded");
          const waiting = yield* engine.submit(
            submission({ number: 6, item: "busy-item", approval: "required" }),
          );
          assert(waiting._tag === "Claimed");
          yield* waitFor(engine, waiting.runId, ({ run }) => run.state._tag === "Waiting");
          const blocked = yield* engine.runAgain(succeeded.runId, request()).pipe(Effect.flip);
          assert(blocked._tag === "RunRetryBlockedError");
          assert.strictEqual(blocked.openRunId, waiting.runId);
          const open = yield* engine.runAgain(waiting.runId, request()).pipe(Effect.flip);
          assert(open._tag === "RunOperationRejectedError");
          assert.sameMembers(
            [...(yield* historyOf("busy-item"))],
            [succeeded.runId, waiting.runId],
          );
        }).pipe(Effect.provide(engineLayer(directory, executorLayer(plans))));
      }),
    ),
  );
});
