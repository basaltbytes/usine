import { assert, describe, it } from "@effect/vitest";
import { UsineConfig } from "@usine/config/factory";
import { Attempt, AttemptId, AttemptNumber } from "@usine/core/attempt";
import { InfraFailure } from "@usine/core/attempt/failure";
import { Run, RunId } from "@usine/core/run";
import * as RunState from "@usine/core/run/state";
import { Step } from "@usine/core/step";
import {
  ContainerCpus,
  ContainerLimits,
  ContainerMemoryMib,
  ContainerPids,
  MachineId,
  WorkerName,
} from "@usine/core/worker";
import { StepExecution, StepExecutor } from "@usine/engine/step-executor";
import {
  Executor,
  ExecutorOperationError,
  fullPreflight,
  MachineCheck,
  MachineGrant,
  MachineHold,
  MachineStatus,
  MachineUnavailableError,
  WorkerMachines,
} from "@usine/executor";
import { Context, DateTime, Deferred, Effect, Fiber, Layer, Option, Ref, Schema } from "effect";
import { TestClock } from "effect/testing";
import { stepExecutorLayer } from "../src/scheduler.ts";
import { WorkerStatus } from "../src/worker-status.ts";
import { fixedConfigLayer } from "./support/current-instance.ts";
import { testAppLayer } from "./support/github-app.ts";
import { submission, testAgent } from "./local-worker/support.ts";

const POOL = WorkerName.make("pool");
const unused = () => Effect.die("unused");

const config = Schema.decodeUnknownSync(UsineConfig)({
  version: 1,
  repos: [{ name: "acme/demo" }],
  workers: [{ name: "pool", kind: "local", max_concurrent_attempts: 1 }],
});

/**
 * A fake `WorkerMachines` that records each call, fails the creations in `failures`, and gives
 * the next successful creations the machine checks in `checks`.
 */
const fakeMachines = () =>
  Effect.gen(function* () {
    const calls: Array<string> = [];
    const failures: Array<MachineUnavailableError> = [];
    const checks: Array<MachineCheck> = [];
    const gate = yield* Ref.make(Option.none<Deferred.Deferred<void>>());
    let next = 0;
    const machines = WorkerMachines.of({
      provisions: (worker) => Effect.succeed(worker === POOL),
      create: (worker, runId) =>
        Effect.gen(function* () {
          calls.push(`create ${worker} ${runId}`);
          const waiting = yield* Ref.get(gate);
          if (Option.isSome(waiting)) yield* Deferred.await(waiting.value);
          const failure = failures.shift();
          if (failure !== undefined) return yield* failure;
          next += 1;
          return new MachineGrant({
            hold: MachineHold.make(`hold-${String(next)}`),
            id: MachineId.make(String(100 + next)),
            worker,
            provider: "hetzner",
            checked: Option.fromNullishOr(checks.shift()),
          });
        }).pipe(Effect.onInterrupt(() => Effect.sync(() => calls.push(`interrupted ${runId}`)))),
      assign: (hold, attemptId) =>
        Effect.sync(() => void calls.push(`assign ${hold} ${attemptId}`)),
      adopt: (worker, attemptId) =>
        Effect.sync(() => {
          calls.push(`adopt ${worker} ${attemptId}`);
          return Option.some(MachineHold.make(`adopted-${attemptId}`));
        }),
      release: (hold) => Effect.sync(() => void calls.push(`release ${hold}`)),
      sweep: Effect.sync(() => void calls.push("sweep")),
      machines: Effect.succeed([
        new MachineStatus({
          worker: POOL,
          provider: "hetzner",
          state: "creating",
          id: Option.none(),
          runId: Option.some(RunId.make("run-1")),
          attemptId: Option.none(),
          since: DateTime.makeUnsafe(0),
        }),
      ]),
    });
    return { calls, failures, checks, gate, machines };
  });

const prepared: Array<AttemptId> = [];
let executorSweeps = 0;
const discarded: Array<string> = [];

const executor = Layer.succeed(Executor)({
  kind: "local",
  recover: unused,
  isLive: unused,
  outcome: unused,
  preflight: () => Effect.succeed(fullPreflight),
  prepare: (request) =>
    Effect.sync(() => prepared.push(request.attemptId)).pipe(
      Effect.andThen(
        Effect.fail(
          new ExecutorOperationError({
            operation: "prepare",
            message: "The test stops at preparation",
            cause: new Error("stop"),
          }),
        ),
      ),
    ),
  cancel: unused,
  intervene: unused,
  sweep: Effect.sync(() => {
    executorSweeps += 1;
  }),
});

const scheduler = (machines: WorkerMachines["Service"]) =>
  Layer.build(
    stepExecutorLayer(config, [], {
      machines,
      discard: (worker, attempts) =>
        Effect.sync(() => void discarded.push(`${worker} ${attempts.join(",")}`)),
    }).pipe(
      Layer.provide(executor),
      Layer.provide(fixedConfigLayer(config)),
      Layer.provide(testAppLayer),
    ),
  );

const executionOf = (runId: RunId, attemptId: AttemptId, reattach = false) => {
  const selected = submission(1);
  return new StepExecution({
    attempt: new Attempt({
      task: selected.task,
      agent: selected.agent.name,
      operatorIntervened: false,
      id: attemptId,
      runId,
      stepName: selected.step,
      worker: POOL,
      number: AttemptNumber.make(1),
      brain: testAgent.brain,
      parentModel: Option.none(),
      startedAt: selected.event.receivedAt,
      outcome: Option.none(),
      endedAt: Option.none(),
      salvage: Option.none(),
    }),
    event: selected.event,
    run: new Run({
      id: runId,
      eventId: selected.event.id,
      loop: selected.loop,
      state: RunState.start(new RunState.Pending()),
      openedAt: selected.event.receivedAt,
    }),
    step: new Step({ runId, name: selected.step, result: Option.none() }),
    repository: selected.repository,
    revision: selected.revision,
    task: selected.task,
    agent: selected.agent,
    parentModel: selected.parentModel,
    permissions: selected.permissions,
    resume: Option.none(),
    reattach,
  });
};

const sink = {
  append: () => Effect.void,
  salvage: () => Effect.void,
  comments: () => Effect.void,
  outOfMemory: () => Effect.void,
  transcript: Effect.succeed([]),
  windows: Effect.die("no windows"),
  checkoutAcquired: Effect.void,
};

/** Lets the scheduler's fibers run until they wait. */
const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, {
  discard: true,
});

describe("Worker scheduler on a provisioned Worker", () => {
  it.effect(
    "creates the machine before the lease, gives it to the Attempt, deletes it with the lease, and passes on sweeps and discards",
    () =>
      Effect.gen(function* () {
        const fake = yield* fakeMachines();
        const limits = new ContainerLimits({
          cpus: ContainerCpus.make(3.5),
          memoryMib: ContainerMemoryMib.make(7168),
          pids: ContainerPids.make(60976),
        });
        fake.checks.push(
          new MachineCheck({ brains: [testAgent.brain], containerLimits: Option.some(limits) }),
        );
        const context = yield* scheduler(fake.machines);
        const steps = Context.get(context, StepExecutor);
        const status = Context.get(context, WorkerStatus);
        const run = RunId.make("run-1");
        const lease = yield* steps.reserve(run, submission(1), Option.none());
        assert.strictEqual(lease.worker, POOL);
        assert.deepStrictEqual(fake.calls, [`create pool ${run}`]);
        assert.lengthOf(yield* status.machines, 1);
        // The first machine's check gives the Worker page the limits its containers get.
        const checked = (yield* status.preflights).find(({ worker }) => worker === POOL);
        assert.deepStrictEqual(checked?.containerLimits, Option.some(limits));

        const attempt = AttemptId.make("run-1/execute/1");
        const failure = yield* steps.execute(executionOf(run, attempt), sink).pipe(Effect.flip);
        assert(failure instanceof InfraFailure, failure._tag);
        assert.include(fake.calls, `assign hold-1 ${attempt}`);
        assert.include(prepared, attempt);

        yield* lease.release;
        assert.deepStrictEqual(fake.calls.at(-1), "release hold-1");
        // The slot is free again.
        const next = yield* steps.reserve(RunId.make("run-2"), submission(2), Option.none());
        assert.strictEqual(next.worker, POOL);
        const sweepsBefore = executorSweeps;
        yield* steps.sweep;
        assert.strictEqual(fake.calls.at(-1), "sweep");
        assert.strictEqual(executorSweeps, sweepsBefore + 1, "the executor sweeps its Workers too");
        yield* steps.discard(WorkerName.make("retired"), [attempt]);
        assert.deepStrictEqual(discarded, [`retired ${attempt}`]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "keeps the Run waiting after a failed creation, pauses the Worker, and creates again when the pause ends",
    () =>
      Effect.gen(function* () {
        const fake = yield* fakeMachines();
        fake.failures.push(
          new MachineUnavailableError({
            worker: POOL,
            provider: "hetzner",
            reason: "capacity",
            message: "This product is currently unavailable",
          }),
        );
        const context = yield* scheduler(fake.machines);
        const steps = Context.get(context, StepExecutor);
        const status = Context.get(context, WorkerStatus);
        const waiting = yield* Effect.forkChild(
          steps.reserve(RunId.make("run-1"), submission(1), Option.none()),
        );
        yield* settle;
        assert.isUndefined(waiting.pollUnsafe(), "the Run waits");
        const [pause] = yield* status.provisioning;
        assert(pause !== undefined, "the Worker is paused");
        assert.strictEqual(pause.reason, "capacity");
        assert.isTrue(pause.blocked);
        assert.strictEqual(pause.failures, 1);
        assert.strictEqual(
          DateTime.toEpochMillis(pause.retryAt) - DateTime.toEpochMillis(pause.failedAt),
          30_000,
        );
        const queued = yield* status.queue;
        assert.deepStrictEqual(
          queued.map(({ runId }) => runId),
          [RunId.make("run-1")],
          "the Run keeps its place in the queue",
        );

        yield* TestClock.adjust("29 seconds");
        yield* settle;
        assert.isUndefined(waiting.pollUnsafe(), "the Worker is still paused");
        yield* TestClock.adjust("1 second");
        yield* settle;
        const lease = yield* Fiber.join(waiting);
        assert.strictEqual(lease.worker, POOL);
        assert.lengthOf(
          fake.calls.filter((call) => call.startsWith("create")),
          2,
        );
        assert.lengthOf(yield* status.provisioning, 0, "a success ends the pause");
      }).pipe(Effect.scoped),
  );

  it.effect("doubles the pause after each failure in a row", () =>
    Effect.gen(function* () {
      const fake = yield* fakeMachines();
      const quota = new MachineUnavailableError({
        worker: POOL,
        provider: "hetzner",
        reason: "quota",
        message: "project limit exceeded",
      });
      fake.failures.push(quota, quota);
      const context = yield* scheduler(fake.machines);
      const steps = Context.get(context, StepExecutor);
      const status = Context.get(context, WorkerStatus);
      yield* Effect.forkChild(steps.reserve(RunId.make("run-1"), submission(1), Option.none()));
      yield* settle;
      yield* TestClock.adjust("30 seconds");
      yield* settle;
      const [pause] = yield* status.provisioning;
      assert.strictEqual(pause?.failures, 2);
      assert.strictEqual(
        pause === undefined
          ? 0
          : DateTime.toEpochMillis(pause.retryAt) - DateTime.toEpochMillis(pause.failedAt),
        60_000,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("stops the creation of a Run that stops waiting, and frees the slot", () =>
    Effect.gen(function* () {
      const fake = yield* fakeMachines();
      const gate = yield* Deferred.make<void>();
      yield* Ref.set(fake.gate, Option.some(gate));
      const context = yield* scheduler(fake.machines);
      const steps = Context.get(context, StepExecutor);
      const waiting = yield* Effect.forkChild(
        steps.reserve(RunId.make("run-1"), submission(1), Option.none()),
      );
      yield* settle;
      assert.deepStrictEqual(fake.calls, ["create pool run-1"]);
      yield* Fiber.interrupt(waiting);
      yield* settle;
      assert.include(fake.calls, "interrupted run-1");
      yield* Ref.set(fake.gate, Option.none());
      const next = yield* steps.reserve(RunId.make("run-2"), submission(2), Option.none());
      assert.strictEqual(next.worker, POOL, "the slot is free again");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "holds the machine of an Attempt that runs from before a restart, and deletes it with the slot",
    () =>
      Effect.gen(function* () {
        const fake = yield* fakeMachines();
        const context = yield* scheduler(fake.machines);
        const steps = Context.get(context, StepExecutor);
        const attempt = AttemptId.make("run-1/execute/1");
        const lease = yield* steps.occupy(POOL, attempt);
        assert.deepStrictEqual(fake.calls, [`adopt pool ${attempt}`]);
        yield* lease.release;
        assert.deepStrictEqual(fake.calls.at(-1), `release adopted-${attempt}`);
      }).pipe(Effect.scoped),
  );

  it.effect("creates no machine for a reattachment, which keeps the machine it ran on", () =>
    Effect.gen(function* () {
      const fake = yield* fakeMachines();
      const context = yield* scheduler(fake.machines);
      const steps = Context.get(context, StepExecutor);
      const run = RunId.make("run-1");
      const attempt = AttemptId.make("run-1/execute/1");
      const lease = yield* steps.reserve(run, submission(1), Option.some(POOL));
      assert.lengthOf(fake.calls, 0);
      yield* steps.execute(executionOf(run, attempt, true), sink).pipe(Effect.flip);
      assert.deepStrictEqual(fake.calls, [`adopt pool ${attempt}`]);
      yield* lease.release;
      assert.strictEqual(fake.calls.at(-1), `release adopted-${attempt}`);
    }).pipe(Effect.scoped),
  );
});
