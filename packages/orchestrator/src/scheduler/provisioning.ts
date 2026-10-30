import { ProvisionerTimings, type WorkerName } from "@usine/core/worker";
import type { MachineUnavailableError, WorkerCapabilityError } from "@usine/executor";
import { DateTime, Duration, Effect, Option, TxRef } from "effect";
import type { CurrentInstance } from "../current-instance/current-instance.ts";
import type { ProvisioningPause } from "../worker-status.ts";

export type WorkerPause = Omit<ProvisioningPause, "waitingRuns">;

/** Returns the capped delay after consecutive machine creation failures. */
const pauseAfter = (failures: number, timings: ProvisionerTimings): Duration.Duration =>
  Duration.seconds(
    Math.min(
      timings.creationBackoffMin * 2 ** Math.min(failures - 1, 52),
      timings.creationBackoffMax,
    ),
  );

export const provisioningPausesFor = Effect.fn("WorkerScheduler.provisioningPausesFor")(function* (
  instances: Pick<CurrentInstance["Service"], "get">,
) {
  const scope = yield* Effect.scope;
  const paused = yield* TxRef.make<ReadonlyMap<WorkerName, WorkerPause>>(new Map());
  const clear = Effect.fn("WorkerScheduler.clearProvisioningPause")(function* (worker: WorkerName) {
    yield* Effect.annotateCurrentSpan({ worker });
    const previous = yield* TxRef.modify(paused, (current) => {
      const next = new Map(current);
      next.delete(worker);
      return [current.get(worker), next];
    });
    if (previous !== undefined)
      yield* Effect.logInfo("Cleared worker provisioning pause", {
        worker,
        reason: previous.reason,
      });
  });

  /** Pauses machine creation on `worker` after `failure`, and resumes it when the pause ends. */
  const pause = Effect.fn("WorkerScheduler.pauseWorker")(function* (
    worker: WorkerName,
    failure: MachineUnavailableError | WorkerCapabilityError,
  ) {
    const { config } = yield* instances.get;
    const configured = config.workers.find(({ name }) => name === worker);
    const timings =
      configured?.kind === "ssh" && Option.isSome(configured.provisioner)
        ? configured.provisioner.value.timings
        : new ProvisionerTimings({});
    yield* Effect.annotateCurrentSpan({ worker });
    const failedAt = yield* DateTime.now;
    const pause = yield* Effect.tx(
      TxRef.modify(paused, (current) => {
        const failures = (current.get(worker)?.failures ?? 0) + 1;
        const delay = pauseAfter(failures, timings);
        const next: WorkerPause = {
          quota:
            failure._tag === "MachineUnavailableError" && failure.reason === "quota"
              ? Option.some(failure.message)
              : (current.get(worker)?.quota ?? Option.none()),
          worker,
          reason: failure._tag === "MachineUnavailableError" ? failure.reason : "check",
          message: failure.message,
          failures,
          failedAt,
          retryAt: DateTime.addDuration(failedAt, delay),
          blocked: true,
        };
        return [next, new Map(current).set(worker, next)] as const;
      }),
    );
    yield* Effect.logWarning(
      "A provisioned Worker could not create a machine; its Attempts wait and it tries again after a pause",
      {
        worker,
        reason: pause.reason,
        message: pause.message,
        quota: pause.quota,
        failures: pause.failures,
        retryAt: DateTime.formatIso(pause.retryAt),
      },
    );
    yield* Effect.sleep(DateTime.distance(failedAt, pause.retryAt)).pipe(
      Effect.andThen(
        Effect.tx(
          TxRef.modify(paused, (current) =>
            current.get(worker) !== pause
              ? [false, current]
              : [true, new Map(current).set(worker, { ...pause, blocked: false })],
          ),
        ),
      ),
      Effect.tap((resumed) =>
        resumed
          ? Effect.logInfo("A provisioned Worker's pause ended; it creates machines again", {
              worker,
              failures: pause.failures,
            })
          : Effect.logDebug("Skipped an obsolete provisioning pause timer", {
              worker,
              failures: pause.failures,
            }),
      ),
      Effect.forkIn(scope),
    );
  }, Effect.uninterruptible);

  const wait = (worker: WorkerName) =>
    Effect.tx(
      Effect.gen(function* () {
        if ((yield* TxRef.get(paused)).get(worker)?.blocked === true) yield* Effect.txRetry;
      }),
    );
  return { current: TxRef.get(paused), wait, clear, pause };
});
