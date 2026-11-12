import { InstanceScope } from "@usine/core/access";
import { ChangeBus } from "@usine/core/changes";
import type { Worker } from "@usine/config/factory";
import type { BrainSpec } from "@usine/core/agent/brain";
import type { WorkerName } from "@usine/core/worker";
import {
  type Executor,
  ExecutorOperationError,
  type ExecutorError,
  fullPreflight,
  type MachineCheck,
  type PreflightReport,
  type WorkerCapabilityError,
} from "@usine/executor";
import {
  DateTime,
  Duration,
  Effect,
  Exit,
  FiberMap,
  Option,
  Ref,
  Result,
  Semaphore,
  TxRef,
} from "effect";
import {
  recordPreflight,
  unchecked,
  WorkerPreflightRejectedError,
  type WorkerPreflight,
} from "../worker-status.ts";

const withoutWorker = <A>(
  current: ReadonlyMap<WorkerName, A>,
  worker: WorkerName,
): ReadonlyMap<WorkerName, A> =>
  current.has(worker) ? new Map([...current].filter(([name]) => name !== worker)) : current;

interface PreflightRecords {
  /** The last preflight of each Worker. */
  readonly current: ReadonlyMap<WorkerName, WorkerPreflight>;
  /**
   * The record of each Worker before the machine creation failures that `current` shows, which
   * the Worker's next machine creation restores.
   */
  readonly beforeMachineFailures: ReadonlyMap<WorkerName, WorkerPreflight>;
}

interface PreflightConfiguration {
  readonly workers: ReadonlyArray<Worker>;
  readonly roster: ReadonlyArray<BrainSpec>;
}

export const preflightFor = Effect.fn("WorkerScheduler.preflightFor")(function* (
  executor: Pick<Executor["Service"], "preflight">,
  initialize: (worker: Worker) => Effect.Effect<void, ExecutorError>,
) {
  const bus = yield* ChangeBus;
  const changed = (worker: WorkerName) =>
    bus.publish([{ audience: InstanceScope.make(), target: { kind: "worker", id: worker } }]);
  const configuration = yield* Ref.make<PreflightConfiguration>({ workers: [], roster: [] });
  const records = yield* Ref.make<PreflightRecords>({
    current: new Map(),
    beforeMachineFailures: new Map(),
  });
  const blocked = yield* TxRef.make<ReadonlyMap<WorkerName, string>>(new Map());
  const requested = yield* TxRef.make<ReadonlySet<WorkerName>>(new Set());
  const checking = yield* TxRef.make<ReadonlySet<WorkerName>>(new Set());
  const inFlight = Effect.all([TxRef.get(requested), TxRef.get(checking)]).pipe(
    Effect.map(([requested, checking]) => new Set([...requested, ...checking])),
  );
  const retries = yield* FiberMap.make<WorkerName>();
  const exclusive = yield* Semaphore.make(1);

  const record = Effect.fn("WorkerScheduler.recordPreflight")(function* (
    worker: WorkerName,
    roster: ReadonlyArray<BrainSpec>,
    exit: Exit.Exit<PreflightReport, ExecutorError>,
  ) {
    yield* Effect.annotateCurrentSpan({ worker });
    const outcome: Option.Option<Result.Result<PreflightReport, ExecutorError>> = Exit.isSuccess(
      exit,
    )
      ? Option.some(Result.succeed(exit.value))
      : Option.map(Exit.findErrorOption(exit), Result.fail);
    if (Option.isNone(outcome)) return;
    const checkedAt = yield* DateTime.now;
    yield* Ref.update(records, ({ current, beforeMachineFailures }) => ({
      current: new Map(current).set(
        worker,
        recordPreflight(current.get(worker) ?? unchecked(worker), roster, checkedAt, outcome.value),
      ),
      beforeMachineFailures: withoutWorker(beforeMachineFailures, worker),
    }));
  });

  /**
   * Records a check that failed while the Worker created a machine. The next machine that the
   * Worker creates clears the failure.
   */
  const machineFailed = Effect.fn("WorkerScheduler.recordMachineFailure")(function* (
    worker: WorkerName,
    roster: ReadonlyArray<BrainSpec>,
    error: WorkerCapabilityError,
  ) {
    yield* Effect.annotateCurrentSpan({ worker });
    const checkedAt = yield* DateTime.now;
    yield* Ref.update(records, ({ current, beforeMachineFailures }) => {
      const previous = current.get(worker) ?? unchecked(worker);
      return {
        current: new Map(current).set(
          worker,
          recordPreflight(previous, roster, checkedAt, Result.fail(error)),
        ),
        beforeMachineFailures: beforeMachineFailures.has(worker)
          ? beforeMachineFailures
          : new Map(beforeMachineFailures).set(worker, previous),
      };
    });
    yield* Effect.logInfo("Machine creation failed a worker check; the next machine clears it", {
      worker,
      capability: error.capability,
    });
    yield* changed(worker);
  });

  /**
   * Records a machine that the Worker created: its check if it got one, or else the record from
   * before the machine creation failures that the current record shows.
   */
  const machineCreated = Effect.fn("WorkerScheduler.recordMachineCreation")(function* (
    worker: WorkerName,
    checked: Option.Option<MachineCheck>,
  ) {
    yield* Effect.annotateCurrentSpan({ worker });
    if (Option.isSome(checked)) {
      const { brains, containerLimits, findings } = checked.value;
      yield* record(worker, brains, Exit.succeed({ ...fullPreflight, containerLimits, findings }));
      return yield* changed(worker);
    }
    const restored = yield* Ref.modify(records, (state) => {
      const before = state.beforeMachineFailures.get(worker);
      if (before === undefined) return [false, state] as const;
      return [
        true,
        {
          current: new Map(state.current).set(worker, before),
          beforeMachineFailures: withoutWorker(state.beforeMachineFailures, worker),
        },
      ] as const;
    });
    if (!restored) return;
    yield* Effect.logInfo(
      "Machine created; cleared the worker check that a machine creation failed",
      {
        worker,
      },
    );
    yield* changed(worker);
  });

  const check = Effect.fn("WorkerScheduler.checkPreflight")(function* (
    worker: Worker,
    roster: ReadonlyArray<BrainSpec>,
  ) {
    yield* Effect.annotateCurrentSpan({ worker: worker.name });
    return yield* Effect.acquireUseRelease(
      TxRef.update(checking, (current) => new Set([...current, worker.name])).pipe(
        Effect.andThen(changed(worker.name)),
      ),
      () =>
        initialize(worker).pipe(
          Effect.andThen(executor.preflight(worker.name, roster, worker.maxConcurrentAttempts)),
          Effect.mapError((error) =>
            error._tag === "ExecutorOperationError"
              ? ExecutorOperationError.make({
                  operation: error.operation,
                  cause: error.cause,
                  message: `worker "${worker.name}": ${error.message}`,
                })
              : error,
          ),
          Effect.onExit((exit) => record(worker.name, roster, exit)),
        ),
      () =>
        TxRef.update(
          checking,
          (current) => new Set([...current].filter((name) => name !== worker.name)),
        ).pipe(Effect.andThen(changed(worker.name))),
    );
  });

  const recover = Effect.fn("WorkerScheduler.retryPreflight")(function* (name: WorkerName) {
    yield* Effect.annotateCurrentSpan({ worker: name });

    if (!(yield* TxRef.get(blocked)).has(name)) return false;
    const { workers, roster } = yield* Ref.get(configuration);
    const worker = workers.find((worker) => worker.name === name);
    if (worker === undefined) return false;
    const result = yield* check(worker, roster).pipe(Effect.result);
    if (Result.isFailure(result)) {
      yield* TxRef.update(blocked, (current) => new Map(current).set(name, result.failure.message));
      yield* Effect.logWarning("Worker preflight still fails; scheduling stays disabled", {
        worker: name,
        errorTag: result.failure._tag,
        message: result.failure.message,
      });
      yield* changed(name);
      return true;
    }
    yield* TxRef.update(
      blocked,
      (current) => new Map([...current].filter(([worker]) => worker !== name)),
    );
    yield* changed(name);
    yield* Effect.logInfo("Worker preflight passed; scheduling resumed", { worker: name });
    return false;
  });

  const retry = (worker: WorkerName) =>
    Effect.gen(function* () {
      let failures = 0;
      while (true) {
        const minutes = [1, 2, 5][failures] ?? 10;
        yield* Effect.logInfo("Worker preflight will be retried; its runs wait", {
          worker,
          retryAfterMinutes: minutes,
        });
        yield* Effect.sleep(Duration.minutes(minutes));
        if (!(yield* exclusive.withPermit(recover(worker)))) return;
        failures += 1;
      }
    });

  const start = Effect.fn("WorkerScheduler.preflight")(function* (
    workers: ReadonlyArray<Worker>,
    roster: ReadonlyArray<BrainSpec>,
  ) {
    yield* Ref.set(configuration, { workers, roster });
    const results = yield* Effect.forEach(
      workers,
      (worker) =>
        check(worker, roster).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("Worker preflight failed; scheduling disabled", {
              worker: worker.name,
              errorTag: error._tag,
              message: error.message,
            }),
          ),
          Effect.result,
          Effect.map((result) => ({ worker: worker.name, result })),
        ),
      { concurrency: "unbounded" },
    );
    const failures = results.flatMap(({ worker, result }) =>
      Result.isFailure(result) ? [{ worker, error: result.failure }] : [],
    );
    const first = failures[0];
    if (first !== undefined && failures.length === workers.length) return yield* first.error;
    yield* TxRef.set(
      blocked,
      new Map(failures.map(({ worker, error }) => [worker, error.message])),
    );
    yield* Effect.forEach(failures, ({ worker }) => FiberMap.run(retries, worker, retry(worker)), {
      discard: true,
    });
  });

  const run = Effect.fn("WorkerScheduler.runPreflight")(function* (
    name: WorkerName,
    leased: Effect.Effect<number>,
  ) {
    yield* Effect.annotateCurrentSpan({ worker: name });
    const acquire = Effect.tx(
      Effect.gen(function* () {
        if ((yield* inFlight).has(name))
          return yield* WorkerPreflightRejectedError.make({
            worker: name,
            reason: "preflight-running",
            message: `Preflight is already running on worker "${name}".`,
          });
        if ((yield* leased) > 0)
          return yield* WorkerPreflightRejectedError.make({
            worker: name,
            reason: "attempt-running",
            message: `An attempt is running on worker "${name}". Run preflight after all attempts end.`,
          });
        yield* TxRef.update(requested, (current) => new Set([...current, name]));
      }),
    );
    return yield* Effect.acquireUseRelease(
      acquire,
      () =>
        exclusive.withPermit(
          Effect.gen(function* () {
            const { workers, roster } = yield* Ref.get(configuration);
            const worker = workers.find((worker) => worker.name === name);
            if (worker === undefined)
              return yield* WorkerPreflightRejectedError.make({
                worker: name,
                reason: "not-configured",
                message: `Worker "${name}" is not configured.`,
              });
            yield* Effect.logInfo("On-demand worker preflight started", { worker: name });
            const result = yield* check(worker, roster).pipe(Effect.result);
            if (Result.isFailure(result)) {
              yield* TxRef.update(blocked, (current) =>
                new Map(current).set(name, result.failure.message),
              );
              yield* Effect.logWarning("On-demand worker preflight failed; scheduling disabled", {
                worker: name,
                errorTag: result.failure._tag,
                message: result.failure.message,
              });
              yield* FiberMap.run(retries, name, retry(name));
            } else {
              yield* TxRef.update(
                blocked,
                (current) => new Map([...current].filter(([worker]) => worker !== name)),
              );
              yield* FiberMap.remove(retries, name);
              yield* Effect.logInfo("On-demand worker preflight passed; scheduling resumed", {
                worker: name,
              });
            }
            yield* changed(name);

            return (yield* Ref.get(records)).current.get(name) ?? unchecked(name);
          }),
        ),
      () =>
        TxRef.update(
          requested,
          (current) => new Set([...current].filter((worker) => worker !== name)),
        ),
    ).pipe(
      Effect.tapError((error) =>
        Effect.logInfo("On-demand worker preflight refused", {
          worker: name,
          reason: error.reason,
        }),
      ),
    );
  });

  const accept = Effect.fn("WorkerScheduler.acceptPreflight")(function* (
    declared: ReadonlyArray<Worker>,
    roster: ReadonlyArray<BrainSpec>,
    checked: ReadonlySet<WorkerName>,
  ) {
    yield* Ref.set(configuration, { workers: declared, roster });
    const names = new Set(declared.map(({ name }) => name));
    const previous = yield* TxRef.get(blocked);
    const next = new Map(
      [...previous].filter(([worker]) => names.has(worker) && !checked.has(worker)),
    );
    yield* TxRef.set(blocked, next);
    yield* Effect.forEach(
      [...previous.keys()].filter((worker) => !next.has(worker)),
      (worker) =>
        FiberMap.remove(retries, worker).pipe(
          Effect.andThen(
            Effect.logInfo(
              names.has(worker)
                ? "Worker preflight passed on reload; scheduling resumed"
                : "Failed worker removed; preflight retries stopped",
              { worker },
            ),
          ),
        ),
      { discard: true },
    );
  });

  const refresh = Effect.fn("WorkerScheduler.refreshPreflight")(function* (
    workers: ReadonlyArray<Worker>,
  ) {
    yield* Effect.annotateCurrentSpan({ workers: workers.map(({ name }) => name) });
    yield* TxRef.update(
      blocked,
      (current) =>
        new Map([
          ...current,
          ...workers.map(({ name }) => [name, "Checking changed worker connection"] as const),
        ]),
    );
    yield* Effect.forEach(
      workers,
      (worker) =>
        Effect.gen(function* () {
          yield* FiberMap.remove(retries, worker.name);
          yield* Effect.logInfo("Worker connection changed; running attempts keep their machine", {
            worker: worker.name,
          });
          if (yield* recover(worker.name))
            yield* FiberMap.run(retries, worker.name, retry(worker.name));
        }),
      { concurrency: "unbounded", discard: true },
    );
  });

  const wait = (worker: WorkerName) =>
    Effect.tx(
      Effect.gen(function* () {
        if ((yield* TxRef.get(blocked)).has(worker) || (yield* inFlight).has(worker))
          return yield* Effect.txRetry;
      }),
    );

  return {
    wait,
    start,
    run,
    checking: inFlight,
    refresh,
    check,
    machineFailed,
    machineCreated,
    accept,
    exclusive,
    blocked: Effect.all([TxRef.get(blocked), TxRef.get(requested)]).pipe(
      Effect.map(([blocked, requested]) => new Set([...blocked.keys(), ...requested])),
    ),
    unavailable: TxRef.get(blocked).pipe(
      Effect.map((current) => [...current].map(([worker, message]) => ({ worker, message }))),
    ),
    records: Ref.get(records).pipe(Effect.map(({ current }) => [...current.values()])),
  };
});
