import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { MachineQuotaWait, quotaWaits } from "../src/operator/machines.ts";
import { workerAttentionFor } from "../src/operator/worker-attention.ts";
import { ReadyOverview } from "../src/operator/overview.ts";
import { assert, describe, it } from "@effect/vitest";
import { LoadedInstance } from "@usine/config/instance";
import { CurrentInstance, type WorkerReload } from "../src/current-instance/current-instance.ts";
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
import { stepExecutorLayer } from "../src/scheduler/scheduler.ts";
import { WorkerStatus } from "../src/worker-status.ts";
import { fixedConfigLayer, fixedInstance } from "./support/current-instance.ts";
import { testAppLayer } from "./support/github-app.ts";
import { submission, testAgent } from "./local-worker/support.ts";

const POOL = WorkerName.make("pool");
const unused = () => Effect.die("unused");

const configWithTimings = (timings: Record<string, number>, slots = 1) =>
  Schema.decodeUnknownSync(UsineConfig)({
    version: 1,
    repos: [{ name: "acme/demo" }],
    workers: [
      {
        name: "pool",
        kind: "ssh",
        max_concurrent_attempts: slots,
        root: "/srv/usine",
        provisioner: {
          provider: "hetzner",
          token_env: "TOKEN",
          server_type: "cx33",
          location: "nbg1",
          image: "image",
          ssh_key: "key",
          timings,
        },
      },
    ],
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
    const provisioned = yield* Ref.make(true);
    let next = 0;
    const machines = WorkerMachines.of({
      provisions: (worker) =>
        Ref.get(provisioned).pipe(Effect.map((enabled) => enabled && worker === POOL)),
      create: (worker, runId, attemptId) =>
        Effect.gen(function* () {
          calls.push(`create ${worker} ${runId} ${attemptId}`);
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
    return { calls, failures, checks, gate, machines, provisioned };
  });

const prepared: Array<AttemptId> = [];
let executorSweeps = 0;
const discarded: Array<string> = [];

const executor = Layer.succeed(Executor)({
  kind: "ssh",
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

const scheduler = (
  machines: WorkerMachines["Service"],
  config = configWithTimings({}),
  instances = fixedConfigLayer(config),
) =>
  Layer.build(
    stepExecutorLayer(config, [], {
      machines,
      discard: (worker, attempts) =>
        Effect.sync(() => void discarded.push(`${worker} ${attempts.join(",")}`)),
    }).pipe(
      Layer.provide(MarcbachmannCelLayer),
      Layer.provide(executor),
      Layer.provide(instances),
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
    "creates the machine with the persisted Attempt ID, deletes it with the lease, and passes on sweeps and discards",
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
        assert.deepStrictEqual(fake.calls, [], "a slot reservation creates no machine");
        assert.lengthOf(yield* status.machines, 1);
        const attempt = AttemptId.make("run-1/execute/1");
        const failure = yield* steps.execute(executionOf(run, attempt), sink).pipe(Effect.flip);
        assert(failure instanceof InfraFailure, failure._tag);
        assert.include(fake.calls, `create pool ${run} ${attempt}`);
        assert.include(prepared, attempt);
        const checked = (yield* status.preflights).find(({ worker }) => worker === POOL);
        assert.deepStrictEqual(checked?.containerLimits, Option.some(limits));

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

  for (const reason of ["capacity", "unreachable", "provider"] as const) {
    it.effect(`keeps the same attempt after ${reason} failures without quota attention`, () =>
      Effect.gen(function* () {
        const fake = yield* fakeMachines();
        fake.failures.push(
          new MachineUnavailableError({
            worker: POOL,
            provider: "hetzner",
            reason,
            message: "This product is currently unavailable",
          }),
        );
        const context = yield* scheduler(fake.machines);
        const steps = Context.get(context, StepExecutor);
        const status = Context.get(context, WorkerStatus);
        const lease = yield* steps.reserve(RunId.make("run-1"), submission(1), Option.none());
        const waiting = yield* Effect.forkChild(
          steps
            .execute(executionOf(RunId.make("run-1"), AttemptId.make("run-1/execute/1")), sink)
            .pipe(Effect.flip),
        );
        yield* settle;
        assert.isUndefined(waiting.pollUnsafe(), "the Run waits");
        const [pause] = yield* status.provisioning;
        assert(pause !== undefined, "the Worker is paused");
        assert.strictEqual(pause.reason, reason);
        assert(Option.isNone(pause.quota));
        assert.strictEqual(quotaWaits(yield* status.provisioning).size, 0);
        assert.isTrue(pause.blocked);
        assert.strictEqual(pause.failures, 1);
        assert.strictEqual(
          DateTime.toEpochMillis(pause.retryAt) - DateTime.toEpochMillis(pause.failedAt),
          30_000,
        );
        assert.lengthOf(yield* status.queue, 0, "the persisted Attempt has a slot");
        const [slot] = yield* status.slots;
        assert.strictEqual(slot?.leased, 1);

        yield* TestClock.adjust("29 seconds");
        yield* settle;
        assert.isUndefined(waiting.pollUnsafe(), "the Worker is still paused");
        yield* TestClock.adjust("1 second");
        yield* settle;
        yield* Fiber.join(waiting);
        yield* lease.release;
        assert.lengthOf(
          fake.calls.filter((call) => call.startsWith("create")),
          2,
        );
        assert.lengthOf(yield* status.provisioning, 0, "a success ends the pause");
      }).pipe(Effect.scoped),
    );
  }

  for (const transition of ["backoff", "revision", "creation"] as const) {
    it.effect(
      `stops provisioning retries and clears quota attention after a fixed connection ${transition}`,
      () =>
        Effect.gen(function* () {
          const fake = yield* fakeMachines();
          const creating = yield* Deferred.make<void>();
          if (transition === "creation") yield* Ref.set(fake.gate, Option.some(creating));
          fake.failures.push(
            new MachineUnavailableError({
              worker: POOL,
              provider: "hetzner",
              reason: "quota",
              message: "quota exhausted",
            }),
          );
          const config = configWithTimings({});
          const initial = yield* CurrentInstance.pipe(
            Effect.flatMap((instances) => instances.get),
            Effect.provide(fixedConfigLayer(config)),
          );
          const registered = yield* Deferred.make<WorkerReload>();
          const instances = Layer.succeed(CurrentInstance)({
            ...fixedInstance(initial),
            registerWorkers: (reload) => Deferred.succeed(registered, reload).pipe(Effect.asVoid),
          });
          const context = yield* scheduler(fake.machines, config, instances);
          const steps = Context.get(context, StepExecutor);
          const status = Context.get(context, WorkerStatus);
          const run = RunId.make("fixed-run");
          const attempt = AttemptId.make("fixed-run/execute/1");
          const lease = yield* steps.reserve(run, submission(1), Option.none());
          const waiting = yield* Effect.forkChild(
            steps.execute(executionOf(run, attempt), sink).pipe(Effect.flip),
          );
          yield* settle;
          if (transition === "creation") assert.lengthOf(yield* status.provisioning, 0);
          else assert.isTrue((yield* status.provisioning)[0]?.blocked);
          yield* Ref.set(fake.provisioned, false);
          if (transition === "revision") {
            const changed = new LoadedInstance({
              ...initial,
              config: Schema.decodeUnknownSync(UsineConfig)({
                version: 1,
                repos: [{ name: "acme/demo" }],
                workers: [
                  {
                    name: "pool",
                    kind: "ssh",
                    destination: "usine@203.0.113.7",
                    root: "/srv/usine",
                  },
                ],
              }),
            });
            const reload = yield* Deferred.await(registered);
            const apply = yield* reload(initial, changed);
            yield* apply;
          } else if (transition === "creation") {
            yield* Deferred.succeed(creating, undefined);
          } else {
            yield* TestClock.adjust("30 seconds");
          }
          yield* settle;
          yield* Fiber.join(waiting);
          assert.include(prepared, attempt);
          assert.lengthOf(
            fake.calls.filter((call) => call.startsWith("create")),
            1,
          );
          assert.lengthOf(yield* status.provisioning, 0);
          assert.strictEqual(quotaWaits(yield* status.provisioning).size, 0);
          yield* lease.release;
          const next = yield* steps.reserve(
            RunId.make("next-fixed-run"),
            submission(2),
            Option.none(),
          );
          if (transition === "revision") {
            yield* TestClock.adjust("10 seconds");
            yield* Ref.set(fake.provisioned, true);
            fake.failures.push(
              new MachineUnavailableError({
                worker: POOL,
                provider: "hetzner",
                reason: "quota",
                message: "quota exhausted again",
              }),
            );
            const retrying = yield* Effect.forkChild(
              steps
                .execute(
                  executionOf(
                    RunId.make("next-fixed-run"),
                    AttemptId.make("next-fixed-run/execute/1"),
                  ),
                  sink,
                )
                .pipe(Effect.flip),
            );
            yield* settle;
            yield* TestClock.adjust("20 seconds");
            yield* settle;
            assert.isUndefined(
              retrying.pollUnsafe(),
              "the obsolete timer cannot end a later pause",
            );
            yield* TestClock.adjust("10 seconds");
            yield* settle;
            yield* Fiber.join(retrying);
          }
          yield* next.release;
        }).pipe(Effect.scoped),
    );
  }

  it.effect(
    "retains quota attention through transient retries and clears the run wait after creation",
    () =>
      Effect.gen(function* () {
        const fake = yield* fakeMachines();
        const message = "shared core limit exceeded";
        const context = yield* scheduler(fake.machines, configWithTimings({}, 2));
        const steps = Context.get(context, StepExecutor);
        const status = Context.get(context, WorkerStatus);
        const readyRun = RunId.make("ready-run");
        const readyLease = yield* steps.reserve(readyRun, submission(1), Option.none());
        yield* steps
          .execute(executionOf(readyRun, AttemptId.make("ready-run/execute/1")), sink)
          .pipe(Effect.flip);
        fake.failures.push(
          new MachineUnavailableError({
            worker: POOL,
            provider: "hetzner",
            reason: "quota",
            message,
          }),
          new MachineUnavailableError({
            worker: POOL,
            provider: "hetzner",
            reason: "unreachable",
            message: "request timed out",
          }),
        );

        const refresh = workerAttentionFor(
          { transcript: unused },
          { list: () => Effect.succeed([]) },
          status,
        );
        const overview = new ReadyOverview({ projects: [], loops: [], needsYou: [] });
        const runId = RunId.make("run-1");
        const lease = yield* steps.reserve(runId, submission(1), Option.none());
        const waiting = yield* Effect.forkChild(
          steps
            .execute(executionOf(runId, AttemptId.make("run-1/execute/1")), sink)
            .pipe(Effect.flip),
        );
        yield* settle;
        const assertQuota = Effect.gen(function* () {
          assert.strictEqual(
            quotaWaits(yield* status.provisioning).size,
            1,
            "the run with a machine does not wait for quota",
          );
          const needs = (yield* refresh(overview, [], [POOL])).needsYou;
          assert.lengthOf(needs, 1);
          assert.strictEqual(needs[0]?._tag, "WorkerQuotaNeed");
          assert.deepStrictEqual(
            quotaWaits(yield* status.provisioning).get(runId),
            new MachineQuotaWait({
              worker: POOL,
              message,
            }),
          );
        });
        yield* assertQuota;
        yield* TestClock.adjust("30 seconds");
        yield* settle;
        yield* assertQuota;
        const [pause] = yield* status.provisioning;
        assert.strictEqual(pause?.reason, "unreachable");
        assert.strictEqual(pause?.failures, 2);
        yield* TestClock.adjust("59 seconds");
        yield* settle;
        assert.isUndefined(waiting.pollUnsafe());
        yield* TestClock.adjust("1 second");
        yield* settle;
        yield* Fiber.join(waiting);
        assert.lengthOf(yield* status.provisioning, 0);
        assert.strictEqual(quotaWaits(yield* status.provisioning).size, 0);
        assert.lengthOf((yield* refresh(overview, [], [POOL])).needsYou, 0);
        assert.strictEqual(fake.calls.filter((call) => call.startsWith("create")).length, 4);
        yield* lease.release;
        yield* readyLease.release;
      }).pipe(Effect.scoped),
  );

  it.effect("resumes reservations after cancellation during creation backoff", () =>
    Effect.gen(function* () {
      const fake = yield* fakeMachines();
      fake.failures.push(
        new MachineUnavailableError({
          worker: POOL,
          provider: "hetzner",
          reason: "quota",
          message: "This product is currently unavailable",
        }),
      );
      const context = yield* scheduler(fake.machines);
      const steps = Context.get(context, StepExecutor);
      const status = Context.get(context, WorkerStatus);
      const lease = yield* steps.reserve(RunId.make("run-1"), submission(1), Option.none());
      const waiting = yield* Effect.forkChild(
        steps.execute(executionOf(RunId.make("run-1"), AttemptId.make("run-1/execute/1")), sink),
      );
      yield* settle;
      assert.isTrue((yield* status.provisioning)[0]?.blocked);
      yield* Fiber.interrupt(waiting);
      yield* lease.release;
      assert.strictEqual((yield* status.slots)[0]?.leased, 0);
      assert.strictEqual(
        quotaWaits(yield* status.provisioning).size,
        0,
        "canceling clears the run wait",
      );
      assert(
        Option.isSome((yield* status.provisioning)[0]?.quota ?? Option.none()),
        "canceling retains worker attention",
      );
      const next = yield* Effect.forkChild(
        steps.reserve(RunId.make("run-2"), submission(2), Option.none()),
      );
      yield* TestClock.adjust("29 seconds");
      yield* settle;
      assert.isUndefined(next.pollUnsafe(), "new reservations wait for the pause to end");
      yield* TestClock.adjust("1 second");
      yield* settle;
      assert.isFalse((yield* status.provisioning)[0]?.blocked);
      const resumed = yield* Fiber.join(next);
      assert.strictEqual(resumed.worker, POOL);
      yield* steps
        .execute(executionOf(RunId.make("run-2"), AttemptId.make("run-2/execute/1")), sink)
        .pipe(Effect.flip);
      assert.include(fake.calls, "create pool run-2 run-2/execute/1");
      assert.lengthOf(yield* status.provisioning, 0);
      yield* resumed.release;
    }).pipe(Effect.scoped),
  );

  it.effect("uses the configured backoff minimum and caps repeated failures at its maximum", () =>
    Effect.gen(function* () {
      const fake = yield* fakeMachines();
      const quota = new MachineUnavailableError({
        worker: POOL,
        provider: "hetzner",
        reason: "quota",
        message: "project limit exceeded",
      });
      fake.failures.push(quota, quota, quota);
      const context = yield* scheduler(
        fake.machines,
        configWithTimings({ creation_backoff_min: 2, creation_backoff_max: 3 }),
      );
      const steps = Context.get(context, StepExecutor);
      const status = Context.get(context, WorkerStatus);
      yield* steps.reserve(RunId.make("run-1"), submission(1), Option.none());
      yield* Effect.forkChild(
        steps.execute(executionOf(RunId.make("run-1"), AttemptId.make("run-1/execute/1")), sink),
      );
      yield* settle;
      yield* TestClock.adjust("2 seconds");
      yield* settle;
      const [pause] = yield* status.provisioning;
      assert.strictEqual(pause?.failures, 2);
      assert.strictEqual(
        pause === undefined
          ? 0
          : DateTime.toEpochMillis(pause.retryAt) - DateTime.toEpochMillis(pause.failedAt),
        3_000,
      );
      yield* TestClock.adjust("3 seconds");
      yield* settle;
      const [capped] = yield* status.provisioning;
      assert.strictEqual(capped?.failures, 3);
      assert.strictEqual(
        capped === undefined
          ? 0
          : DateTime.toEpochMillis(capped.retryAt) - DateTime.toEpochMillis(capped.failedAt),
        3000,
      );
      assert.deepStrictEqual(
        fake.calls.filter((call) => call.startsWith("create")),
        Array(3).fill("create pool run-1 run-1/execute/1"),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("stops machine creation when the Attempt is canceled, then releases its slot", () =>
    Effect.gen(function* () {
      const fake = yield* fakeMachines();
      const gate = yield* Deferred.make<void>();
      yield* Ref.set(fake.gate, Option.some(gate));
      const context = yield* scheduler(fake.machines);
      const steps = Context.get(context, StepExecutor);
      const lease = yield* steps.reserve(RunId.make("run-1"), submission(1), Option.none());
      const waiting = yield* Effect.forkChild(
        steps.execute(executionOf(RunId.make("run-1"), AttemptId.make("run-1/execute/1")), sink),
      );
      yield* settle;
      assert.deepStrictEqual(fake.calls, ["create pool run-1 run-1/execute/1"]);
      yield* Fiber.interrupt(waiting);
      yield* settle;
      assert.include(fake.calls, "interrupted run-1");
      yield* lease.release;
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
