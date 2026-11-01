import type { AttemptId } from "@usine/core/attempt";
import type { RunId } from "@usine/core/run";
import type { MachineId, MachineProvider, WorkerName } from "@usine/core/worker";
import { DateTime, Effect, Option, Ref } from "effect";
import { MachineHold } from "../../executor.ts";
import type { SshMachine } from "../model.ts";

export interface Held {
  readonly hold: MachineHold;
  readonly worker: WorkerName;
  readonly provider: MachineProvider;
  /**
   * `creating` until the machine answers over SSH, `located` while it serves an Attempt,
   * `unlocated` when the machine must be looked up with the current worker configuration,
   * `idle` after cleanup while it is available for another attempt, and `deleting` until deletion succeeds.
   */
  readonly state: "creating" | "located" | "unlocated" | "deleting" | "idle";
  readonly uses: number;
  readonly since: DateTime.Utc;
  readonly id: Option.Option<MachineId>;
  readonly runId: Option.Option<RunId>;
  readonly attemptId: Option.Option<AttemptId>;
  readonly machine: Option.Option<SshMachine>;
  /**
   * `lease` while the scheduler's lease holds it, `recovery` while startup recovery reconciles
   * its checkout, and `retained` while it keeps a checkout that no Attempt in this process will
   * remove, until the next process.
   */
  readonly holder: "lease" | "recovery" | "retained";
  /**
   * Whether the machine has its Attempt's checkout, which keeps it from deletion: a checkout kept
   * for a reattachment, until its parent task's stop is confirmed, or with unpreserved work.
   */
  readonly checkout: boolean;
}

export const machineHolds = Effect.gen(function* () {
  const held = yield* Ref.make<ReadonlyMap<MachineHold, Held>>(new Map());
  const nextHold = yield* Ref.make(0);
  const register = (fields: Omit<Held, "hold">) =>
    Ref.getAndUpdate(nextHold, (count) => count + 1).pipe(
      Effect.map((count): Held => ({
        ...fields,
        hold: MachineHold.make(`machine-${String(count)}`),
      })),
      Effect.tap((entry) => Ref.update(held, (current) => new Map(current).set(entry.hold, entry))),
    );
  const update = (hold: MachineHold, change: (entry: Held) => Held) =>
    Ref.update(held, (current) => {
      const entry = current.get(hold);
      return entry === undefined ? current : new Map(current).set(hold, change(entry));
    });
  const unregister = (hold: MachineHold) =>
    Ref.update(held, (current) => {
      const next = new Map(current);
      next.delete(hold);
      return next;
    });
  const entryOf = (hold: MachineHold) =>
    Ref.get(held).pipe(Effect.map((current) => Option.fromNullishOr(current.get(hold))));
  const byAttempt = (attemptId: AttemptId) =>
    Ref.get(held).pipe(
      Effect.map((current) =>
        Option.fromNullishOr(
          [...current.values()].find(
            (entry) => entry.state !== "deleting" && Option.contains(entry.attemptId, attemptId),
          ),
        ),
      ),
    );

  const takeIdle = (worker: WorkerName, runId: RunId, attemptId: AttemptId) =>
    Ref.getAndUpdate(nextHold, (count) => count + 1).pipe(
      Effect.flatMap((count) =>
        Ref.modify(held, (current) => {
          const idle = [...current.values()].find(
            (entry) => entry.worker === worker && entry.state === "idle",
          );
          if (idle === undefined) return [Option.none<Held>(), current] as const;
          const claimed: Held = {
            ...idle,
            hold: MachineHold.make(`machine-${count}`),
            state: "located",
            runId: Option.some(runId),
            attemptId: Option.some(attemptId),
            uses: idle.uses + 1,
          };
          const next = new Map(current);
          next.delete(idle.hold);
          next.set(claimed.hold, claimed);
          return [Option.some(claimed), next] as const;
        }),
      ),
    );
  const retireIdle = (hold: MachineHold) =>
    Ref.modify(held, (current) => {
      const entry = current.get(hold);
      if (entry?.state !== "idle") return [false, current] as const;
      return [true, new Map(current).set(hold, { ...entry, state: "deleting" })] as const;
    });
  return { held, register, update, unregister, entryOf, byAttempt, takeIdle, retireIdle };
});
