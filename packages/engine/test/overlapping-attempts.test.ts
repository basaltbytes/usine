import { assert, describe, it } from "@effect/vitest";
import type { AttemptId, AttemptWindows } from "@usine/core/attempt";
import { LoopName } from "@usine/core/loop";
import { WorkerName } from "@usine/core/worker";
import {
  Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Schedule,
  Scope,
} from "effect";
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
  interrupt: StepExecutor["Service"]["interrupt"] = () => Effect.void,
) =>
  Layer.succeed(StepExecutor)({
    workers: Effect.succeed([WorkerName.make("local")]),
    isLive: () => Effect.succeed(false),
    outcome: () => Effect.succeed(Option.none()),
    recover,
    intervene: () => Effect.void,
    interrupt,
    occupy: (worker) => Effect.succeed({ worker, release: Effect.void }),
    sweep: Effect.void,
    discard: () => Effect.void,
    reserve: () => Effect.succeed({ worker: WorkerName.make("local"), release: Effect.void }),
    execute,
  });

describe("an Attempt's windows", () => {
  it.live("reach its harvest when it runs, including an Attempt that started after it", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const reviewStarted = yield* Deferred.make<void>();
        const fixHarvested = yield* Deferred.make<void>();
        const read = yield* Ref.make(new Map<AttemptId, ReadonlyArray<AttemptId>>());
        const harvest = (attemptId: AttemptId, windows: AttemptWindows) =>
          Ref.update(read, (seen) =>
            new Map(seen).set(
              attemptId,
              windows.overlapping.map((window) => window.attemptId),
            ),
          );
        const executor = executorWith((execution, io) =>
          Effect.gen(function* () {
            // The review Attempt starts first and harvests after the fix Attempt started.
            if (execution.run.loop === "review") {
              yield* Deferred.succeed(reviewStarted, undefined);
              yield* Deferred.await(fixHarvested);
            } else yield* Deferred.await(reviewStarted);
            yield* harvest(execution.attempt.id, yield* io.windows);
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

  it.live("show a canceled Attempt's harvest that its window ended at the cancel", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        // The executor harvests a canceled Attempt while the engine stops it,
        // as the durable session does once the parent task has stopped.
        const stopping = yield* Deferred.make<void>();
        const harvested = yield* Deferred.make<AttemptWindows>();
        const started = yield* Deferred.make<void>();
        const executor = executorWith(
          (_, io) =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(stopping)),
              Effect.andThen(io.windows),
              Effect.flatMap((windows) => Deferred.succeed(harvested, windows)),
              Effect.andThen(Effect.never),
            ),
          () => Effect.void,
          () =>
            Deferred.succeed(stopping, undefined).pipe(
              Effect.andThen(Effect.asVoid(Deferred.await(harvested))),
            ),
        );
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const fix = yield* engine.submit(onPullRequest(2, "fix"));
          assert(fix._tag === "Claimed");
          yield* Deferred.await(started);
          yield* engine.cancel(fix.runId);
          const [canceled] = (yield* engine.inspect(fix.runId)).attempts;
          assert(canceled !== undefined && Option.isSome(canceled.endedAt));
          const { own, overlapping } = yield* Deferred.await(harvested);
          assert.deepStrictEqual(
            Option.map(own, ({ attemptId, endedAt }) => [
              attemptId,
              Option.map(endedAt, DateTime.toEpochMillis),
            ]),
            Option.some([canceled.id, Option.some(DateTime.toEpochMillis(canceled.endedAt.value))]),
          );
          assert.deepStrictEqual(overlapping, []);
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
                ? record.windows.pipe(
                    Effect.flatMap((windows) =>
                      Ref.update(read, (seen) =>
                        new Map(seen).set(
                          attempt.attemptId,
                          windows.overlapping.map((window) => window.attemptId),
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
