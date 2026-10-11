import { safeSegment } from "@usine/core/repository";
import type { WorkerName } from "@usine/core/worker";
import { Effect } from "effect";
import { listedOncePerWorker } from "../leftovers.ts";
import type { ExeDevCommands } from "./commands.ts";
import type { VmState } from "./model.ts";
import { attemptPathsOn } from "./sweep.ts";

/** What earlier processes left on one exe.dev Worker, as seen by this process. */
interface WorkerLeftovers {
  readonly vm: VmState;
  /** The Worker's state directory on its VM. */
  readonly root: string;
  /** The paths found directly under the Worker's `attempts` directory. */
  readonly checkouts: ReadonlySet<string>;
}

/**
 * Resolves a Worker's VM and lists its leftover Attempt checkouts once per
 * Worker for this executor, so reconciling an Attempt with no leftover checkout
 * needs no SSH round trip. A Worker that cannot be resolved or listed stays
 * unreconciled until the next start.
 */
export const workerLeftoversFor = <E>(
  commands: ExeDevCommands,
  vmFor: (worker: WorkerName) => Effect.Effect<VmState, E>,
) =>
  listedOncePerWorker(
    Effect.fn("ExeDevExecutor.listWorkerLeftovers")(function* (worker: WorkerName) {
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
    }),
  );
