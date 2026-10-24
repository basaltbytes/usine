import { assert, describe, it } from "@effect/vitest";
import { InfraFailure } from "@usine/core/attempt/failure";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Ref, Scope } from "effect";
import { RunEngine, RunEngineShutdown } from "../src/engine/engine.ts";
import { runIdFor } from "../src/engine/submission.ts";
import {
  type AttemptPlan,
  engineLayer,
  executorLayer,
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
