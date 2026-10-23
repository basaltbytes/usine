import type { WorkerName } from "@usine/core/worker";
import { Effect } from "effect";
import { listedOncePerWorker } from "../leftovers.ts";
import type { RemoteCommands } from "./commands.ts";
import type { RemoteMachine } from "./machine.ts";
import { attemptPathsOn } from "./sweep.ts";

interface WorkerLeftovers<M extends RemoteMachine> {
  readonly machine: M;
  /** The paths directly under the Worker's `attempts` directory. */
  readonly checkouts: ReadonlySet<string>;
}

/**
 * Resolves a Worker's machine, runs `reclaim` on it, and lists its leftover checkouts, once per
 * Worker per executor. A Worker that can't be resolved or listed isn't reconciled until the
 * next start.
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
