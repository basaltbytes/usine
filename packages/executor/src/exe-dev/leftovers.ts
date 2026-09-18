import { safeSegment } from "@usine/core/repository";
import type { WorkerName } from "@usine/core/worker";
import { Effect, Ref, Result } from "effect";
import type { ExecutorOperationError } from "../executor.ts";
import { keyedLockFor } from "../keyed-lock.ts";
import type { ExeDevCommands } from "./commands.ts";
import type { VmState } from "./model.ts";
import { attemptPathsOn } from "./sweep.ts";

/** What earlier processes left on one exe.dev Worker, as seen by this process. */
export interface WorkerLeftovers {
  readonly vm: VmState;
  /** The Worker's state directory on its VM. */
  readonly root: string;
  /** The paths found directly under the Worker's `attempts` directory. */
  readonly checkouts: ReadonlySet<string>;
}

/**
 * Resolves a Worker's VM and lists its leftover Attempt checkouts once per
 * process. Reconciliation visits every persisted Attempt, so resolving and
 * inspecting each one over SSH would stall startup on the whole Run history;
 * after the first listing, an Attempt with no leftover checkout costs nothing.
 *
 * A failed listing is remembered too: a Worker that is gone must not be retried
 * for each of its Attempts. Its checkouts stay in place for the next process.
 */
export const workerLeftoversFor = Effect.fn("ExeDevExecutor.workerLeftoversFor")(function* <E>(
  commands: ExeDevCommands,
  vmFor: (worker: WorkerName) => Effect.Effect<VmState, E>,
) {
  const locks = yield* keyedLockFor<WorkerName>();
  const listed = yield* Ref.make(
    new Map<WorkerName, Result.Result<WorkerLeftovers, E | ExecutorOperationError>>(),
  );

  const list = Effect.fn("ExeDevExecutor.listWorkerLeftovers")(function* (worker: WorkerName) {
    const vm = yield* vmFor(worker);
    yield* Effect.annotateCurrentSpan({ worker, host: vm.sshDest });
    const root = `${vm.home}/.usine/workers/${safeSegment(worker)}`;
    const checkouts = new Set(yield* attemptPathsOn(commands, "cleanup", vm, `${root}/attempts`));
    yield* Effect.logInfo("Listed exe.dev checkouts left for reconciliation", {
      worker,
      host: vm.sshDest,
      checkouts: checkouts.size,
    });
    return { vm, root, checkouts } satisfies WorkerLeftovers;
  });

  return Effect.fn("ExeDevExecutor.workerLeftovers")(function* (worker: WorkerName) {
    yield* Effect.annotateCurrentSpan({ worker });
    return yield* locks.withLock(worker)(
      Effect.gen(function* () {
        const known = (yield* Ref.get(listed)).get(worker);
        if (known !== undefined) return yield* Effect.fromResult(known);
        const result = yield* Effect.result(list(worker));
        yield* Ref.update(listed, (current) => new Map(current).set(worker, result));
        if (Result.isFailure(result)) {
          yield* Effect.logWarning(
            "Could not list exe.dev checkouts; this Worker is not reconciled until the next start",
            { worker, message: String(result.failure) },
          );
        }
        return yield* Effect.fromResult(result);
      }),
    );
  });
});
