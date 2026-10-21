import type { AttemptId } from "@usine/core/attempt";
import type { AttemptRecovery } from "@usine/core/attempt/salvage";
import { Effect, Option, Ref } from "effect";
import type { StepExecutor, WorkerLease } from "../step-executor.ts";

/**
 * The Worker slots startup occupies for the open Attempts whose checkout it
 * keeps for a reattachment, because their parent task is live or its
 * liveness could not be read (#177). Each slot counts its Attempt on the
 * Worker the Attempt already runs on before any Run reserves one, so no new
 * Attempt takes it while the Attempt's Run reads whether to reattach it.
 * `take` hands a slot to the Attempt's Run, which reattaches the Attempt in
 * it or releases it. `release` gives back the slot of an Attempt whose Run
 * closes it before taking the slot, as a cancel does. `RunDriver` exposes
 * these steps to the engine.
 */
export const reattachSlotsFor = Effect.fn("ReattachSlots.for")(function* (
  executor: StepExecutor["Service"],
) {
  const occupied = yield* Ref.make<ReadonlyMap<AttemptId, WorkerLease>>(new Map());

  /** Occupies a slot on the Worker of each of `attempts`, the open Attempts whose checkout startup kept. */
  const occupy = Effect.fn("ReattachSlots.occupy")(function* (
    attempts: ReadonlyArray<AttemptRecovery>,
  ) {
    yield* Effect.forEach(
      attempts,
      ({ attemptId, worker }) =>
        // Recorded in the same uninterruptible step as the lease, so no slot is occupied unrecorded.
        executor.occupy(worker).pipe(
          Effect.flatMap((lease) =>
            Ref.update(occupied, (leases) => new Map(leases).set(attemptId, lease)),
          ),
          Effect.tap(() =>
            Effect.logInfo(
              "Occupied a slot on the Worker of an open Attempt kept for its Run to reattach",
              { attemptId, worker },
            ),
          ),
          Effect.uninterruptible,
        ),
      { discard: true },
    );
  });

  /** Hands the slot startup occupied for `attemptId` to its Run, which releases it; none when startup occupied none or the Run took it. */
  const take = (attemptId: AttemptId): Effect.Effect<Option.Option<WorkerLease>> =>
    Ref.modify(occupied, (leases) => {
      const lease = leases.get(attemptId);
      if (lease === undefined) return [Option.none(), leases];
      const remaining = new Map(leases);
      remaining.delete(attemptId);
      return [Option.some(lease), remaining];
    });

  /** Releases the slot startup occupied for `attemptId`, an Attempt whose Run closed it before taking the slot. */
  const release = Effect.fn("ReattachSlots.release")(function* (attemptId: AttemptId) {
    yield* Effect.annotateCurrentSpan({ attemptId });
    const lease = yield* take(attemptId);
    if (Option.isNone(lease)) {
      yield* Effect.logDebug("No slot startup occupied for the Attempt awaits its release", {
        attemptId,
      });
      return;
    }
    yield* lease.value.release;
    yield* Effect.logInfo(
      "Released the slot startup occupied for an Attempt its Run closed before taking it",
      { attemptId, worker: lease.value.worker },
    );
  }, Effect.uninterruptible);

  return { occupy, take, release } as const;
});
