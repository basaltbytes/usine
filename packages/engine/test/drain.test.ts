import { assert, describe, it } from "@effect/vitest";
import { ReleaseVersion } from "@usine/core/upgrade";
import { InfraFailure } from "@usine/core/attempt/failure";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Schedule,
  Scope,
  TxRef,
} from "effect";
import { RunEngine, RunEngineShutdown } from "../src/engine/engine.ts";
import { runIdFor } from "../src/engine/submission.ts";
import {
  type AttemptPlan,
  engineLayer,
  executorLayer,
  slottedExecutor,
  stepResult,
  submission,
  waitFor,
  withInstance,
} from "./support.ts";

describe("engine drain", () => {
  it.live("drains an admitted Attempt and leaves queued and new work for restart", () =>
    withInstance((directory) =>
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const finish = yield* Deferred.make<void>();
          const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(finish)),
              Effect.as(stepResult("finished before shutdown")),
            ),
            Effect.succeed(stepResult("queued work after restart")),
            Effect.succeed(stepResult("new work after restart")),
          ]);
          const runtime = engineLayer(directory, executorLayer(plans));
          const firstScope = yield* Scope.make();
          const first = Context.get(
            yield* Scope.provide(Layer.build(runtime), firstScope),
            RunEngine,
          );
          const accepted = yield* first.submit(submission({ number: 42 }));
          assert(accepted._tag === "Claimed");
          yield* Deferred.await(started);
          const queued = submission({ number: 43 });
          assert.strictEqual((yield* first.submit(queued))._tag, "Queued");
          const draining = yield* Effect.forkScoped(first.drain(), { startImmediately: true });
          const next = submission({ number: 44, item: "another-item" });
          yield* first.submit(next);
          yield* Deferred.succeed(finish, undefined);
          yield* Fiber.join(draining);
          const completed = yield* first.inspect(accepted.runId);
          assert.strictEqual(completed.run.state._tag, "Succeeded");
          assert.strictEqual(completed.attempts.length, 1);
          assert.strictEqual((yield* Ref.get(plans)).length, 2);
          yield* Scope.close(firstScope, Exit.void);

          const secondScope = yield* Scope.make();
          const second = Context.get(
            yield* Scope.provide(Layer.build(runtime), secondScope),
            RunEngine,
          );
          for (const pending of [queued, next]) {
            const completed = yield* waitFor(
              second,
              yield* runIdFor(pending),
              ({ run }) => run.state._tag === "Succeeded",
            );
            assert.strictEqual(completed.attempts.length, 1);
          }
          yield* Scope.close(secondScope, Exit.void);
        }),
      ),
    ),
  );

  it.live("a host shutdown latch closes admission before startup recovery", () =>
    withInstance((directory) =>
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
            Effect.succeed(stepResult("recovered after restart")),
          ]);
          const runtime = engineLayer(directory, executorLayer(plans));
          const firstScope = yield* Scope.make();
          const first = Context.get(
            yield* Scope.provide(Layer.build(runtime), firstScope),
            RunEngine,
          );
          const accepted = yield* first.submit(submission({ number: 48 }));
          assert(accepted._tag === "Claimed");
          yield* Deferred.await(entered);
          yield* Scope.close(firstScope, Exit.void);

          const stopped = yield* Deferred.make<void>();
          yield* Deferred.succeed(stopped, undefined);
          const secondScope = yield* Scope.make();
          const second = Context.get(
            yield* Scope.provide(Layer.build(runtime), secondScope).pipe(
              Effect.provideService(RunEngineShutdown, stopped),
            ),
            RunEngine,
          );
          yield* second.drain();
          assert.strictEqual((yield* second.inspect(accepted.runId)).attempts.length, 1);
          assert.strictEqual((yield* Ref.get(plans)).length, 1);
          yield* Scope.close(secondScope, Exit.void);

          yield* Effect.gen(function* () {
            const engine = yield* RunEngine;
            const recovered = yield* waitFor(
              engine,
              accepted.runId,
              ({ run }) => run.state._tag === "Succeeded",
            );
            assert.strictEqual(recovered.attempts.length, 2);
          }).pipe(Effect.provide(runtime));
        }),
      ),
    ),
  );

  it.live("defers an automatic retry during drain without adding an interruption failure", () =>
    withInstance((directory) =>
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const finish = yield* Deferred.make<void>();
          const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(finish)),
              Effect.andThen(
                new InfraFailure({ message: "temporary worker failure", cause: "test" }),
              ),
            ),
            Effect.succeed(stepResult("retried after restart")),
          ]);
          const runtime = engineLayer(directory, executorLayer(plans));
          const firstScope = yield* Scope.make();
          const first = Context.get(
            yield* Scope.provide(Layer.build(runtime), firstScope),
            RunEngine,
          );
          const accepted = yield* first.submit(submission({ number: 45 }));
          assert(accepted._tag === "Claimed");
          yield* Deferred.await(started);
          const draining = yield* Effect.forkScoped(first.drain(), { startImmediately: true });
          yield* Deferred.succeed(finish, undefined);
          yield* Fiber.join(draining);
          assert.strictEqual((yield* first.inspect(accepted.runId)).attempts.length, 1);
          assert.strictEqual((yield* Ref.get(plans)).length, 1);
          yield* Scope.close(firstScope, Exit.void);
          const secondScope = yield* Scope.make();
          const second = Context.get(
            yield* Scope.provide(Layer.build(runtime), secondScope),
            RunEngine,
          );
          const completed = yield* waitFor(
            second,
            accepted.runId,
            ({ run }) => run.state._tag === "Succeeded",
          );
          assert.strictEqual(completed.attempts.length, 2);
          const outcome = completed.attempts[0]?.outcome;
          assert(
            outcome !== undefined && Option.isSome(outcome) && outcome.value._tag === "Failed",
          );
          assert(outcome.value.failure._tag === "InfraFailure");
          assert.strictEqual(outcome.value.failure.message, "temporary worker failure");
          yield* Scope.close(secondScope, Exit.void);
        }),
      ),
    ),
  );
});

it.live(
  "an idle upgrade leaves three runs without leased slots and cancellation starts all three",
  () =>
    withInstance((directory) =>
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const finish = yield* Deferred.make<void>();
          const running = yield* Ref.make(0);
          const f = yield* slottedExecutor(
            [
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(finish)),
                Effect.as(stepResult("first")),
              ),
              ...Array.from({ length: 3 }, () =>
                Ref.update(running, (count) => count + 1).pipe(Effect.andThen(Effect.never)),
              ),
            ],
            4,
          );
          yield* Effect.gen(function* () {
            const engine = yield* RunEngine;
            yield* engine.submit(submission({ number: 50, item: "active" }));
            yield* Deferred.await(started);
            const drain = yield* Effect.forkScoped(
              engine.waitForUpgrade(ReleaseVersion.make("1.2.3")),
              { startImmediately: true },
            );
            const runs = yield* Effect.forEach([51, 52, 53], (number) =>
              engine.submit(submission({ number, item: `item-${number}` })),
            );
            const status = yield* engine.upgradeDrain.pipe(
              Effect.repeat({
                schedule: Schedule.spaced("10 millis"),
                until: (value) => Option.isSome(value) && value.value.runIds.length === 3,
              }),
            );
            assert(Option.isSome(status));
            assert.strictEqual(status.value.wait.target, "1.2.3");
            assert.strictEqual(yield* TxRef.get(f.leased), 1);
            assert.strictEqual(
              drain.pollUnsafe(),
              undefined,
              "the admitted attempt still blocks installation",
            );
            for (const result of runs) {
              assert(result._tag === "Claimed");
              assert.strictEqual((yield* engine.inspect(result.runId)).attempts.length, 0);
            }
            yield* Fiber.interrupt(drain);
            yield* engine.cancelUpgrade;
            yield* Ref.get(running).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("10 millis"),
                until: (count) => count === 3,
              }),
            );
            assert.strictEqual(yield* TxRef.get(f.leased), 4);
            assert(Option.isNone(yield* engine.upgradeDrain));
            yield* Deferred.succeed(finish, undefined);
          }).pipe(Effect.provide(engineLayer(directory, f.executor)));
        }),
      ),
    ),
);
