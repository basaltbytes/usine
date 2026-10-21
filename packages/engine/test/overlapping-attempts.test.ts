import { assert, describe, it } from "@effect/vitest";
import type { AttemptId, AttemptWindow } from "@usine/core/attempt";
import { LoopName } from "@usine/core/loop";
import { WorkerName } from "@usine/core/worker";
import { Context, Deferred, Effect, Exit, Layer, Option, Ref, Schedule, Scope } from "effect";
import { RunEngine } from "../src/engine/engine.ts";
import { Submission } from "../src/engine/submission.ts";
import { StepExecutor } from "../src/step-executor.ts";
import { engineLayer, stepResult, submission, waitFor, withInstance } from "./support.ts";

/** Two Loops' Runs of the developer Agent on pull request 71 (#429). */
const onPullRequest = (number: number, loop: string) =>
  new Submission({ ...submission({ number, item: "pull-71" }), loop: LoopName.make(loop) });

const executorWith = (
  execute: StepExecutor["Service"]["execute"],
  recover: StepExecutor["Service"]["recover"] = () => Effect.void,
) =>
  Layer.succeed(StepExecutor)({
    workers: Effect.succeed([WorkerName.make("local")]),
    isLive: () => Effect.succeed(false),
    outcome: () => Effect.succeed(Option.none()),
    recover,
    intervene: () => Effect.void,
    interrupt: () => Effect.void,
    reserve: () => Effect.succeed({ worker: WorkerName.make("local"), release: Effect.void }),
    execute,
  });

describe("the windows of an Attempt's overlapping Attempts", () => {
  it.live("reach its harvest when it runs, including an Attempt that started after it", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const reviewStarted = yield* Deferred.make<void>();
        const fixHarvested = yield* Deferred.make<void>();
        const read = yield* Ref.make(new Map<AttemptId, ReadonlyArray<AttemptId>>());
        const harvest = (attemptId: AttemptId, windows: ReadonlyArray<AttemptWindow>) =>
          Ref.update(read, (seen) =>
            new Map(seen).set(
              attemptId,
              windows.map((window) => window.attemptId),
            ),
          );
        const executor = executorWith((execution, io) =>
          Effect.gen(function* () {
            // The review Attempt starts first and harvests after the fix Attempt started.
            if (execution.run.loop === "review") {
              yield* Deferred.succeed(reviewStarted, undefined);
              yield* Deferred.await(fixHarvested);
            } else yield* Deferred.await(reviewStarted);
            yield* harvest(execution.attempt.id, yield* io.overlapping);
            if (execution.run.loop === "fix") yield* Deferred.succeed(fixHarvested, undefined);
            return stepResult("Harvested");
          }),
        );
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const review = yield* engine.submit(onPullRequest(1, "review"));
          assert(review._tag === "Claimed");
          yield* Deferred.await(reviewStarted);
          const fix = yield* engine.submit(onPullRequest(2, "fix"));
          assert(fix._tag === "Claimed");
          const [reviewAttempt] = (yield* waitFor(
            engine,
            review.runId,
            ({ run }) => run.state._tag === "Succeeded",
          )).attempts;
          const [fixAttempt] = (yield* waitFor(
            engine,
            fix.runId,
            ({ run }) => run.state._tag === "Succeeded",
          )).attempts;
          assert(reviewAttempt !== undefined && fixAttempt !== undefined);
          assert.deepStrictEqual(
            yield* Ref.get(read),
            new Map([
              [fixAttempt.id, [reviewAttempt.id]],
              [reviewAttempt.id, [fixAttempt.id]],
            ]),
          );
        }).pipe(Effect.provide(engineLayer(directory, executor)));
      }),
    ),
  );

  it.live("reach startup reconciliation for each open Attempt", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const started = yield* Ref.make(0);
        const first = engineLayer(
          directory,
          executorWith(() =>
            Ref.update(started, (count) => count + 1).pipe(Effect.andThen(Effect.never)),
          ),
        );
        const firstScope = yield* Scope.make();
        const firstEngine = Context.get(
          yield* Scope.provide(Layer.build(first), firstScope),
          RunEngine,
        );
        const review = yield* firstEngine.submit(onPullRequest(1, "review"));
        const fix = yield* firstEngine.submit(onPullRequest(2, "fix"));
        assert(review._tag === "Claimed" && fix._tag === "Claimed");
        yield* Effect.repeat(Ref.get(started), {
          until: (count) => count === 2,
          schedule: Schedule.spaced("10 millis"),
        });
        // Both Attempts are open when the process stops.
        yield* Scope.close(firstScope, Exit.void);

        const read = yield* Ref.make(new Map<AttemptId, ReadonlyArray<AttemptId>>());
        const second = engineLayer(
          directory,
          executorWith(
            () => Effect.never,
            (attempt, record) =>
              attempt.open
                ? record.overlapping.pipe(
                    Effect.flatMap((windows) =>
                      Ref.update(read, (seen) =>
                        new Map(seen).set(
                          attempt.attemptId,
                          windows.map((window) => window.attemptId),
                        ),
                      ),
                    ),
                  )
                : Effect.void,
          ),
        );
        const secondScope = yield* Scope.make();
        const secondEngine = Context.get(
          yield* Scope.provide(Layer.build(second), secondScope),
          RunEngine,
        );
        const [reviewAttempt] = (yield* secondEngine.inspect(review.runId)).attempts;
        const [fixAttempt] = (yield* secondEngine.inspect(fix.runId)).attempts;
        assert(reviewAttempt !== undefined && fixAttempt !== undefined);
        assert.deepStrictEqual(
          yield* Ref.get(read),
          new Map([
            [reviewAttempt.id, [fixAttempt.id]],
            [fixAttempt.id, [reviewAttempt.id]],
          ]),
        );
        yield* Scope.close(secondScope, Exit.void);
      }),
    ),
  );
});
