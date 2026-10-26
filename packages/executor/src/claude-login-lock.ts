import { ClaudeLoginLock } from "@usine/agents/runtime";
import type { MachineId, WorkerName } from "@usine/core/worker";
import { Effect, Layer, Option } from "effect";
import { keyedLockFor } from "./keyed-lock.ts";

/**
 * A `ClaudeLoginLock` with one mutex per Worker name, and one per provider machine ID for the
 * machines of provisioned Workers. Each build creates new locks, so build it once per process and
 * provide it to both the executor and the Attempt runtime.
 */
export const claudeLoginLockLayer: Layer.Layer<ClaudeLoginLock> = Layer.effect(
  ClaudeLoginLock,
  Effect.zipWith(keyedLockFor<WorkerName>(), keyedLockFor<MachineId>(), (workers, machines) =>
    ClaudeLoginLock.of({
      withLock: (worker, machine) =>
        Option.match(machine, {
          onNone: () => workers.withLock(worker),
          onSome: machines.withLock,
        }),
    }),
  ),
);
