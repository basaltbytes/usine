import { ChangeBus, changeBusLayer, type CommittedChanges } from "@usine/core/changes";
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
  type CheckoutRequest,
  Executor,
  ExecutorOperationError,
  fullPreflight,
  MachineCheck,
  MachineGrant,
  MachineHold,
  MachineStatus,
  MachineUnavailableError,
  WorkerCapabilityError,
  WorkerMachines,
} from "@usine/executor";
import {
  Context,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Logger,
  Option,
  Ref,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import { type ExecutorWorkers, stepExecutorLayer } from "../src/scheduler/scheduler.ts";
import { WorkerStatus } from "../src/worker-status.ts";
import { fixedConfigLayer, fixedInstance } from "./support/current-instance.ts";
import { testAppLayer } from "./support/github-app.ts";
import { submission, testAgent } from "./local-worker/support.ts";

const POOL = WorkerName.make("pool");
const unused = () => Effect.die("unused");

const configWithTimings = (
  timings: Record<string, number>,
  slots = 1,
  settings: Record<string, number> = {},
) =>
  Schema.decodeEffect(UsineConfig)({
    version: 1,
    repos: [{ name: "acme/demo" }],
    settings,
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
    const failures: Array<MachineUnavailableError | WorkerCapabilityError> = [];
    const checks: Array<MachineCheck> = [];
    const gate = yield* Ref.make(Option.none<Deferred.Deferred<void>>());
    const provisioned = yield* Ref.make(true);
    let next = 0;
    const machines = WorkerMachines.of({
      provisions: (worker) =>
        Ref.get(provisioned).pipe(Effect.map((enabled) => enabled && worker === POOL)),
      create: (worker, run, attemptId) =>
        Effect.gen(function* () {
          const runId = run.id;
          calls.push(`create ${worker} ${runId} ${attemptId}`);
          const waiting = yield* Ref.get(gate);
          if (Option.isSome(waiting)) yield* Deferred.await(waiting.value);
          const failure = failures.shift();
          if (failure !== undefined) return yield* failure;
          next += 1;
          return MachineGrant.make({
            hold: MachineHold.make(`hold-${String(next)}`),
            id: MachineId.make(String(100 + next)),
            worker,
            provider: "hetzner",
            checked: Option.fromNullishOr(checks.shift()),
          });
        }).pipe(Effect.onInterrupt(() => Effect.sync(() => calls.push(`interrupted ${run.id}`)))),
      adopt: (worker, attemptId) =>
        Effect.sync(() => {
          calls.push(`adopt ${worker} ${attemptId}`);
          return Option.some(MachineHold.make(`adopted-${attemptId}`));
        }),
      release: (hold) => Effect.sync(() => void calls.push(`release ${hold}`)),
      sweep: Effect.sync(() => void calls.push("sweep")),
      starts: Effect.succeed([]),
      machines: Effect.succeed([
        MachineStatus.make({
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
const checkouts: Array<CheckoutRequest> = [];
let executorSweeps = 0;
const discarded: Array<string> = [];

const executor = Layer.succeed(Executor)({
  kind: "ssh",
  recover: unused,
  isLive: unused,
  outcome: unused,
  preflight: () => Effect.succeed(fullPreflight),
  prepare: (request) =>
    Effect.sync(() => {
      prepared.push(request.attemptId);
      checkouts.push(request);
    }).pipe(
      Effect.andThen(
        Effect.fail(
          ExecutorOperationError.make({
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
  config?: UsineConfig,
  instances?: Layer.Layer<CurrentInstance>,
  workers: ExecutorWorkers = { add: () => Effect.void, remove: () => Effect.void },
) =>
  Effect.gen(function* () {
    const fixtureConfig = config ?? (yield* configWithTimings({}));
    return yield* Layer.build(
      stepExecutorLayer(fixtureConfig, [], {
        machines,
        workers,
        discard: (worker, attempts) =>
          Effect.sync(() => void discarded.push(`${worker} ${attempts.join(",")}`)),
      }).pipe(
        Layer.provide(MarcbachmannCelLayer),
        Layer.provide(executor),
        Layer.provide(instances ?? fixedConfigLayer(fixtureConfig)),
        Layer.provide(testAppLayer),
      ),
    );
  });

const executionOf = (runId: RunId, attemptId: AttemptId, reattach = false) => {
  const selected = submission(1);
  return StepExecution.make({
    requiresCi: false,
    attempt: Attempt.make({
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
    run: Run.make({
      id: runId,
      eventId: selected.event.id,
      loop: selected.loop,
      state: RunState.start(RunState.Pending.make()),
      openedAt: selected.event.receivedAt,
    }),
    step: Step.make({ runId, name: selected.step, result: Option.none() }),
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
        const limits = ContainerLimits.make({
          cpus: ContainerCpus.make(3.5),
          memoryMib: ContainerMemoryMib.make(7168),
          pids: ContainerPids.make(60976),
        });
        fake.checks.push(
          MachineCheck.make({
            brains: [testAgent.brain],
            containerLimits: Option.some(limits),
            findings: ["The SSH user can't read the kernel journal"],
          }),
        );
        const context = yield* scheduler(fake.machines);
        const steps = Context.get(context, StepExecutor);
        const status = Context.get(context, WorkerStatus);
        const run = RunId.make("run-1");
        const lease = yield* steps.reserve(run, submission(1), Option.none());
        assert.strictEqual(lease.worker, POOL);
        assert.deepStrictEqual(fake.calls, [], "a slot reservation creates no machine");
        const currentMachines = yield* status.machines;
        assert.lengthOf(currentMachines, 1);
        const attempt = AttemptId.make("run-1/execute/1");
        const failure = yield* steps.execute(executionOf(run, attempt), sink).pipe(Effect.flip);
        assert(Schema.is(InfraFailure)(failure), failure._tag);
        assert.include(fake.calls, `create pool ${run} ${attempt}`);
        assert.include(prepared, attempt);

        const checked = (yield* status.preflights).find(({ worker }) => worker === POOL);
        assert.deepStrictEqual(checked?.containerLimits, Option.some(limits));
        assert.deepStrictEqual(checked?.findings, ["The SSH user can't read the kernel journal"]);

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

  it.effect("copies each time limit from the instance settings to its own checkout field", () =>
    Effect.gen(function* () {
      const fake = yield* fakeMachines();
      const config = yield* configWithTimings({}, 1, {
        max_attempt_minutes: 600,
        max_background_wait_minutes: 5,
      });
      const context = yield* scheduler(fake.machines, config);
      const steps = Context.get(context, StepExecutor);
      const run = RunId.make("run-limits");
      const lease = yield* steps.reserve(run, submission(1), Option.none());
      const attempt = AttemptId.make("run-limits/execute/1");
      yield* steps.execute(executionOf(run, attempt), sink).pipe(Effect.flip);
      const checkout = checkouts.find(({ attemptId }) => attemptId === attempt);
      assert(checkout !== undefined, "the scheduler prepares the checkout");
      assert.deepStrictEqual(checkout.maxAttemptMinutes, Option.some(600));
      assert.deepStrictEqual(checkout.maxBackgroundWaitMinutes, Option.some(5));
      yield* lease.release;
    }).pipe(Effect.scoped),
  );

  for (const reason of ["capacity", "unreachable", "provider"] as const) {
    it.effect(`keeps the same attempt after ${reason} failures without quota attention`, () =>
      Effect.gen(function* () {
        const fake = yield* fakeMachines();
        fake.failures.push(
          MachineUnavailableError.make({
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
        const currentProvisioning = yield* status.provisioning;
        assert.strictEqual(quotaWaits(currentProvisioning).size, 0);
        assert.isTrue(pause.blocked);
        assert.strictEqual(pause.failures, 1);
        assert.strictEqual(
          DateTime.toEpochMillis(pause.retryAt) - DateTime.toEpochMillis(pause.failedAt),
          30_000,
        );
        const currentQueue = yield* status.queue;
        assert.lengthOf(currentQueue, 0, "the persisted Attempt has a slot");
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
        const nextProvisioning = yield* status.provisioning;
        assert.lengthOf(nextProvisioning, 0, "a success ends the pause");
      }).pipe(Effect.scoped),
    );
  }

  describe("a check that fails during machine creation", () => {
    const gatewayFailure = () =>
      WorkerCapabilityError.make({
        worker: POOL,
        capability: "gateway",
        message: 'Provisioned worker "pool" could not join the tailnet or configure the gateway.',
        cause: new Error("tailnet bootstrap failed"),
      });
    const recordOf = (status: WorkerStatus["Service"]) =>
      status.preflights.pipe(
        Effect.map((preflights) => preflights.find(({ worker }) => worker === POOL)),
      );
    const prerequisitesOf = (status: WorkerStatus["Service"]) =>
      recordOf(status).pipe(
        Effect.map((record) =>
          Option.flatMap(Option.fromNullishOr(record), ({ prerequisites }) => prerequisites),
        ),
      );
    const assertGatewayFailed = (status: WorkerStatus["Service"]) =>
      Effect.gen(function* () {
        const failed = yield* prerequisitesOf(status);
        assert(Option.isSome(failed) && failed.value._tag === "Failed");
        assert.deepStrictEqual(failed.value.capability, Option.some("gateway"));
      });
    const execute = (steps: StepExecutor["Service"], run: string) =>
      Effect.gen(function* () {
        const runId = RunId.make(run);
        const lease = yield* steps.reserve(runId, submission(1), Option.none());
        const waiting = yield* Effect.forkChild(
          steps
            .execute(executionOf(runId, AttemptId.make(`${run}/execute/1`)), sink)
            .pipe(Effect.flip),
        );
        yield* settle;
        return { lease, waiting };
      });
    const workerNotices = (history: ReadonlyArray<CommittedChanges>, after: number) =>
      history.filter(
        ({ revision, changes }) =>
          revision > after &&
          changes.some(({ target }) => target.kind === "worker" && target.id === POOL),
      ).length;
    const FAILED = "Machine creation failed a worker check; the next machine clears it";
    const RESTORED = "Machine created; cleared the worker check that a machine creation failed";
    const REPLACED =
      "A newer worker check replaced the failed machine creation's check; the next machine doesn't restore the earlier record";
    /** Collects the level and message of each log entry about a machine creation's check. */
    const machineCheckLogs = () => {
      const entries: Array<readonly [level: string, text: string]> = [];
      const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
        const text: unknown = Array.isArray(message) ? message[0] : message;
        if (text === FAILED || text === RESTORED || text === REPLACED)
          entries.push([logLevel, text]);
      });
      return { entries, layer: Logger.layer([logger]) };
    };

    it.effect(
      "restores the record from before two failures and publishes it when a machine creation succeeds",
      () => {
        const logs = machineCheckLogs();
        return Effect.gen(function* () {
          const bus = yield* ChangeBus;
          const fake = yield* fakeMachines();
          fake.failures.push(gatewayFailure(), gatewayFailure());
          const context = yield* scheduler(fake.machines);
          const steps = Context.get(context, StepExecutor);
          const status = Context.get(context, WorkerStatus);
          const startup = yield* recordOf(status);
          assert.strictEqual(startup?.prerequisites.pipe(Option.getOrUndefined)?._tag, "Passed");
          const { lease, waiting } = yield* execute(steps, "run-1");
          yield* assertGatewayFailed(status);

          yield* TestClock.adjust("30 seconds");
          yield* settle;
          assert.isUndefined(waiting.pollUnsafe(), "the second creation failed too");
          yield* assertGatewayFailed(status);

          const gate = yield* Deferred.make<void>();
          yield* Ref.set(fake.gate, Option.some(gate));
          yield* TestClock.adjust("60 seconds");
          yield* settle;
          const before = (yield* bus.open).revision;
          yield* Deferred.succeed(gate, undefined);
          yield* settle;
          yield* Fiber.join(waiting);
          const restored = yield* recordOf(status);
          assert.deepStrictEqual(restored, startup, "the startup record is back");
          const { history } = yield* bus.open;
          const notices = workerNotices(history, before);
          assert.strictEqual(
            notices,
            2,
            "the creation's success and the restored record each publish a Worker change",
          );
          assert.deepStrictEqual(logs.entries, [
            ["Info", FAILED],
            ["Info", FAILED],
            ["Info", RESTORED],
          ]);
          yield* lease.release;
        }).pipe(Effect.scoped, Effect.provide(Layer.merge(changeBusLayer, logs.layer)));
      },
    );

    it.effect("records the check of a machine creation that got one instead of restoring", () => {
      const logs = machineCheckLogs();
      return Effect.gen(function* () {
        const bus = yield* ChangeBus;
        const fake = yield* fakeMachines();
        const limits = ContainerLimits.make({
          cpus: ContainerCpus.make(3.5),
          memoryMib: ContainerMemoryMib.make(7168),
          pids: ContainerPids.make(60976),
        });
        fake.failures.push(gatewayFailure());
        fake.checks.push(
          MachineCheck.make({
            brains: [testAgent.brain],
            containerLimits: Option.some(limits),
            findings: ["The SSH user can't read the kernel journal"],
          }),
        );
        const context = yield* scheduler(fake.machines);
        const steps = Context.get(context, StepExecutor);
        const status = Context.get(context, WorkerStatus);
        const startup = yield* recordOf(status);
        const { lease, waiting } = yield* execute(steps, "run-1");
        yield* assertGatewayFailed(status);

        const gate = yield* Deferred.make<void>();
        yield* Ref.set(fake.gate, Option.some(gate));
        yield* TestClock.adjust("30 seconds");
        yield* settle;
        const before = (yield* bus.open).revision;
        yield* Deferred.succeed(gate, undefined);
        yield* settle;
        yield* Fiber.join(waiting);
        const { history } = yield* bus.open;
        assert.strictEqual(
          workerNotices(history, before),
          2,
          "the creation's success and the recorded check each publish a Worker change",
        );
        const checked = yield* recordOf(status);
        assert.notDeepEqual(checked, startup);
        const prerequisites = checked?.prerequisites.pipe(Option.getOrUndefined);
        assert.strictEqual(prerequisites?._tag, "Passed");
        assert.strictEqual(
          prerequisites === undefined ? undefined : DateTime.toEpochMillis(prerequisites.checkedAt),
          30_000,
        );
        assert.deepStrictEqual(checked?.containerLimits, Option.some(limits));
        assert.deepStrictEqual(checked?.findings, ["The SSH user can't read the kernel journal"]);
        assert.deepStrictEqual(logs.entries, [
          ["Info", FAILED],
          ["Info", REPLACED],
        ]);
        yield* lease.release;
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(changeBusLayer, logs.layer)));
    });

    it.effect("restores once: a later machine creation restores nothing", () => {
      const logs = machineCheckLogs();
      return Effect.gen(function* () {
        const bus = yield* ChangeBus;
        const fake = yield* fakeMachines();
        fake.failures.push(gatewayFailure());
        const context = yield* scheduler(fake.machines);
        const steps = Context.get(context, StepExecutor);
        const status = Context.get(context, WorkerStatus);
        const startup = yield* recordOf(status);
        const first = yield* execute(steps, "run-1");
        yield* assertGatewayFailed(status);
        yield* TestClock.adjust("30 seconds");
        yield* settle;
        yield* Fiber.join(first.waiting);
        yield* first.lease.release;
        const restored = yield* recordOf(status);
        assert.deepStrictEqual(restored, startup, "the startup record is back");

        const gate = yield* Deferred.make<void>();
        yield* Ref.set(fake.gate, Option.some(gate));
        const second = yield* execute(steps, "run-2");
        const before = (yield* bus.open).revision;
        yield* Deferred.succeed(gate, undefined);
        yield* settle;
        yield* Fiber.join(second.waiting);
        const { history } = yield* bus.open;
        assert.strictEqual(
          workerNotices(history, before),
          0,
          "the later creation has no failure to clear, so it publishes no Worker change",
        );
        const kept = yield* recordOf(status);
        assert.deepStrictEqual(kept, startup, "the later creation leaves the record as it is");
        assert.deepStrictEqual(
          logs.entries,
          [
            ["Info", FAILED],
            ["Info", RESTORED],
          ],
          "the later creation logs no second restore",
        );
        yield* second.lease.release;
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(changeBusLayer, logs.layer)));
    });

    it.effect("logs no dropped record when a check or a preflight finds nothing saved", () => {
      const logs = machineCheckLogs();
      return Effect.gen(function* () {
        const fake = yield* fakeMachines();
        fake.checks.push(
          MachineCheck.make({
            brains: [testAgent.brain],
            containerLimits: Option.none(),
            findings: ["The SSH user can't read the kernel journal"],
          }),
        );
        const context = yield* scheduler(fake.machines);
        const steps = Context.get(context, StepExecutor);
        const status = Context.get(context, WorkerStatus);
        const { lease, waiting } = yield* execute(steps, "run-1");
        yield* Fiber.join(waiting);
        const checked = yield* recordOf(status);
        assert.deepStrictEqual(checked?.findings, ["The SSH user can't read the kernel journal"]);
        yield* lease.release;

        yield* TestClock.adjust("10 seconds");
        const preflight = yield* status.runPreflight(POOL);
        assert.strictEqual(preflight.prerequisites.pipe(Option.getOrUndefined)?._tag, "Passed");
        assert.deepStrictEqual(logs.entries, [], "nothing was saved, so nothing is dropped");
      }).pipe(Effect.scoped, Effect.provide(logs.layer));
    });

    it.effect(
      "keeps a preflight that ran after the failure when the next machine is created",
      () => {
        const logs = machineCheckLogs();
        return Effect.gen(function* () {
          const fake = yield* fakeMachines();
          fake.failures.push(gatewayFailure());
          const context = yield* scheduler(fake.machines);
          const steps = Context.get(context, StepExecutor);
          const status = Context.get(context, WorkerStatus);
          const startup = yield* recordOf(status);
          const first = yield* execute(steps, "run-1");
          yield* assertGatewayFailed(status);
          yield* Fiber.interrupt(first.waiting);
          yield* first.lease.release;

          yield* TestClock.adjust("10 seconds");
          const preflight = yield* status.runPreflight(POOL);
          assert.strictEqual(preflight.prerequisites.pipe(Option.getOrUndefined)?._tag, "Passed");
          assert.notDeepEqual(preflight, startup, "the preflight has a later check time");

          yield* TestClock.adjust("20 seconds");
          yield* settle;
          const second = yield* execute(steps, "run-2");
          yield* Fiber.join(second.waiting);
          const kept = yield* recordOf(status);
          assert.deepStrictEqual(kept, preflight, "the newer preflight stays");
          assert.deepStrictEqual(
            logs.entries,
            [
              ["Info", FAILED],
              ["Info", REPLACED],
            ],
            "the preflight logs that it dropped the saved record, and the creation restores nothing",
          );
          yield* second.lease.release;
        }).pipe(Effect.scoped, Effect.provide(logs.layer));
      },
    );
  });

  for (const transition of ["backoff", "revision", "creation"] as const) {
    it.effect(
      `stops provisioning retries and clears quota attention after a fixed connection ${transition}`,
      () =>
        Effect.gen(function* () {
          const fake = yield* fakeMachines();
          const creating = yield* Deferred.make<void>();
          if (transition === "creation") yield* Ref.set(fake.gate, Option.some(creating));
          fake.failures.push(
            MachineUnavailableError.make({
              worker: POOL,
              provider: "hetzner",
              reason: "quota",
              message: "quota exhausted",
            }),
          );
          const config = yield* configWithTimings({});
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
          if (transition === "creation") {
            const currentProvisioning = yield* status.provisioning;
            assert.lengthOf(currentProvisioning, 0);
          } else assert.isTrue((yield* status.provisioning)[0]?.blocked);
          yield* Ref.set(fake.provisioned, false);
          if (transition === "revision") {
            const decodedValue2 = yield* Schema.decodeEffect(UsineConfig)({
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
            });
            const changed = LoadedInstance.make({
              ...initial,
              config: decodedValue2,
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
          const nextProvisioning = yield* status.provisioning;
          assert.lengthOf(nextProvisioning, 0);
          const updatedProvisioning = yield* status.provisioning;
          assert.strictEqual(quotaWaits(updatedProvisioning).size, 0);
          yield* lease.release;
          const next = yield* steps.reserve(
            RunId.make("next-fixed-run"),
            submission(2),
            Option.none(),
          );
          if (transition === "revision") {
            yield* TestClock.adjust("10 seconds");
            yield* Ref.set(fake.provisioned, true);
            const reload = yield* Deferred.await(registered);
            const decodedValue3 = yield* Schema.decodeEffect(UsineConfig)({
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
            });
            const apply = yield* reload(
              LoadedInstance.make({
                ...initial,
                config: decodedValue3,
              }),
              initial,
            );
            yield* apply;
            fake.failures.push(
              MachineUnavailableError.make({
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

  it.effect("stops old creation retries while a fixed connection fails initialization", () =>
    Effect.gen(function* () {
      const fake = yield* fakeMachines();
      fake.failures.push(
        MachineUnavailableError.make({
          worker: POOL,
          provider: "hetzner",
          reason: "quota",
          message: "quota exhausted",
        }),
      );
      const config = yield* configWithTimings({});
      const initial = yield* CurrentInstance.pipe(
        Effect.flatMap((instances) => instances.get),
        Effect.provide(fixedConfigLayer(config)),
      );
      const current = yield* Ref.make(initial);
      const registered = yield* Deferred.make<WorkerReload>();
      const instances = Layer.succeed(CurrentInstance)({
        ...fixedInstance(initial),
        get: Ref.get(current),
        registerWorkers: (reload) => Deferred.succeed(registered, reload).pipe(Effect.asVoid),
      });
      const available = yield* Ref.make(false);
      const context = yield* scheduler(fake.machines, config, instances, {
        add: (worker) =>
          Effect.gen(function* () {
            if (worker.kind !== "ssh" || Option.isSome(worker.provisioner)) return;
            if (!(yield* Ref.get(available)))
              return yield* ExecutorOperationError.make({
                operation: "preflight",
                message: "Gateway credential variable is unset",
                cause: new Error("missing credential"),
              });
            yield* Ref.set(fake.provisioned, false);
          }),
        remove: () => Effect.void,
      });
      const steps = Context.get(context, StepExecutor);
      const status = Context.get(context, WorkerStatus);
      const run = RunId.make("failed-fixed-run");
      const attempt = AttemptId.make("failed-fixed-run/execute/1");
      const lease = yield* steps.reserve(run, submission(1), Option.none());
      const waiting = yield* Effect.forkChild(
        steps.execute(executionOf(run, attempt), sink).pipe(Effect.flip),
      );
      yield* settle;
      const decodedValue4 = yield* Schema.decodeEffect(UsineConfig)({
        version: 1,
        repos: [{ name: "acme/demo" }],
        workers: [
          { name: "pool", kind: "ssh", destination: "usine@203.0.113.7", root: "/srv/usine" },
        ],
      });
      const changed = LoadedInstance.make({
        ...initial,
        config: decodedValue4,
      });

      const apply = yield* (yield* Deferred.await(registered))(initial, changed);
      yield* Ref.set(current, changed);
      yield* apply;
      yield* TestClock.adjust("30 seconds");
      yield* settle;
      assert.lengthOf(
        fake.calls.filter((call) => call.startsWith("create")),
        1,
      );
      const currentProvisioning = yield* status.provisioning;
      assert.lengthOf(currentProvisioning, 0);
      assert.notInclude(prepared, attempt);
      assert.isUndefined(waiting.pollUnsafe());
      yield* Ref.set(available, true);
      yield* TestClock.adjust("30 seconds");
      yield* settle;
      yield* Fiber.join(waiting);
      assert.include(prepared, attempt);
      assert.lengthOf(
        fake.calls.filter((call) => call.startsWith("create")),
        1,
      );
      yield* lease.release;
    }).pipe(Effect.scoped),
  );

  it.effect(
    "retains quota attention through transient retries and clears the run wait after creation",
    () =>
      Effect.gen(function* () {
        const bus = yield* ChangeBus;
        const fake = yield* fakeMachines();
        const message = "shared core limit exceeded";
        const decodedValue2 = yield* configWithTimings({}, 2);
        const context = yield* scheduler(fake.machines, decodedValue2);
        const steps = Context.get(context, StepExecutor);
        const status = Context.get(context, WorkerStatus);
        const readyRun = RunId.make("ready-run");
        const readyLease = yield* steps.reserve(readyRun, submission(1), Option.none());
        yield* steps
          .execute(executionOf(readyRun, AttemptId.make("ready-run/execute/1")), sink)
          .pipe(Effect.flip);
        fake.failures.push(
          MachineUnavailableError.make({
            worker: POOL,
            provider: "hetzner",
            reason: "quota",
            message,
          }),
          MachineUnavailableError.make({
            worker: POOL,
            provider: "hetzner",
            reason: "unreachable",
            message: "request timed out",
          }),
        );

        const refresh = workerAttentionFor(
          { transcript: unused },
          { list: Effect.succeed([]) },
          status,
        );
        const overview = ReadyOverview.make({ projects: [], loops: [], needsYou: [] });
        const runId = RunId.make("run-1");
        const lease = yield* steps.reserve(runId, submission(1), Option.none());
        const waiting = yield* Effect.forkChild(
          steps
            .execute(executionOf(runId, AttemptId.make("run-1/execute/1")), sink)
            .pipe(Effect.flip),
        );
        yield* settle;
        const assertQuota = Effect.gen(function* () {
          const currentProvisioning = yield* status.provisioning;
          assert.strictEqual(
            quotaWaits(currentProvisioning).size,
            1,
            "the run with a machine does not wait for quota",
          );
          const needs = (yield* refresh(overview, [], [{ name: POOL, paused: false }])).needsYou;
          assert.lengthOf(needs, 1);
          assert.strictEqual(needs[0]?._tag, "WorkerQuotaNeed");
          const nextProvisioning = yield* status.provisioning;
          assert.deepStrictEqual(
            quotaWaits(nextProvisioning).get(runId),
            MachineQuotaWait.make({
              worker: POOL,
              message,
            }),
          );
        });
        yield* assertQuota;
        const assertNotice = Effect.gen(function* () {
          const notices = (yield* bus.open).history;
          assert(
            notices.some(({ changes }) =>
              changes.some(
                ({ audience, target }) =>
                  audience._tag === "Loop" &&
                  audience.loop === submission(1).loop &&
                  target.kind === "run" &&
                  target.id === runId,
              ),
            ),
          );
          assert(
            notices.some(({ changes }) =>
              changes.some(
                ({ audience, target }) =>
                  audience._tag === "Loop" &&
                  audience.loop === submission(1).loop &&
                  target.kind === "item" &&
                  target.id === submission(1).itemKey,
              ),
            ),
          );
        });
        yield* assertNotice;
        const pausedRevision = (yield* bus.open).revision;
        yield* TestClock.adjust("29 seconds");

        assert.strictEqual((yield* bus.open).revision, pausedRevision);
        assert.isUndefined(waiting.pollUnsafe());
        yield* TestClock.adjust("1 second");
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
        const currentProvisioning = yield* status.provisioning;
        assert.lengthOf(currentProvisioning, 0);
        const nextProvisioning = yield* status.provisioning;
        assert.strictEqual(quotaWaits(nextProvisioning).size, 0);

        assert.lengthOf(
          (yield* refresh(overview, [], [{ name: POOL, paused: false }])).needsYou,
          0,
        );
        assert.strictEqual(fake.calls.filter((call) => call.startsWith("create")).length, 4);
        yield* lease.release;
        yield* readyLease.release;
      }).pipe(Effect.scoped, Effect.provide(changeBusLayer)),
  );

  it.effect("resumes reservations after cancellation during creation backoff", () =>
    Effect.gen(function* () {
      const fake = yield* fakeMachines();
      fake.failures.push(
        MachineUnavailableError.make({
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
      const currentProvisioning = yield* status.provisioning;
      assert.strictEqual(quotaWaits(currentProvisioning).size, 0, "canceling clears the run wait");

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
      const nextProvisioning = yield* status.provisioning;
      assert.lengthOf(nextProvisioning, 0);
      yield* resumed.release;
    }).pipe(Effect.scoped),
  );

  it.effect("uses the configured backoff minimum and caps repeated failures at its maximum", () =>
    Effect.gen(function* () {
      const fake = yield* fakeMachines();
      const quota = MachineUnavailableError.make({
        worker: POOL,
        provider: "hetzner",
        reason: "quota",
        message: "project limit exceeded",
      });
      fake.failures.push(quota, quota, quota);
      const decodedValue1 = yield* configWithTimings({
        creation_backoff_min: 2,
        creation_backoff_max: 3,
      });
      const context = yield* scheduler(fake.machines, decodedValue1);
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
