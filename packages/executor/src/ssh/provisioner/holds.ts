import { InstanceScope } from "@usine/core/access";
import { ChangeBus, type ScopedChange } from "@usine/core/changes";
import type { AttemptId } from "@usine/core/attempt";
import type { Run } from "@usine/core/run";
import type { MachineId, MachineProvider, WorkerName } from "@usine/core/worker";
import { DateTime, Effect, Option, Ref } from "effect";
import { MachineHold, MachineStatus } from "../../executor.ts";
import type { MachineDriver } from "./model.ts";
import type { SshWorkerEntry } from "../workers.ts";
import type { SshMachine } from "../model.ts";

export interface Held {
  readonly hold: MachineHold;
  readonly driver: MachineDriver;
  readonly workerEntry: SshWorkerEntry;
  readonly worker: WorkerName;
  readonly provider: MachineProvider;
  /**
   * `creating` until the machine answers over SSH, `preparing` during machine preflight,
   * `located` while it serves an Attempt,
   * `unlocated` when the machine must be looked up with the current worker configuration,
   * `idle` after cleanup while it is available for another attempt, and `deleting` until deletion succeeds.
   */
  readonly state: "creating" | "preparing" | "located" | "unlocated" | "deleting" | "idle";
  readonly uses: number;
  readonly since: DateTime.Utc;
  readonly id: Option.Option<MachineId>;
  readonly run: Option.Option<Pick<Run, "id" | "loop">>;
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

export const machineStatusOf = (entry: Held): MachineStatus =>
  MachineStatus.make({
    worker: entry.worker,
    provider: entry.provider,
    state: entry.state === "located" || entry.state === "unlocated" ? "ready" : entry.state,
    id: entry.id,
    runId: Option.map(entry.run, ({ id }) => id),
    attemptId: entry.attemptId,
    since: entry.since,
    attempts: entry.uses,
  });

export const machineHolds = Effect.gen(function* () {
  const bus = yield* ChangeBus;
  const changed = (...entries: ReadonlyArray<Held>) => {
    const changes = new Map<string, ScopedChange>();
    for (const entry of entries) {
      changes.set(`worker:${entry.worker}`, {
        audience: InstanceScope.make(),
        target: { kind: "worker", id: entry.worker },
      });
      for (const run of Option.toArray(entry.run))
        changes.set(`run:${run.id}`, {
          audience: { _tag: "Loop", loop: run.loop },
          target: { kind: "run", id: run.id },
        });
    }
    return bus.publish([...changes.values()]);
  };
  const held = yield* Ref.make<ReadonlyMap<MachineHold, Held>>(new Map());
  const nextHold = yield* Ref.make(0);
  const register = (fields: Omit<Held, "hold">) =>
    Ref.getAndUpdate(nextHold, (count) => count + 1).pipe(
      Effect.map((count): Held => ({
        ...fields,
        hold: MachineHold.make(`machine-${String(count)}`),
      })),
      Effect.tap((entry) => Ref.update(held, (current) => new Map(current).set(entry.hold, entry))),
      Effect.tap(changed),
    );
  const update = (hold: MachineHold, change: (entry: Held) => Held) =>
    Ref.modify(held, (current) => {
      const entry = current.get(hold);
      if (entry === undefined) return [Option.none<readonly [Held, Held]>(), current] as const;
      const next = change(entry);
      return [Option.some([entry, next] as const), new Map(current).set(hold, next)] as const;
    }).pipe(
      Effect.flatMap(
        Option.match({ onNone: () => Effect.void, onSome: (entries) => changed(...entries) }),
      ),
    );
  const unregister = (hold: MachineHold) =>
    Ref.modify(held, (current) => {
      const next = new Map(current);
      next.delete(hold);
      return [Option.fromNullishOr(current.get(hold)), next] as const;
    }).pipe(Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: changed })));
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

  const takeIdle = (worker: WorkerName, run: Pick<Run, "id" | "loop">, attemptId: AttemptId) =>
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
            run: Option.some(run),
            attemptId: Option.some(attemptId),
            uses: idle.uses + 1,
          };
          const next = new Map(current);
          next.delete(idle.hold);
          next.set(claimed.hold, claimed);
          return [Option.some(claimed), next] as const;
        }).pipe(Effect.tap(Option.match({ onNone: () => Effect.void, onSome: changed }))),
      ),
    );
  const retireIdle = (hold: MachineHold) =>
    Ref.modify(held, (current) => {
      const entry = current.get(hold);
      if (entry?.state !== "idle") return [false, current] as const;
      return [true, new Map(current).set(hold, { ...entry, state: "deleting" })] as const;
    }).pipe(
      Effect.tap((retired) =>
        retired
          ? entryOf(hold).pipe(
              Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: changed })),
            )
          : Effect.void,
      ),
    );
  return { held, register, update, unregister, entryOf, byAttempt, takeIdle, retireIdle };
});
