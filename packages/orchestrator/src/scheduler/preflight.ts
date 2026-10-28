import type { Worker } from "@usine/config/factory";
import type { BrainSpec } from "@usine/core/agent/brain";
import type { WorkerName } from "@usine/core/worker";
import {
  type Executor,
  ExecutorOperationError,
  type ExecutorError,
  type PreflightReport,
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
import { recordPreflight, unchecked, type WorkerPreflight } from "../worker-status.ts";

interface PreflightConfiguration {
  readonly workers: ReadonlyArray<Worker>;
  readonly roster: ReadonlyArray<BrainSpec>;
}

export const preflightFor = Effect.fn("WorkerScheduler.preflightFor")(function* (
  executor: Pick<Executor["Service"], "preflight">,
  initialize: (worker: Worker) => Effect.Effect<void, ExecutorError>,
) {
  const configuration = yield* Ref.make<PreflightConfiguration>({ workers: [], roster: [] });
  const records = yield* Ref.make(new Map<WorkerName, WorkerPreflight>());
  const blocked = yield* TxRef.make<ReadonlyMap<WorkerName, string>>(new Map());
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
    yield* Ref.update(records, (current) =>
      new Map(current).set(
        worker,
        recordPreflight(current.get(worker) ?? unchecked(worker), roster, checkedAt, outcome.value),
      ),
    );
  });

  const check = Effect.fn("WorkerScheduler.checkPreflight")(function* (
    worker: Worker,
    roster: ReadonlyArray<BrainSpec>,
  ) {
    yield* Effect.annotateCurrentSpan({ worker: worker.name });
    return yield* initialize(worker).pipe(
      Effect.andThen(executor.preflight(worker.name, roster, worker.maxConcurrentAttempts)),
      Effect.mapError((error) =>
        error._tag === "ExecutorOperationError"
          ? new ExecutorOperationError({
              operation: error.operation,
              cause: error.cause,
              message: `worker "${worker.name}": ${error.message}`,
            })
          : error,
      ),
      Effect.onExit((exit) => record(worker.name, roster, exit)),
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
      return true;
    }
    yield* TxRef.update(
      blocked,
      (current) => new Map([...current].filter(([worker]) => worker !== name)),
    );
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

  return {
    start,
    check,
    record,
    accept,
    exclusive,
    blocked: TxRef.get(blocked).pipe(Effect.map((current) => new Set(current.keys()))),
    unavailable: TxRef.get(blocked).pipe(
      Effect.map((current) => [...current].map(([worker, message]) => ({ worker, message }))),
    ),
    records: Ref.get(records).pipe(Effect.map((current) => [...current.values()])),
  };
});
