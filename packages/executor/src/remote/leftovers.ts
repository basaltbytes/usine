import type { WorkerName } from "@usine/core/worker";
import { Effect } from "effect";
import { listedOncePerWorker } from "../leftovers.ts";
import type { RemoteCommands } from "./commands.ts";
import type { RemoteMachine } from "./machine.ts";
import { attemptPathsOn } from "./sweep.ts";

/** What earlier processes left on one remote Worker, as seen by this process. */
interface WorkerLeftovers<M extends RemoteMachine> {
  readonly machine: M;
  /** The paths found directly under the Worker's `attempts` directory. */
  readonly checkouts: ReadonlySet<string>;
}

/**
 * Resolves a Worker's machine, runs `reclaim` on it, and lists its leftover
 * Attempt checkouts once per Worker for this executor, so reconciling an
 * Attempt with no leftover checkout needs no SSH round trip. A Worker that
 * cannot be resolved or listed stays unreconciled until the next start.
 */
export const workerLeftoversFor = <M extends RemoteMachine, E>(
  commands: RemoteCommands,
  machineFor: (worker: WorkerName) => Effect.Effect<M, E>,
  reclaim: (worker: WorkerName) => Effect.Effect<void>,
) =>
  listedOncePerWorker(
    Effect.fn("RemoteExecutor.listWorkerLeftovers")(function* (worker: WorkerName) {
      const machine = yield* machineFor(worker);
      const host = machine.shell.destination;
      yield* Effect.annotateCurrentSpan({ worker, host });
      yield* reclaim(worker);
      const checkouts = new Set(
        yield* attemptPathsOn(
          commands,
          "cleanup",
          machine.shell,
          `${machine.workerDirectory}/attempts`,
        ),
      );
      yield* Effect.logInfo("Listed remote checkouts left for reconciliation", {
        worker,
        host,
        checkouts: checkouts.size,
      });
      return { machine, checkouts } satisfies WorkerLeftovers<M>;
    }),
  );
