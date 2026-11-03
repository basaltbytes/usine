import type { BrainSpec } from "@usine/core/agent/brain";
import type { AttemptId } from "@usine/core/attempt";
import type { Run } from "@usine/core/run";
import { DateTime, Duration, Effect, Equal, Exit, Option, Ref, Result, type Scope } from "effect";
import {
  MachineGrant,
  MachineUnavailableError,
  type MachineCheck,
  type MachineHold,
  ExecutorOperationError,
  type WorkerCapabilityError,
} from "../../executor.ts";
import type { SshMachine, SshWorkerAddress } from "../model.ts";
import type { SshWorkerEntry } from "../workers.ts";
import type { Held, machineHolds } from "./holds.ts";
import type { MachineDriver } from "./model.ts";

interface ReuseOptions {
  readonly instance: string;
  readonly process: string;
  readonly entries: Effect.Effect<ReadonlyArray<SshWorkerEntry>>;
  readonly scope: Scope.Scope;
  readonly holds: Effect.Success<typeof machineHolds>;
  readonly discard: (hold: MachineHold, reason: string) => Effect.Effect<void>;
  readonly reset: (machine: SshMachine) => Effect.Effect<void, ExecutorOperationError>;
  readonly forgetConnection: (attemptId: AttemptId) => Effect.Effect<void>;
  readonly check: (
    machine: SshMachine,
    brains: ReadonlyArray<BrainSpec>,
  ) => Effect.Effect<Option.Option<MachineCheck>, WorkerCapabilityError>;
}

const policyOf = (machine: SshMachine) =>
  machine.address.machine._tag === "Provisioned"
    ? machine.address.machine.provisioner.reuse
    : Option.none();
const age = (held: Held, now: DateTime.Utc) =>
  DateTime.toEpochMillis(now) - DateTime.toEpochMillis(held.since);

/** Claims idle machines atomically and schedules their retirement independently of new work. */
export const machineReuseFor = (options: ReuseOptions) => {
  const { holds, discard } = options;
  const take = Effect.fn("SshExecutor.reuseMachine")(
    (
      entry: SshWorkerEntry,
      run: Pick<Run, "id" | "loop">,
      attemptId: AttemptId,
      brains: ReadonlyArray<BrainSpec>,
      driver: MachineDriver,
    ) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const worker = entry.address.name;
          const runId = run.id;
          yield* Effect.annotateCurrentSpan({ worker, runId, attemptId });
          const found = yield* holds.takeIdle(worker, run, attemptId);
          if (Option.isNone(found)) return Option.none<MachineGrant>();
          const candidate = found.value;
          const available = Option.all([candidate.id, candidate.machine]);
          if (Option.isNone(available))
            return yield* Effect.die(new Error("Idle machine has no endpoint"));
          const [id, machine] = available.value;
          const policy = policyOf(machine);
          if (
            Option.isNone(policy) ||
            candidate.uses > policy.value.attempts ||
            age(candidate, yield* DateTime.now) >= policy.value.maxAgeMillis ||
            !Equal.equals(machine.address, entry.address)
          ) {
            yield* discard(candidate.hold, "its reuse limit or worker connection changed");
            return Option.none<MachineGrant>();
          }
          const checked = yield* restore(
            Effect.gen(function* () {
              yield* driver
                .assign(id, {
                  instance: options.instance,
                  worker,
                  run: runId,
                  process: options.process,
                  attempt: attemptId,
                  attempts: candidate.uses,
                })
                .pipe(
                  Effect.mapError(
                    (error) =>
                      new MachineUnavailableError({
                        worker,
                        provider: driver.provider,
                        reason: "provider",
                        message: error.message,
                      }),
                  ),
                );
              yield* holds.update(candidate.hold, (current) => ({
                ...current,
                state: "preparing",
              }));
              return yield* options.check(machine, brains);
            }),
          ).pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit)
                ? Effect.void
                : discard(candidate.hold, "reuse preflight or assignment failed"),
            ),
          );
          yield* holds.update(candidate.hold, (current) => ({ ...current, state: "located" }));
          yield* Effect.logInfo("Reused a machine for the attempt", {
            worker,
            runId,
            attemptId,
            machine: id,
            attempts: candidate.uses,
          });
          return Option.some(
            new MachineGrant({
              hold: candidate.hold,
              id,
              worker,
              provider: driver.provider,
              checked,
            }),
          );
        }),
      ),
  );

  const release = Effect.fn("SshExecutor.keepMachineForReuse")((current: Held) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({ worker: current.worker, hold: current.hold });
      if (current.state !== "located" || current.uses === 0 || Option.isNone(current.machine))
        return false;
      const machine = current.machine.value;
      if (!(yield* options.entries).some((entry) => Equal.equals(entry.address, machine.address))) {
        yield* Effect.logInfo("Retiring the released machine after its worker connection changed", {
          worker: current.worker,
          machine: current.id,
        });
        return false;
      }
      const policy = policyOf(machine);
      if (
        Option.isNone(policy) ||
        current.uses >= policy.value.attempts ||
        age(current, yield* DateTime.now) >= policy.value.maxAgeMillis
      )
        return false;
      const reset = yield* options.reset(machine).pipe(
        Effect.interruptible,
        Effect.timeoutOrElse({
          duration: Duration.seconds(
            machine.address.machine._tag === "Provisioned"
              ? machine.address.machine.provisioner.timings.sshWait
              : 600,
          ),
          orElse: () =>
            Effect.fail(
              new ExecutorOperationError({
                operation: "cleanup",
                message: "Machine reset timed out",
                cause: new Error("machine reset timeout"),
              }),
            ),
        }),
        Effect.onInterrupt(() => discard(current.hold, "its reset was interrupted")),
        Effect.result,
      );
      if (Result.isFailure(reset)) {
        yield* Effect.logWarning("Retiring a machine whose reset failed", {
          worker: current.worker,
          machine: current.id,
          message: reset.failure.message,
        });
        return false;
      }
      yield* Effect.forEach(Option.toArray(current.attemptId), options.forgetConnection);
      yield* holds.update(current.hold, (entry) => ({
        ...entry,
        state: "idle",
        attemptId: Option.none(),
        run: Option.none(),
      }));
      yield* Effect.logInfo("Machine is idle and available for reuse", {
        worker: current.worker,
        machine: current.id,
        attempts: current.uses,
      });
      yield* Effect.sleep(
        Math.max(0, policy.value.maxAgeMillis - age(current, yield* DateTime.now)),
      ).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            if (yield* holds.retireIdle(current.hold))
              yield* discard(current.hold, "its maximum age elapsed while idle");
          }),
        ),
        Effect.forkIn(options.scope),
      );
      return true;
    }).pipe(Effect.uninterruptible),
  );
  const refresh = Effect.fn("SshExecutor.retireChangedIdleMachines")(function* (
    address: SshWorkerAddress,
  ) {
    yield* Effect.annotateCurrentSpan({ worker: address.name });
    for (const machine of (yield* Ref.get(holds.held)).values()) {
      if (
        machine.worker === address.name &&
        !Equal.equals(machine.workerEntry.address, address) &&
        (yield* holds.retireIdle(machine.hold))
      )
        yield* discard(machine.hold, "its worker connection changed while idle");
    }
  });
  return { take, release, refresh };
};
