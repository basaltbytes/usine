import { assert, describe, it } from "@effect/vitest";
import type { Attempt, AttemptId, StopReason } from "@usine/core/attempt";
import { AgentFailure, type AttemptFailure, InfraFailure } from "@usine/core/attempt/failure";
import { type AttemptRecovery, SalvagePushed } from "@usine/core/attempt/salvage";
import type { InstanceDirectory } from "@usine/core/instance";
import { CommitSha } from "@usine/core/repository";
import type { RunId } from "@usine/core/run";
import { Comment, type StepResult } from "@usine/core/step/result";
import { WorkerName } from "@usine/core/worker";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Logger,
  Option,
  Ref,
  Result,
  Schedule,
  Scope,
  TxRef,
} from "effect";
import {
  LeftoversDiscardRejectedError,
  ReconcileInterval,
  RunEngine,
  UnconfirmedStop,
  UnconfirmedStops,
} from "../src/engine/engine.ts";
import { runIdFor, type Submission } from "../src/engine/submission.ts";
import { RunReader } from "../src/run-reader/run-reader.ts";
import { StepExecutor } from "../src/step-executor.ts";
import {
  approvalEvent,
  uiApproval,
  type AttemptPlan,
  committedBeforeCrash,
  engineLayer,
  executorLayer,
  slottedExecutor,
  stepResult,
  submission,
  waitFor,
  withInstance,
} from "./support.ts";

const POSTED_COMMENT = "https://github.com/acme/demo/issues/57#issuecomment-1";

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

/** Returns a restarted runtime's executor that runs `workers`, starts nothing, and records each `recover` call. */
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
    occupy: () => Effect.die("no open Attempt survives the restart"),
    sweep: Effect.void,
    execute: () => Effect.die("no Attempt starts after the restart"),
  });

/** Starts the first Attempt of each submission, then stops the runtime while their parent tasks run. */
const stopDuringAttempts = (directory: InstanceDirectory, submissions: ReadonlyArray<Submission>) =>
  Effect.gen(function* () {
    const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>(submissions.map(() => Effect.never));
    const scope = yield* Scope.make();
    const engine = Context.get(
      yield* Scope.provide(Layer.build(engineLayer(directory, executorLayer(plans))), scope),
      RunEngine,
    );
    const running = yield* Effect.forEach(submissions, (pending) =>
      Effect.gen(function* () {
        const accepted = yield* engine.submit(pending);
        assert(accepted._tag === "Claimed");
        const started = yield* waitFor(
          engine,
          accepted.runId,
          ({ attempts }) => attempts.length === 1,
        );
        return started.attempts;
      }),
    );
    yield* Scope.close(scope, Exit.void);
    return running.flat();
  });

/**
 * Returns a fake `StepExecutor` for a restarted runtime, controlled through `state`.
 *
 * - `live`: Attempts whose parent task is live; Worker `local` has one slot per such Attempt.
 * - `unreadable`: Attempts whose liveness can't be read.
 * - `unstoppable`: Attempts whose parent task can't be stopped; `recover` and `interrupt` fail
 *   without touching the checkout and add them to `refused`.
 * - `stalled`: reattached Attempts that never acquire their checkout.
 * - `unprepared`: reattached Attempts that fail before acquiring their checkout.
 * - `running`: reattached Attempts that acquire their checkout, are added to `acquired`, and run
 *   until interrupted.
 * - `gate`: until it opens, a Run waits before reading its Attempt again and before a Worker.
 * - `leased`: the number of occupied slots, counted as the scheduler does.
 *
 * Every reconciled checkout becomes a pushed salvage, and an open Attempt whose parent failed
 * records the comment it posted.
 */
const restartedExecutor = Effect.fn("test.restartedExecutor")(function* (
  live: ReadonlyArray<Attempt>,
) {
  const state = {
    live: yield* Ref.make<ReadonlySet<AttemptId>>(new Set(live.map(({ id }) => id))),
    unreadable: yield* Ref.make<ReadonlySet<AttemptId>>(new Set()),
    unstoppable: yield* Ref.make<ReadonlySet<AttemptId>>(new Set()),
    refused: yield* Ref.make<ReadonlyArray<AttemptId>>([]),
    stored: yield* Ref.make<ReadonlyMap<AttemptId, Result.Result<StepResult, AttemptFailure>>>(
      new Map(),
    ),
    reconciled: yield* Ref.make<ReadonlyArray<AttemptRecovery>>([]),
    resumed: yield* Ref.make<ReadonlyMap<RunId, Option.Option<SalvagePushed>>>(new Map()),
    stalled: yield* Ref.make<ReadonlySet<AttemptId>>(new Set()),
    unprepared: yield* Ref.make<ReadonlySet<AttemptId>>(new Set()),
    running: yield* Ref.make<ReadonlySet<AttemptId>>(new Set()),
    acquired: yield* Ref.make<ReadonlySet<AttemptId>>(new Set()),
    read: yield* Ref.make<ReadonlySet<AttemptId>>(new Set()),
    gate: yield* Deferred.make<void>(),
    leased: yield* TxRef.make(0),
  };
  const lease = {
    worker: WorkerName.make("local"),
    release: TxRef.update(state.leased, (count) => count - 1),
  };
  const freeSlot = Effect.tx(
    Effect.gen(function* () {
      const count = yield* TxRef.get(state.leased);
      if (count >= live.length) return yield* Effect.txRetry;
      yield* TxRef.set(state.leased, count + 1);
    }),
  );
  const stop = (attemptId: AttemptId) =>
    Effect.gen(function* () {
      if ((yield* Ref.get(state.unstoppable)).has(attemptId)) {
        yield* Ref.update(state.refused, (ids) => [...ids, attemptId]);
        return yield* new InfraFailure({
          message: "Could not cancel the parent task",
          cause: "storage unavailable",
        });
      }
      yield* Ref.update(state.live, (ids) => new Set([...ids].filter((id) => id !== attemptId)));
    });
  const executor = Layer.succeed(StepExecutor)({
    workers: Effect.succeed([WorkerName.make("local")]),
    isLive: (attemptId) =>
      Effect.gen(function* () {
        // Startup reads each open Attempt before its Run does.
        const byRun = yield* Ref.modify(state.read, (ids) => [
          ids.has(attemptId),
          new Set(ids).add(attemptId),
        ]);
        if (byRun) yield* Deferred.await(state.gate);
        if ((yield* Ref.get(state.unreadable)).has(attemptId))
          return yield* new InfraFailure({
            message: "Could not read the parent task",
            cause: "storage unavailable",
          });
        return (yield* Ref.get(state.live)).has(attemptId);
      }),
    outcome: (attemptId) =>
      Ref.get(state.stored).pipe(
        Effect.map((results) => Option.fromUndefinedOr(results.get(attemptId))),
      ),
    recover: (attempt, record) =>
      Effect.gen(function* () {
        yield* stop(attempt.attemptId);
        yield* Ref.update(state.reconciled, (seen) => [...seen, attempt]);
        const stored = (yield* Ref.get(state.stored)).get(attempt.attemptId);
        if (attempt.open && stored !== undefined && Result.isFailure(stored))
          yield* record.comments([
            new Comment({ url: new URL(POSTED_COMMENT), kind: "issue-comment", at: Option.none() }),
          ]);
        yield* record.salvage(
          new SalvagePushed({ ref: attempt.ref, commit: CommitSha.make("a".repeat(40)) }),
        );
      }),
    intervene: () => Effect.void,
    interrupt: stop,
    reserve: () => Deferred.await(state.gate).pipe(Effect.andThen(freeSlot), Effect.as(lease)),
    occupy: () => TxRef.update(state.leased, (count) => count + 1).pipe(Effect.as(lease)),
    sweep: Effect.void,
    execute: (execution, io) =>
      Effect.gen(function* () {
        const { id } = execution.attempt;
        yield* Ref.update(state.resumed, (seen) =>
          new Map(seen).set(execution.run.id, execution.resume),
        );
        if ((yield* Ref.get(state.stalled)).has(id)) return yield* Effect.never;
        if ((yield* Ref.get(state.unprepared)).has(id))
          return yield* new InfraFailure({
            message: "The reattached Attempt's credential could not be issued",
            cause: "credential unavailable",
          });
        yield* io.checkoutAcquired;
        if ((yield* Ref.get(state.running)).has(id)) {
          yield* Ref.update(state.acquired, (ids) => new Set(ids).add(id));
          return yield* Effect.never;
        }
        return stepResult("resumed from the salvage");
      }),
  });
  return { ...state, executor };
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
        assert.deepStrictEqual(
          repaired.attempts.map(({ start }) => Option.map(start, ({ _tag }) => _tag)),
          [Option.some("Event"), Option.some("AfterRestart")],
        );
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

  it.live(
    "sweeps the Workers' resources after startup recovery reconciles the earlier Attempts",
    () =>
      withInstance((directory) =>
        Effect.gen(function* () {
          const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([Effect.never]);
          const firstScope = yield* Scope.make();
          const first = Context.get(
            yield* Scope.provide(
              Layer.build(engineLayer(directory, executorLayer(plans))),
              firstScope,
            ),
            RunEngine,
          );
          const accepted = yield* first.submit(submission({ number: 12 }));
          assert(accepted._tag === "Claimed");
          yield* waitFor(first, accepted.runId, ({ run }) => run.state._tag === "Running");
          yield* Scope.close(firstScope, Exit.void);

          const order = yield* Ref.make<ReadonlyArray<string>>([]);
          const recorded = (step: string) => Ref.update(order, (steps) => [...steps, step]);
          const scripted = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
            Effect.succeed(stepResult("after the restart")),
          ]);
          const base = Context.get(yield* Layer.build(executorLayer(scripted)), StepExecutor);
          const restarted = Layer.succeed(StepExecutor)({
            ...base,
            recover: (attempt) => recorded(`recover ${attempt.attemptId}`),
            sweep: recorded("sweep"),
          });
          const secondScope = yield* Scope.make();
          yield* Scope.provide(Layer.build(engineLayer(directory, restarted)), secondScope);
          const steps = yield* Ref.get(order);
          const firstSweep = steps.indexOf("sweep");
          assert.isAtLeast(firstSweep, 1, "startup sweeps");
          assert.isTrue(
            steps.slice(0, firstSweep).some((step) => step.startsWith("recover ")),
            "the sweep runs after the recovery of the earlier Attempt",
          );
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
          occupy: (worker) => Effect.succeed({ worker, release: Effect.void }),
          sweep: Effect.void,
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
        assert.deepStrictEqual(
          Option.map(started.start, ({ _tag }) => _tag),
          Option.some("Event"),
        );
        assert(Option.isSome(started.reattachedAt));
        assert.deepStrictEqual(yield* Ref.get(executions), [
          [started.id, false],
          [started.id, true],
        ]);
        yield* Scope.close(secondScope, Exit.void);
      }),
    ),
  );

  it.live(
    "occupies a slot of each live Attempt's own Worker before any Run reads it, so a Run that arrives first waits",
    () =>
      withInstance((directory) =>
        Effect.gen(function* () {
          const local = WorkerName.make("local");
          const spare = WorkerName.make("spare");
          const onLocal = submission({ number: 30, item: "live-on-local" });
          const onSpare = submission({ number: 31, item: "live-on-spare" });
          const third = submission({ number: 32, item: "after-the-restart" });
          // Before the restart, each Run's first Attempt starts on its own Worker and keeps running.
          const firstScope = yield* Scope.make();
          const firstEngine = Context.get(
            yield* Scope.provide(
              Layer.build(
                engineLayer(
                  directory,
                  Layer.succeed(StepExecutor)({
                    workers: Effect.succeed([local, spare]),
                    isLive: () => Effect.succeed(false),
                    outcome: () => Effect.succeed(Option.none()),
                    recover: () => Effect.void,
                    intervene: () => Effect.void,
                    interrupt: () => Effect.void,
                    occupy: () => Effect.die("no open Attempt survives into the first runtime"),
                    sweep: Effect.void,
                    reserve: (_, { itemKey }) =>
                      Effect.succeed({
                        worker: itemKey === onLocal.itemKey ? local : spare,
                        release: Effect.void,
                      }),
                    execute: () => Effect.never,
                  }),
                ),
              ),
              firstScope,
            ),
            RunEngine,
          );
          const live = yield* Effect.forEach([onLocal, onSpare], (pending) =>
            Effect.gen(function* () {
              const accepted = yield* firstEngine.submit(pending);
              assert(accepted._tag === "Claimed");
              const [started] = (yield* waitFor(
                firstEngine,
                accepted.runId,
                ({ attempts }) => attempts.length === 1,
              )).attempts;
              assert(started !== undefined);
              return started;
            }),
          );
          assert.deepStrictEqual(
            live.map(({ worker }) => worker),
            [local, spare],
          );
          const [liveOnLocal, liveOnSpare] = live;
          assert(liveOnLocal !== undefined && liveOnSpare !== undefined);
          yield* Scope.close(firstScope, Exit.void);

          // After it, each Worker has one slot. As the scheduler does, `occupy`
          // counts an Attempt that already runs on a Worker at once, a
          // reservation that names a Worker waits for a free slot of it, and
          // one that names none takes the first free slot.
          const leased = yield* TxRef.make<ReadonlyMap<WorkerName, number>>(
            new Map([
              [local, 0],
              [spare, 0],
            ]),
          );
          const counted = (worker: WorkerName, change: number) =>
            TxRef.update(leased, (counts) =>
              new Map(counts).set(worker, (counts.get(worker) ?? 0) + change),
            );
          const leaseOn = (worker: WorkerName) => ({ worker, release: counted(worker, -1) });
          const freeSlot = (worker: Option.Option<WorkerName>) =>
            Effect.tx(
              Effect.gen(function* () {
                const counts = yield* TxRef.get(leased);
                const free = [local, spare].filter((name) => (counts.get(name) ?? 0) < 1);
                const slot = Option.match(worker, {
                  onNone: () => free[0],
                  onSome: (name) => free.find((candidate) => candidate === name),
                });
                if (slot === undefined) return yield* Effect.txRetry;
                yield* counted(slot, 1);
                return slot;
              }),
            );
          // Startup reads each open Attempt at once; the Runs' own reads wait for `read`.
          const liveIds = new Set(live.map(({ id }) => id));
          const readAtStartup = yield* Ref.make<ReadonlySet<AttemptId>>(new Set());
          const read = yield* Deferred.make<void>();
          const reattached = yield* Ref.make<ReadonlyArray<AttemptId>>([]);
          const finish = yield* Deferred.make<void>();
          const restarted = Layer.succeed(StepExecutor)({
            workers: Effect.succeed([local, spare]),
            isLive: (attemptId) =>
              Ref.modify(readAtStartup, (ids) => [
                ids.has(attemptId),
                new Set(ids).add(attemptId),
              ]).pipe(
                Effect.flatMap((byRun) => (byRun ? Deferred.await(read) : Effect.void)),
                Effect.as(liveIds.has(attemptId)),
              ),
            outcome: () => Effect.succeed(Option.none()),
            recover: () => Effect.void,
            intervene: () => Effect.void,
            interrupt: () => Effect.void,
            occupy: (worker) => counted(worker, 1).pipe(Effect.as(leaseOn(worker))),
            sweep: Effect.void,
            reserve: (_, __, worker) => freeSlot(worker).pipe(Effect.map(leaseOn)),
            execute: (execution, io) =>
              Effect.gen(function* () {
                yield* io.checkoutAcquired;
                if (execution.reattach) {
                  yield* Ref.update(reattached, (ids) => [...ids, execution.attempt.id]);
                  yield* Deferred.await(finish);
                }
                return stepResult("finished after the restart");
              }),
          });
          const secondScope = yield* Scope.make();
          const secondEngine = Context.get(
            yield* Scope.provide(Layer.build(engineLayer(directory, restarted)), secondScope),
            RunEngine,
          );
          // Neither Run has read its Attempt yet, and each Attempt occupies a slot on its own Worker.
          assert.deepStrictEqual(
            yield* TxRef.get(leased),
            new Map([
              [local, 1],
              [spare, 1],
            ]),
          );

          // A new Run waits instead of starting an Attempt on a Worker that runs one.
          const accepted = yield* secondEngine.submit(third);
          assert(accepted._tag === "Claimed");
          yield* Effect.sleep("50 millis");
          assert.deepStrictEqual((yield* secondEngine.inspect(accepted.runId)).attempts, []);

          // Canceling the Run of the Attempt on `spare` before it reads that
          // Attempt releases its slot, and the waiting Run takes it.
          yield* secondEngine.cancel(liveOnSpare.runId);
          const delivered = yield* waitFor(
            secondEngine,
            accepted.runId,
            ({ run }) => run.state._tag === "Succeeded",
          );
          assert.deepStrictEqual(
            delivered.attempts.map(({ worker }) => worker),
            [spare],
          );

          // The other Run reattaches its Attempt in the slot startup occupied on `local`.
          yield* Deferred.succeed(read, undefined);
          yield* Effect.repeat(Ref.get(reattached), {
            until: (ids) => ids.length === 1,
            schedule: Schedule.spaced("10 millis"),
          });
          assert.deepStrictEqual(yield* Ref.get(reattached), [liveOnLocal.id]);
          assert.strictEqual((yield* TxRef.get(leased)).get(local), 1);
          yield* Deferred.succeed(finish, undefined);
          const [attempt, ...later] = (yield* waitFor(
            secondEngine,
            liveOnLocal.runId,
            ({ run }) => run.state._tag === "Succeeded",
          )).attempts;
          assert(attempt !== undefined && later.length === 0);
          assert.strictEqual(attempt.worker, local);
          assert(Option.isSome(attempt.reattachedAt));
          const canceled = yield* secondEngine.inspect(liveOnSpare.runId);
          assert.strictEqual(canceled.run.state._tag, "Canceled");
          assert.lengthOf(canceled.attempts, 1);
          yield* Scope.close(secondScope, Exit.void);
          assert.deepStrictEqual(
            yield* TxRef.get(leased),
            new Map([
              [local, 0],
              [spare, 0],
            ]),
          );
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
            // Reconciliation records the comment the Attempt whose parent failed posted on its Item.
            recover: (attempt, record) =>
              Ref.get(stored).pipe(
                Effect.flatMap((results) => {
                  const result = results.get(attempt.attemptId);
                  return attempt.open && result !== undefined && Result.isFailure(result)
                    ? record.comments([
                        new Comment({
                          url: new URL(POSTED_COMMENT),
                          kind: "issue-comment",
                          at: Option.none(),
                        }),
                      ])
                    : Effect.void;
                }),
              ),
            intervene: () => Effect.void,
            interrupt: () => Effect.void,
            occupy: (worker) => Effect.succeed({ worker, release: Effect.void }),
            sweep: Effect.void,
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
          assert.deepStrictEqual(
            failure.attempts[0]?.comments.map(({ url }) => url.href),
            [POSTED_COMMENT],
          );
          assert.deepStrictEqual(success.attempts[0]?.comments, []);
          assert.strictEqual(yield* Ref.get(executions), 2);
          yield* Scope.close(secondScope, Exit.void);
        }),
      ),
  );

  it.live(
    "reconciles the checkout a restart kept for an Attempt that no execution acquires, before the next Attempt starts",
    () =>
      withInstance((directory) =>
        Effect.gen(function* () {
          const [gone, failed, unread, unprepared] = yield* stopDuringAttempts(directory, [
            submission({ number: 20, item: "kept-then-gone" }),
            submission({ number: 21, item: "kept-then-failed" }),
            submission({ number: 23, item: "kept-then-unread" }),
            submission({ number: 24, item: "kept-then-unprepared" }),
          ]);
          assert(
            gone !== undefined &&
              failed !== undefined &&
              unread !== undefined &&
              unprepared !== undefined,
          );
          const worker = yield* restartedExecutor([gone, failed, unread, unprepared]);
          const scope = yield* Scope.make();
          const engine = Context.get(
            yield* Scope.provide(Layer.build(engineLayer(directory, worker.executor)), scope).pipe(
              Effect.provideService(ReconcileInterval, "50 millis"),
            ),
            RunEngine,
          );
          assert.deepStrictEqual(yield* Ref.get(worker.reconciled), []);

          // Before the Runs read their Attempts, one parent task is gone and
          // another failed. The third still runs, but its Run cannot read that, and
          // its parent task cannot be stopped yet. The fourth Run reattaches
          // its Attempt, whose execution fails before it acquires the checkout.
          yield* Ref.set(worker.live, new Set([unread.id, unprepared.id]));
          yield* Ref.set(worker.unprepared, new Set([unprepared.id]));
          yield* Ref.set(worker.unreadable, new Set([unread.id]));
          yield* Ref.set(worker.unstoppable, new Set([unread.id]));
          yield* Ref.set(
            worker.stored,
            new Map([[failed.id, Result.fail(new AgentFailure({ message: "failed unattached" }))]]),
          );
          yield* Deferred.succeed(worker.gate, undefined);

          // While its parent task may still write to the checkout, the Run
          // reconciles nothing and starts no next Attempt. The next reconcile
          // drives the Run again, and it tries the stop once more.
          const [refused, waiting] = yield* Effect.repeat(
            Effect.all([Ref.get(worker.refused), engine.inspect(unread.runId)]),
            {
              until: ([ids, { attempts }]) => ids.length >= 2 || attempts.length > 1,
              schedule: Schedule.spaced("10 millis"),
            },
          );
          assert.deepStrictEqual(refused.slice(0, 2), [unread.id, unread.id]);
          assert.deepStrictEqual(
            waiting.attempts.map(({ outcome, salvage }) => [outcome, salvage]),
            [[Option.none(), Option.none()]],
          );
          assert(
            !(yield* Ref.get(worker.reconciled)).some(({ attemptId }) => attemptId === unread.id),
          );
          yield* Ref.set(worker.unstoppable, new Set());

          for (const kept of [gone, unread, unprepared]) {
            const resumed = yield* waitFor(
              engine,
              kept.runId,
              ({ run }) => run.state._tag === "Succeeded",
            );
            const [interrupted] = resumed.attempts;
            assert(interrupted !== undefined && Option.isSome(interrupted.salvage));
            assert(interrupted.salvage.value._tag === "Pushed");
            assert.deepStrictEqual(
              (yield* Ref.get(worker.resumed)).get(kept.runId),
              Option.some(interrupted.salvage.value),
            );
          }
          const stopped = yield* waitFor(
            engine,
            failed.runId,
            ({ run }) => run.state._tag === "Failed",
          );
          assert.deepStrictEqual(
            stopped.attempts.map(({ salvage }) => Option.map(salvage, ({ _tag }) => _tag)),
            [Option.some("Pushed")],
          );
          assert.deepStrictEqual(
            stopped.attempts[0]?.comments.map(({ url }) => url.href),
            [POSTED_COMMENT],
          );
          yield* Scope.close(scope, Exit.void);
        }),
      ),
  );

  it.live(
    "reconciles the checkout a restart kept for an Attempt whose Run is canceled before an execution acquires it",
    () =>
      withInstance((directory) =>
        Effect.gen(function* () {
          const [waiting, preparing] = yield* stopDuringAttempts(directory, [
            submission({ number: 22, item: "kept-then-canceled" }),
            submission({ number: 25, item: "kept-then-canceled-while-preparing" }),
          ]);
          assert(waiting !== undefined && preparing !== undefined);
          // Until `gate` opens, the restarted Runs don't read their Attempts, which wait to be reattached.
          const worker = yield* restartedExecutor([waiting, preparing]);
          const scope = yield* Scope.make();
          const engine = Context.get(
            yield* Scope.provide(Layer.build(engineLayer(directory, worker.executor)), scope),
            RunEngine,
          );
          assert.deepStrictEqual(yield* Ref.get(worker.reconciled), []);
          const canceledWithSalvage = (runId: RunId) =>
            Effect.gen(function* () {
              yield* engine.cancel(runId);
              const canceled = yield* engine.inspect(runId);
              assert.strictEqual(canceled.run.state._tag, "Canceled");
              assert.deepStrictEqual(
                canceled.attempts.map(({ outcome, salvage }) => [
                  Option.map(outcome, ({ _tag }) => _tag),
                  Option.map(salvage, ({ _tag }) => _tag),
                ]),
                [[Option.some("Canceled"), Option.some("Pushed")]],
              );
            });

          yield* canceledWithSalvage(waiting.runId);
          assert.deepStrictEqual(
            (yield* Ref.get(worker.reconciled)).map(({ attemptId }) => attemptId),
            [waiting.id],
          );

          // The other Run reads its Attempt and reattaches it, and the
          // execution has not acquired the checkout when the Run is canceled.
          yield* Ref.set(worker.stalled, new Set([preparing.id]));
          yield* Deferred.succeed(worker.gate, undefined);
          yield* Effect.repeat(Ref.get(worker.resumed), {
            until: (seen) => seen.has(preparing.runId),
            schedule: Schedule.spaced("10 millis"),
          });
          yield* canceledWithSalvage(preparing.runId);
          assert.deepStrictEqual(
            (yield* Ref.get(worker.reconciled)).map(({ attemptId }) => attemptId),
            [waiting.id, preparing.id],
          );
          yield* Scope.close(scope, Exit.void);
        }),
      ),
  );

  it.live(
    "keeps a surviving Attempt's slot until its parent task is confirmed stopped, so no new Attempt takes it",
    () =>
      withInstance((directory) =>
        Effect.gen(function* () {
          const [unread, unprepared, canceled] = yield* stopDuringAttempts(directory, [
            submission({ number: 26, item: "kept-unread-unstoppable" }),
            submission({ number: 27, item: "kept-unprepared-unstoppable" }),
            submission({ number: 28, item: "kept-canceled-unstoppable" }),
          ]);
          assert(unread !== undefined && unprepared !== undefined && canceled !== undefined);
          // `local` has three slots, and startup occupies one for each surviving Attempt.
          const worker = yield* restartedExecutor([unread, unprepared, canceled]);
          const scope = yield* Scope.make();
          const engine = Context.get(
            yield* Scope.provide(Layer.build(engineLayer(directory, worker.executor)), scope).pipe(
              Effect.provideService(ReconcileInterval, "50 millis"),
            ),
            RunEngine,
          );
          assert.strictEqual(yield* TxRef.get(worker.leased), 3);
          const fresh = yield* engine.submit(submission({ number: 29, item: "after-the-restart" }));
          assert(fresh._tag === "Claimed");

          // Every parent task still runs, and none can be stopped yet. The
          // first Run cannot read whether its Attempt is live. The second
          // reattaches its Attempt, whose execution fails before it acquires
          // the checkout. The third reattaches its Attempt, whose execution
          // stalls until the operator cancels the Run.
          yield* Ref.set(worker.unreadable, new Set([unread.id]));
          yield* Ref.set(worker.unprepared, new Set([unprepared.id]));
          yield* Ref.set(worker.stalled, new Set([canceled.id]));
          yield* Ref.set(worker.unstoppable, new Set([unread.id, unprepared.id, canceled.id]));
          yield* Deferred.succeed(worker.gate, undefined);
          yield* Effect.repeat(Ref.get(worker.resumed), {
            until: (seen) => seen.has(canceled.runId),
            schedule: Schedule.spaced("10 millis"),
          });
          const refusal = yield* Effect.flip(engine.cancel(canceled.runId));
          assert.strictEqual(refusal._tag, "AttemptCancellationError");
          yield* Effect.repeat(Ref.get(worker.refused), {
            until: (ids) => ids.includes(unread.id) && ids.includes(unprepared.id),
            schedule: Schedule.spaced("10 millis"),
          });

          // Each slot stays taken while its parent task may run, across the
          // reconciles that try each stop again, so the new Run waits.
          yield* Effect.sleep("150 millis");
          assert.deepStrictEqual((yield* engine.inspect(fresh.runId)).attempts, []);
          assert.strictEqual(yield* TxRef.get(worker.leased), 3);
          assert.deepStrictEqual(yield* Ref.get(worker.reconciled), []);

          // Once the stops are confirmed, each slot is released after its
          // checkout is reconciled, and every Run gets its turn.
          yield* Ref.set(worker.unstoppable, new Set());
          for (const kept of [unread, unprepared]) {
            const resumed = yield* waitFor(
              engine,
              kept.runId,
              ({ run }) => run.state._tag === "Succeeded",
            );
            assert.deepStrictEqual(
              resumed.attempts.map(({ salvage }) => Option.map(salvage, ({ _tag }) => _tag)),
              [Option.some("Pushed"), Option.none()],
            );
          }
          const delivered = yield* waitFor(
            engine,
            fresh.runId,
            ({ run }) => run.state._tag === "Succeeded",
          );
          assert.lengthOf(delivered.attempts, 1);
          const closed = yield* waitFor(engine, canceled.runId, ({ attempts }) =>
            attempts.every(({ salvage }) => Option.isSome(salvage)),
          );
          assert.deepStrictEqual(
            closed.attempts.map(({ outcome }) => Option.map(outcome, ({ _tag }) => _tag)),
            [Option.some("Canceled")],
          );
          yield* Effect.repeat(TxRef.get(worker.leased), {
            until: (count) => count === 0,
            schedule: Schedule.spaced("10 millis"),
          }).pipe(Effect.timeout("2 seconds"));
          yield* Scope.close(scope, Exit.void);
        }),
      ),
  );

  it.live(
    "keeps the slot of a canceled Attempt whose parent task outlives another restart until that task is confirmed stopped",
    () =>
      withInstance((directory) =>
        Effect.gen(function* () {
          const [canceled] = yield* stopDuringAttempts(directory, [
            submission({ number: 35, item: "canceled-unstoppable-then-restarted" }),
          ]);
          assert(canceled !== undefined);

          // After a first restart, the operator cancels the Run while it still
          // reads its Attempt, and the parent task cannot be stopped.
          const first = yield* restartedExecutor([canceled]);
          yield* Ref.set(first.unstoppable, new Set([canceled.id]));
          const firstScope = yield* Scope.make();
          const firstEngine = Context.get(
            yield* Scope.provide(Layer.build(engineLayer(directory, first.executor)), firstScope),
            RunEngine,
          );
          const refusal = yield* Effect.flip(firstEngine.cancel(canceled.runId));
          assert.strictEqual(refusal._tag, "AttemptCancellationError");
          assert.strictEqual(yield* TxRef.get(first.leased), 1);
          yield* Scope.close(firstScope, Exit.void);

          // The orchestrator restarts again. The parent task still runs on
          // `local`, which has one slot, and it still cannot be stopped.
          const second = yield* restartedExecutor([canceled]);
          yield* Ref.set(second.unstoppable, new Set([canceled.id]));
          const scope = yield* Scope.make();
          const engine = Context.get(
            yield* Scope.provide(Layer.build(engineLayer(directory, second.executor)), scope).pipe(
              Effect.provideService(ReconcileInterval, "50 millis"),
            ),
            RunEngine,
          );
          assert.strictEqual(yield* TxRef.get(second.leased), 1);
          const fresh = yield* engine.submit(
            submission({ number: 36, item: "after-the-second-restart" }),
          );
          assert(fresh._tag === "Claimed");
          yield* Deferred.succeed(second.gate, undefined);

          // The closed Attempt keeps its slot across the reconciles that try
          // the stop again, so the new Run waits.
          yield* Effect.repeat(Ref.get(second.refused), {
            until: (ids) => ids.length >= 3,
            schedule: Schedule.spaced("10 millis"),
          });
          assert.deepStrictEqual((yield* engine.inspect(fresh.runId)).attempts, []);
          assert.strictEqual(yield* TxRef.get(second.leased), 1);
          assert.deepStrictEqual(yield* Ref.get(second.reconciled), []);

          // Once the stop is confirmed, a reconcile salvages the checkout and
          // releases the slot, and the new Run takes it.
          yield* Ref.set(second.unstoppable, new Set());
          const delivered = yield* waitFor(
            engine,
            fresh.runId,
            ({ run }) => run.state._tag === "Succeeded",
          );
          assert.lengthOf(delivered.attempts, 1);
          assert.deepStrictEqual(
            (yield* engine.inspect(canceled.runId)).attempts.map(({ outcome, salvage }) => [
              Option.map(outcome, ({ _tag }) => _tag),
              Option.map(salvage, ({ _tag }) => _tag),
            ]),
            [[Option.some("Canceled"), Option.some("Pushed")]],
          );
          yield* Effect.repeat(TxRef.get(second.leased), {
            until: (count) => count === 0,
            schedule: Schedule.spaced("10 millis"),
          }).pipe(Effect.timeout("2 seconds"));
          yield* Scope.close(scope, Exit.void);
        }),
      ),
  );

  it.live(
    "keeps the slot of a reattached Attempt canceled after its execution acquired the checkout, across another restart, until its parent task is confirmed stopped",
    () =>
      withInstance((directory) =>
        Effect.gen(function* () {
          const local = WorkerName.make("local");
          const acquired = submission({ number: 37, item: "acquired-then-unstoppable" });
          const [canceled] = yield* stopDuringAttempts(directory, [acquired]);
          assert(canceled !== undefined);
          const unconfirmed = (reason: StopReason) => [
            new UnconfirmedStop({
              attemptId: canceled.id,
              runId: canceled.runId,
              loop: acquired.loop,
              itemKey: acquired.itemKey,
              worker: local,
              reason,
            }),
          ];
          const started = (executor: Layer.Layer<StepExecutor>, scope: Scope.Scope) =>
            Scope.provide(Layer.build(engineLayer(directory, executor)), scope).pipe(
              Effect.provideService(ReconcileInterval, "50 millis"),
              Effect.map((context) => ({
                engine: Context.get(context, RunEngine),
                stops: Context.get(context, UnconfirmedStops),
              })),
            );

          // After a first restart, `local` has one slot, which startup occupies for the live
          // Attempt. The Run reattaches it in that slot, and its execution acquires the checkout.
          const first = yield* restartedExecutor([canceled]);
          yield* Ref.set(first.running, new Set([canceled.id]));
          const firstScope = yield* Scope.make();
          const before = yield* started(first.executor, firstScope);
          const fresh = yield* before.engine.submit(
            submission({ number: 38, item: "after-the-unconfirmed-cancel" }),
          );
          assert(fresh._tag === "Claimed");
          yield* Deferred.succeed(first.gate, undefined);
          yield* Effect.repeat(Ref.get(first.acquired), {
            until: (ids) => ids.has(canceled.id),
            schedule: Schedule.spaced("10 millis"),
          });

          // The operator cancels the Run, and the parent task can't be stopped. The slot stays
          // taken across the reconciles that retry the stop, so the new Run waits.
          yield* Ref.set(first.unstoppable, new Set([canceled.id]));
          const refusal = yield* Effect.flip(before.engine.cancel(canceled.runId));
          assert.strictEqual(refusal._tag, "AttemptCancellationError");
          const [, waiting] = yield* Effect.repeat(
            Effect.all([Ref.get(first.refused), before.engine.inspect(fresh.runId)]),
            {
              until: ([ids, { attempts }]) => ids.length >= 3 || attempts.length > 0,
              schedule: Schedule.spaced("10 millis"),
            },
          );
          assert.deepStrictEqual(waiting.attempts, []);
          assert.strictEqual(yield* TxRef.get(first.leased), 1);
          assert.deepStrictEqual(yield* before.stops.list, unconfirmed("cancel"));
          yield* Scope.close(firstScope, Exit.void);

          // The orchestrator restarts again. The parent task still runs and still can't be
          // stopped, so startup occupies the slot for the closed Attempt.
          const second = yield* restartedExecutor([canceled]);
          yield* Ref.set(second.unstoppable, new Set([canceled.id]));
          const secondScope = yield* Scope.make();
          const after = yield* started(second.executor, secondScope);
          assert.strictEqual(yield* TxRef.get(second.leased), 1);
          assert.deepStrictEqual(yield* after.stops.list, unconfirmed("startup"));
          yield* Deferred.succeed(second.gate, undefined);
          const [, stillWaiting] = yield* Effect.repeat(
            Effect.all([Ref.get(second.refused), after.engine.inspect(fresh.runId)]),
            {
              until: ([ids, { attempts }]) => ids.length >= 3 || attempts.length > 0,
              schedule: Schedule.spaced("10 millis"),
            },
          );
          assert.deepStrictEqual(stillWaiting.attempts, []);
          assert.strictEqual(yield* TxRef.get(second.leased), 1);
          assert.deepStrictEqual(yield* Ref.get(second.reconciled), []);

          // Once a retry stops the parent task, the checkout is salvaged, the slot is released,
          // and the new Run takes it.
          yield* Ref.set(second.unstoppable, new Set());
          const delivered = yield* waitFor(
            after.engine,
            fresh.runId,
            ({ run }) => run.state._tag === "Succeeded",
          );
          assert.lengthOf(delivered.attempts, 1);
          assert.deepStrictEqual(
            (yield* after.engine.inspect(canceled.runId)).attempts.map(({ outcome, salvage }) => [
              Option.map(outcome, ({ _tag }) => _tag),
              Option.map(salvage, ({ _tag }) => _tag),
            ]),
            [[Option.some("Canceled"), Option.some("Pushed")]],
          );
          assert.deepStrictEqual(yield* after.stops.list, []);
          yield* Effect.repeat(TxRef.get(second.leased), {
            until: (count) => count === 0,
            schedule: Schedule.spaced("10 millis"),
          }).pipe(Effect.timeout("2 seconds"));
          yield* Scope.close(secondScope, Exit.void);
        }),
      ),
  );

  it.live.each([1, 2])(
    "keeps the slot of a failed Attempt whose parent task can't be stopped across a restart, and starts no retry on a Worker with %i slots, until a retried stop succeeds",
    (slots) =>
      withInstance((directory) =>
        Effect.gen(function* () {
          const started = (executor: Layer.Layer<StepExecutor>, scope: Scope.Scope) =>
            Scope.provide(Layer.build(engineLayer(directory, executor)), scope).pipe(
              Effect.provideService(ReconcileInterval, "50 millis"),
              Effect.map((context) => ({
                engine: Context.get(context, RunEngine),
                stops: Context.get(context, UnconfirmedStops),
              })),
            );

          // The first Attempt fails, and its parent task can't be stopped, so the Run starts no
          // retry, even in a free slot of `local`.
          const first = yield* slottedExecutor(
            [Effect.fail(new InfraFailure({ message: "Lost the parent task", cause: "offline" }))],
            slots,
          );
          yield* Ref.set(first.unstoppable, true);
          const firstScope = yield* Scope.make();
          const before = yield* started(first.executor, firstScope);
          const failing = submission({ number: 39, item: "failed-then-restarted" });
          const accepted = yield* before.engine.submit(failing);
          assert(accepted._tag === "Claimed");
          const [listed, { attempts }] = yield* Effect.repeat(
            Effect.all([before.stops.list, before.engine.inspect(accepted.runId)]),
            {
              until: ([stops, { attempts }]) =>
                stops.length > 0 && attempts.every(({ outcome }) => Option.isSome(outcome)),
              schedule: Schedule.spaced("10 millis"),
            },
          );
          const [failed] = attempts;
          assert(failed !== undefined);
          const unconfirmed = (reason: StopReason) => [
            new UnconfirmedStop({
              attemptId: failed.id,
              runId: accepted.runId,
              loop: failing.loop,
              itemKey: failing.itemKey,
              worker: WorkerName.make("local"),
              reason,
            }),
          ];
          assert.lengthOf(attempts, 1);
          assert.deepStrictEqual(listed, unconfirmed("failed"));
          assert.strictEqual(yield* TxRef.get(first.leased), 1);
          yield* Scope.close(firstScope, Exit.void);

          // After the restart, the parent task still can't be stopped, so startup occupies a
          // slot for the closed Attempt, and the Run still starts no retry.
          const second = yield* slottedExecutor(
            [Effect.succeed(stepResult("ran after the stop"))],
            slots,
          );
          yield* Ref.set(second.unstoppable, true);
          const secondScope = yield* Scope.make();
          const after = yield* started(second.executor, secondScope);
          assert.strictEqual(yield* TxRef.get(second.leased), 1);
          assert.deepStrictEqual(yield* after.stops.list, unconfirmed("startup"));
          const [stops, waiting] = yield* Effect.repeat(
            Effect.all([Ref.get(second.stops), after.engine.inspect(accepted.runId)]),
            {
              until: ([stops, { attempts }]) => stops.length >= 3 || attempts.length > 1,
              schedule: Schedule.spaced("10 millis"),
            },
          );
          assert.lengthOf(waiting.attempts, 1);
          assert.deepStrictEqual(new Set(stops.map(([, reason]) => reason)), new Set(["startup"]));
          assert.strictEqual(yield* TxRef.get(second.leased), 1);

          // Once a retry stops the parent task, the slot is released and the retry takes it.
          yield* Ref.set(second.unstoppable, false);
          const delivered = yield* waitFor(
            after.engine,
            accepted.runId,
            ({ run }) => run.state._tag === "Succeeded",
          );
          assert.lengthOf(delivered.attempts, 2);
          assert.deepStrictEqual(yield* after.stops.list, []);
          yield* Effect.repeat(TxRef.get(second.leased), {
            until: (count) => count === 0,
            schedule: Schedule.spaced("10 millis"),
          }).pipe(Effect.timeout("2 seconds"));
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
            (yield* reader.attemptsByWorker()).map(({ worker, attempts, running }) => [
              worker,
              attempts,
              running,
            ]),
            [["local", 1, 0]],
          );
          // A configured Worker's Attempts stay reconciled at every start.
          assert.deepStrictEqual(
            yield* Effect.flip(engine.discardLeftovers(WorkerName.make("usine-worker-1"))),
            new LeftoversDiscardRejectedError({
              worker: WorkerName.make("usine-worker-1"),
              running: 0,
            }),
          );
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
              // The first Attempt ended with an automatic retry still owed.
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
