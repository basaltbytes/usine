import { assert, describe, it } from "@effect/vitest";
import { InfraFailure } from "@usine/core/attempt/failure";
import { LoopName } from "@usine/core/loop";
import { Deferred, Effect, Fiber, Layer, Ref, Schedule } from "effect";
import {
  ReconcileInterval,
  RunEngine,
  Submission,
  UnconfirmedStops,
} from "../src/engine/engine.ts";
import { StepExecutor } from "../src/step-executor.ts";
import {
  engineLayer,
  slottedExecutor,
  stepResult,
  submission,
  waitFor,
  withInstance,
} from "./support.ts";

describe("pending parent stops", () => {
  for (const reason of ["failed", "cancel"] as const) {
    it.live(`blocks every loop on the item while the ${reason} stop call is pending`, () =>
      withInstance((directory) =>
        Effect.gen(function* () {
          const fail = yield* Deferred.make<void>();
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const worker = yield* slottedExecutor(
            [
              Deferred.await(fail).pipe(
                Effect.andThen(new InfraFailure({ message: "Lost parent", cause: "offline" })),
              ),
              Effect.succeed(stepResult("other item")),
              Effect.succeed(stepResult("after stop")),
              Effect.succeed(stepResult("other loop after stop")),
            ],
            3,
          );
          const executor = Layer.effect(
            StepExecutor,
            Effect.gen(function* () {
              const scripted = yield* StepExecutor;
              return StepExecutor.of({
                ...scripted,
                interrupt: (attemptId, stopReason) =>
                  Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(scripted.interrupt(attemptId, stopReason)),
                  ),
              });
            }),
          ).pipe(Layer.provide(worker.executor));
          yield* Effect.gen(function* () {
            const engine = yield* RunEngine;
            const stops = yield* UnconfirmedStops;
            const first = submission({ number: 1, item: "same-item" });
            const accepted = yield* engine.submit(first);
            assert(accepted._tag === "Claimed");
            yield* waitFor(engine, accepted.runId, ({ attempts }) => attempts.length === 1);
            yield* Ref.set(worker.unstoppable, true);
            const cancellation = yield* (
              reason === "cancel"
                ? engine.cancel(accepted.runId).pipe(Effect.result)
                : Deferred.succeed(fail, undefined)
            ).pipe(Effect.forkChild);
            yield* Deferred.await(entered);
            assert.lengthOf(yield* stops.list, 1);
            const sameItem = yield* engine.submit(
              new Submission({
                ...submission({ number: 2, item: "same-item" }),
                loop: LoopName.make("another-loop"),
              }),
            );
            assert(sameItem._tag === "Claimed");
            const elsewhere = yield* engine.submit(submission({ number: 3, item: "other-item" }));
            assert(elsewhere._tag === "Claimed");
            yield* waitFor(engine, elsewhere.runId, ({ run }) => run.state._tag === "Succeeded");
            assert.isEmpty((yield* engine.inspect(sameItem.runId)).attempts);
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(cancellation);
            yield* Effect.repeat(Ref.get(worker.stops), {
              until: (calls) => calls.length >= 3,
              schedule: Schedule.spaced("10 millis"),
            });
            assert.isEmpty((yield* engine.inspect(sameItem.runId)).attempts);
            yield* Ref.set(worker.unstoppable, false);
            yield* waitFor(engine, sameItem.runId, ({ run }) => run.state._tag === "Succeeded");
            assert.isEmpty(yield* stops.list);
          }).pipe(
            Effect.ensuring(Deferred.succeed(release, undefined)),
            Effect.provide(engineLayer(directory, executor)),
            Effect.provideService(ReconcileInterval, "50 millis"),
          );
        }),
      ),
    );
  }
});
