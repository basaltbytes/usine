import { assert, describe, it } from "@effect/vitest";
import type { AttemptId } from "@usine/core/attempt";
import { AgentFailure, InfraFailure } from "@usine/core/attempt/failure";
import type { InstanceDirectory } from "@usine/core/instance";
import { WorkerName } from "@usine/core/worker";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Option,
  Ref,
  Result,
  Schedule,
  Scope,
} from "effect";
import { RunEngine, RunEngineShutdown } from "../src/engine/engine.ts";
import { runIdFor } from "../src/engine/submission.ts";
import { RunReader } from "../src/run-reader/run-reader.ts";
import { StepExecutor } from "../src/step-executor.ts";
import {
  approvalEvent,
  uiApproval,
  type AttemptPlan,
  committedBeforeCrash,
  engineLayer,
  executorLayer,
  stepResult,
  submission,
  waitFor,
  withInstance,
} from "./support.ts";

/** Runs one Attempt to success on Worker `local`, then closes that runtime. */
const deliverOneAttempt = (directory: InstanceDirectory, number: number) =>
  Effect.gen(function* () {
    const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
      Effect.succeed(stepResult("delivered before the restart")),
    ]);
    const scope = yield* Scope.make();
    const engine = Context.get(
      yield* Scope.provide(Layer.build(engineLayer(directory, executorLayer(plans))), scope),
      RunEngine,
    );
    const accepted = yield* engine.submit(submission({ number }));
    assert(accepted._tag === "Claimed");
    const delivered = yield* waitFor(
      engine,
      accepted.runId,
      ({ run }) => run.state._tag === "Succeeded",
    );
    yield* Scope.close(scope, Exit.void);
    return delivered;
  });

/** The executor of a restarted runtime that runs `workers`, starts nothing, and records each `recover` call. */
const recordingExecutor = (
  workers: ReadonlyArray<string>,
  recovered: Ref.Ref<ReadonlyArray<AttemptId>>,
) =>
  Layer.succeed(StepExecutor)({
    workers: Effect.succeed(workers.map((worker) => WorkerName.make(worker))),
    isLive: () => Effect.succeed(false),
    outcome: () => Effect.succeed(Option.none()),
    recover: (attempt) => Ref.update(recovered, (ids) => [...ids, attempt.attemptId]),
    intervene: () => Effect.void,
    interrupt: () => Effect.void,
    reserve: () => Effect.never,
    execute: () => Effect.die("no Attempt starts after the restart"),
  });

describe("engine restart", () => {
  it.live("keeps an approval wait parked when the runtime restarts", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          Effect.succeed(stepResult("approved after restart")),
        ]);
        const runtime = engineLayer(directory, executorLayer(plans));

        const firstScope = yield* Scope.make();
        const firstContext = yield* Scope.provide(Layer.build(runtime), firstScope);
        const firstEngine = Context.get(firstContext, RunEngine);
        const accepted = yield* firstEngine.submit(
          submission({ number: 12, item: "approval-restart", approval: "required" }),
        );
        assert.strictEqual(accepted._tag, "Claimed");
        if (accepted._tag !== "Claimed") return;
        yield* waitFor(firstEngine, accepted.runId, ({ run }) => run.state._tag === "Waiting");
        yield* Scope.close(firstScope, Exit.void);

        const secondScope = yield* Scope.make();
        const secondContext = yield* Scope.provide(Layer.build(runtime), secondScope);
        const secondEngine = Context.get(secondContext, RunEngine);
        yield* Effect.sleep("25 millis");
        const parked = yield* secondEngine.inspect(accepted.runId);
        assert.strictEqual(parked.run.state._tag, "Waiting");
        assert.strictEqual(parked.attempts.length, 0);

        yield* secondEngine.approve(accepted.runId, approvalEvent(12), uiApproval);
        const finished = yield* waitFor(
          secondEngine,
          accepted.runId,
          ({ run }) => run.state._tag === "Succeeded",
        );
        assert.strictEqual(finished.attempts.length, 1);
        yield* Scope.close(secondScope, Exit.void);
      }),
    ),
  );

  it.live("repairs an in-flight Attempt as N+1 after the runtime restarts", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          Effect.never,
          Effect.succeed(stepResult("resumed after restart")),
        ]);
        const runtime = engineLayer(directory, executorLayer(plans));

        const firstScope = yield* Scope.make();
        const firstContext = yield* Scope.provide(Layer.build(runtime), firstScope);
        const firstEngine = Context.get(firstContext, RunEngine);
        const accepted = yield* firstEngine.submit(submission({ number: 9 }));
        assert.strictEqual(accepted._tag, "Claimed");
        if (accepted._tag !== "Claimed") return;
        yield* waitFor(
          firstEngine,
          accepted.runId,
          ({ run, attempts }) => run.state._tag === "Running" && attempts.length === 1,
        );
        yield* Scope.close(firstScope, Exit.void);

        const secondScope = yield* Scope.make();
        const secondContext = yield* Scope.provide(Layer.build(runtime), secondScope);
        const secondEngine = Context.get(secondContext, RunEngine);
        const repaired = yield* waitFor(
          secondEngine,
          accepted.runId,
          ({ run }) => run.state._tag === "Succeeded",
        );
        assert.strictEqual(repaired.attempts.length, 2);
        assert.strictEqual(repaired.attempts[1]?.number, 2);
        const interrupted = repaired.attempts[0]?.outcome;
        assert(interrupted !== undefined);
        assert(Option.isSome(interrupted));
        assert.strictEqual(interrupted.value._tag, "Failed");
        if (interrupted.value._tag === "Failed") {
          assert.strictEqual(interrupted.value.failure._tag, "InfraFailure");
        }
        yield* Scope.close(secondScope, Exit.void);
      }),
    ),
  );

  it.live("reattaches an in-flight Attempt whose parent task outlived the restart", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const executions = yield* Ref.make<ReadonlyArray<readonly [AttemptId, boolean]>>([]);
        const live = yield* Ref.make<ReadonlySet<AttemptId>>(new Set());
        const executor = Layer.succeed(StepExecutor)({
          workers: Effect.succeed([WorkerName.make("local")]),
          isLive: (attemptId) => Ref.get(live).pipe(Effect.map((ids) => ids.has(attemptId))),
          outcome: () => Effect.succeed(Option.none()),
          recover: () => Effect.void,
          intervene: () => Effect.void,
          interrupt: () => Effect.void,
          reserve: () => Effect.succeed({ worker: WorkerName.make("local"), release: Effect.void }),
          execute: (execution) =>
            Ref.updateAndGet(executions, (seen) => [
              ...seen,
              [execution.attempt.id, execution.reattach] as const,
            ]).pipe(
              Effect.flatMap((seen) =>
                seen.length === 1
                  ? Ref.update(live, (ids) => new Set([...ids, execution.attempt.id])).pipe(
                      Effect.andThen(Effect.never),
                    )
                  : Effect.succeed(stepResult("finished by the reattached parent")),
              ),
            ),
        });
        const runtime = engineLayer(directory, executor);

        const firstScope = yield* Scope.make();
        const firstEngine = Context.get(
          yield* Scope.provide(Layer.build(runtime), firstScope),
          RunEngine,
        );
        const accepted = yield* firstEngine.submit(submission({ number: 10 }));
        assert(accepted._tag === "Claimed");
        // The first execution never returns: the parent task is live when the runtime closes.
        yield* Effect.repeat(Ref.get(executions), {
          until: (seen) => seen.length === 1,
          schedule: Schedule.spaced("10 millis"),
        });
        yield* Scope.close(firstScope, Exit.void);

        const secondScope = yield* Scope.make();
        const secondEngine = Context.get(
          yield* Scope.provide(Layer.build(runtime), secondScope),
          RunEngine,
        );
        const finished = yield* waitFor(
          secondEngine,
          accepted.runId,
          ({ run }) => run.state._tag === "Succeeded",
        );
        const [started] = finished.attempts;
        assert(started !== undefined && finished.attempts.length === 1);
        assert.deepStrictEqual(yield* Ref.get(executions), [
          [started.id, false],
          [started.id, true],
        ]);
        yield* Scope.close(secondScope, Exit.void);
      }),
    ),
  );

  it.live(
    "finishes an open Attempt with the result its parent task stored before the restart",
    () =>
      withInstance((directory) =>
        Effect.gen(function* () {
          const succeeding = submission({ number: 56, item: "stored-success" });
          const failing = submission({ number: 57, item: "stored-failure" });
          const executions = yield* Ref.make(0);
          const stored = yield* Ref.make<
            ReadonlyMap<AttemptId, Result.Result<ReturnType<typeof stepResult>, AgentFailure>>
          >(new Map());
          const executor = Layer.succeed(StepExecutor)({
            workers: Effect.succeed([WorkerName.make("local")]),
            isLive: () => Effect.succeed(false),
            outcome: (attemptId) =>
              Ref.get(stored).pipe(
                Effect.map((results) => Option.fromUndefinedOr(results.get(attemptId))),
              ),
            recover: () => Effect.void,
            intervene: () => Effect.void,
            interrupt: () => Effect.void,
            reserve: () =>
              Effect.succeed({ worker: WorkerName.make("local"), release: Effect.void }),
            // The parent finishes and its result is stored, then the process stops before the Run records it.
            execute: (execution) =>
              Ref.update(executions, (count) => count + 1).pipe(
                Effect.andThen(
                  Ref.update(stored, (results) =>
                    new Map(results).set(
                      execution.attempt.id,
                      execution.task === succeeding.task
                        ? Result.succeed(stepResult("finished before the restart"))
                        : Result.fail(new AgentFailure({ message: "blocked before the restart" })),
                    ),
                  ),
                ),
                Effect.andThen(Effect.never),
              ),
          });
          const runtime = engineLayer(directory, executor);

          const firstScope = yield* Scope.make();
          const firstEngine = Context.get(
            yield* Scope.provide(Layer.build(runtime), firstScope),
            RunEngine,
          );
          const succeeded = yield* firstEngine.submit(succeeding);
          const failed = yield* firstEngine.submit(failing);
          assert(succeeded._tag === "Claimed" && failed._tag === "Claimed");
          yield* Effect.repeat(Ref.get(stored), {
            until: (results) => results.size === 2,
            schedule: Schedule.spaced("10 millis"),
          });
          yield* Scope.close(firstScope, Exit.void);

          const secondScope = yield* Scope.make();
          const secondEngine = Context.get(
            yield* Scope.provide(Layer.build(runtime), secondScope),
            RunEngine,
          );
          const success = yield* waitFor(
            secondEngine,
            succeeded.runId,
            ({ run }) => run.state._tag === "Succeeded",
          );
          assert.strictEqual(success.attempts.length, 1);
          assert(Option.isSome(success.step.result));
          assert.strictEqual(success.step.result.value.message, "finished before the restart");
          const failure = yield* waitFor(
            secondEngine,
            failed.runId,
            ({ run }) => run.state._tag === "Failed",
          );
          assert.strictEqual(failure.attempts.length, 1);
          const outcome = failure.attempts[0]?.outcome;
          assert(
            outcome !== undefined && Option.isSome(outcome) && outcome.value._tag === "Failed",
          );
          assert.strictEqual(outcome.value.failure._tag, "AgentFailure");
          assert.strictEqual(yield* Ref.get(executions), 2);
          yield* Scope.close(secondScope, Exit.void);
        }),
      ),
  );

  it.live("reconciles each persisted Attempt once per start, however the engine is provided", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const delivered = yield* deliverOneAttempt(directory, 58);
        const recovered = yield* Ref.make<ReadonlyArray<AttemptId>>([]);
        const engine = engineLayer(directory, recordingExecutor(["local"], recovered));
        // The orchestrator provides the engine to several services at once.
        const consumer = () =>
          Layer.effectDiscard(Effect.asVoid(RunEngine)).pipe(Layer.provide(engine));
        const scope = yield* Scope.make();
        yield* Scope.provide(Layer.build(Layer.mergeAll(engine, consumer(), consumer())), scope);
        assert.deepStrictEqual(
          yield* Ref.get(recovered),
          delivered.attempts.map(({ id }) => id),
        );
        yield* Scope.close(scope, Exit.void);
      }),
    ),
  );

  it.live(
    "leaves the Attempts of a Worker that is not configured unreconciled until their leftovers are discarded",
    () =>
      withInstance((directory) =>
        Effect.gen(function* () {
          yield* deliverOneAttempt(directory, 59);
          const recovered = yield* Ref.make<ReadonlyArray<AttemptId>>([]);
          const warnings: Array<string> = [];
          const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
            if (logLevel === "Warn") warnings.push(JSON.stringify(message));
          });

          // `usine.yaml` now declares only `usine-worker-1`.
          const switched = engineLayer(directory, recordingExecutor(["usine-worker-1"], recovered));
          const firstScope = yield* Scope.make();
          const context = yield* Scope.provide(Layer.build(switched), firstScope).pipe(
            Effect.provide(Logger.layer([logger])),
          );
          assert.deepStrictEqual(yield* Ref.get(recovered), []);
          assert.strictEqual(warnings.length, 1);
          assert.match(warnings[0] ?? "", /"attempts":1,"workers":"local"/u);
          const engine = Context.get(context, RunEngine);
          const reader = Context.get(context, RunReader);
          assert.deepStrictEqual(
            (yield* reader.attemptsByWorker()).map(({ worker, attempts }) => [worker, attempts]),
            [["local", 1]],
          );
          // A configured Worker's Attempts stay reconciled at every start.
          assert.strictEqual(yield* engine.discardLeftovers(WorkerName.make("usine-worker-1")), 0);
          assert.strictEqual(yield* engine.discardLeftovers(WorkerName.make("local")), 1);
          assert.deepStrictEqual(yield* reader.attemptsByWorker(), []);
          yield* Scope.close(firstScope, Exit.void);

          // Configuring `local` again does not bring the discarded Attempt back.
          const secondScope = yield* Scope.make();
          yield* Scope.provide(
            Layer.build(engineLayer(directory, recordingExecutor(["local"], recovered))),
            secondScope,
          );
          assert.deepStrictEqual(yield* Ref.get(recovered), []);
          yield* Scope.close(secondScope, Exit.void);
        }),
      ),
  );

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

  it.live("starts an approved Run whose approval committed just before a crash", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          Effect.succeed(stepResult("approved before the crash")),
        ]);
        const gated = submission({ number: 51, approval: "required" });
        const runId = yield* runIdFor(gated);
        yield* committedBeforeCrash(directory, (store) =>
          Effect.gen(function* () {
            yield* store.recordAndClaim(gated, runId);
            yield* store.parkForApproval(runId);
            yield* store.approve(runId, approvalEvent(51), uiApproval);
          }),
        );
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const finished = yield* waitFor(
            engine,
            runId,
            ({ run }) => run.state._tag === "Succeeded",
          );
          assert.strictEqual(finished.attempts.length, 1);
        }).pipe(Effect.provide(engineLayer(directory, executorLayer(plans))));
      }),
    ),
  );

  it.live("starts the next Attempt of a Run whose retry committed just before a crash", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          Effect.succeed(stepResult("retried after the crash")),
        ]);
        const failing = submission({ number: 52 });
        const runId = yield* runIdFor(failing);
        yield* committedBeforeCrash(directory, (store) =>
          Effect.gen(function* () {
            yield* store.recordAndClaim(failing, runId);
            const started = yield* store.beginAttempt(
              runId,
              WorkerName.make("local"),
              Option.none(),
            );
            assert(started._tag === "AttemptStarted");
            yield* store.finishAttempt(
              started.execution.attempt,
              Result.fail(new AgentFailure({ message: "needs the operator" })),
            );
            yield* store.retry(runId);
          }),
        );
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const finished = yield* waitFor(
            engine,
            runId,
            ({ run }) => run.state._tag === "Succeeded",
          );
          assert.deepStrictEqual(
            finished.attempts.map(({ number }) => number),
            [1, 2],
          );
        }).pipe(Effect.provide(engineLayer(directory, executorLayer(plans))));
      }),
    ),
  );

  it.live(
    "finishes a Run's closing after a crash: an owed retry starts and the queued Event opens",
    () =>
      withInstance((directory) =>
        Effect.gen(function* () {
          const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
            Effect.succeed(stepResult("owed retry")),
            Effect.succeed(stepResult("queued Event")),
          ]);
          const retrying = submission({ number: 53, item: "owed-retry" });
          const closed = submission({ number: 54, item: "closed-before-crash" });
          const queued = submission({ number: 55, item: "closed-before-crash" });
          const retryingRunId = yield* runIdFor(retrying);
          const closedRunId = yield* runIdFor(closed);
          const queuedRunId = yield* runIdFor(queued);
          yield* committedBeforeCrash(directory, (store) =>
            Effect.gen(function* () {
              // The first Attempt settled with an automatic retry still owed.
              yield* store.recordAndClaim(retrying, retryingRunId);
              const interrupted = yield* store.beginAttempt(
                retryingRunId,
                WorkerName.make("local"),
                Option.none(),
              );
              assert(interrupted._tag === "AttemptStarted");
              const decision = yield* store.finishAttempt(
                interrupted.execution.attempt,
                Result.fail(new InfraFailure({ message: "worker lost", cause: "test" })),
              );
              assert.strictEqual(decision._tag, "RetryAttempt");
              // This Run closed with an Event queued behind it, before its continuation ran.
              yield* store.recordAndClaim(closed, closedRunId);
              const started = yield* store.beginAttempt(
                closedRunId,
                WorkerName.make("local"),
                Option.none(),
              );
              assert(started._tag === "AttemptStarted");
              const waiting = yield* store.recordAndClaim(queued, queuedRunId);
              assert.strictEqual(waiting.result._tag, "Queued");
              yield* store.finishAttempt(
                started.execution.attempt,
                Result.succeed(stepResult("closed before the crash")),
              );
            }),
          );
          yield* Effect.gen(function* () {
            const engine = yield* RunEngine;
            const retried = yield* waitFor(
              engine,
              retryingRunId,
              ({ run }) => run.state._tag === "Succeeded",
            );
            assert.deepStrictEqual(
              retried.attempts.map(({ number }) => number),
              [1, 2],
            );
            const opened = yield* waitFor(
              engine,
              queuedRunId,
              ({ run }) => run.state._tag === "Succeeded",
            );
            assert.strictEqual(opened.attempts.length, 1);
          }).pipe(Effect.provide(engineLayer(directory, executorLayer(plans))));
        }),
      ),
  );
});
