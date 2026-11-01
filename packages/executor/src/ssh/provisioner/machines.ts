import { awaitMachineSsh, machineChecksFor, harnessCredentialGap } from "./checks.ts";
import { machineReuseFor } from "./reuse.ts";
import { machineStartsFor } from "./starts.ts";
import { machineHolds, type Held } from "./holds.ts";
import { boatTailnetsFor } from "./tailnet/bootstrap.ts";
import type { BrainSpec } from "@usine/core/agent/brain";
import type { AttemptRecovery } from "@usine/core/attempt/salvage";
import { safeSegment } from "@usine/core/repository";
import type { AttemptId } from "@usine/core/attempt";
import type { RunId } from "@usine/core/run";
import type { MachineId, MachineProvider, WorkerName } from "@usine/core/worker";
import {
  Array as Arr,
  DateTime,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  Random,
  Ref,
  Result,
} from "effect";
import {
  type ExecutorError,
  ExecutorOperationError,
  MachineGrant,
  MachineHold,
  MachineStatus,
  MachineUnavailableError,
  type PreflightReport,
  WorkerCapabilityError,
  WorkerMachines,
} from "../../executor.ts";
import type { RemoteCommands } from "../../remote/commands.ts";
import type { MachineGateway, SshExecutorOptions, SshMachine, SshProvisioner } from "../model.ts";
import {
  hostKeyAlias,
  knownHostsLine,
  type PinnedHostKey,
  type SshWorkerEntry,
} from "../workers.ts";
import { machineDriversFor } from "./drivers.ts";
import {
  attemptTag,
  type ListedMachine,
  type MachineDriver,
  type MachineEndpoint,
  machineName,
  type MachineTags,
} from "./model.ts";

export interface ProvisionedMachinesOptions {
  readonly instance: string;
  readonly commands: RemoteCommands;
  readonly workerFor: (worker: WorkerName) => Effect.Effect<SshWorkerEntry, ExecutorError>;
  readonly attemptEntry: (
    worker: WorkerName,
    attemptId: AttemptId,
    purpose?: "prepare" | "recovery",
  ) => Effect.Effect<SshWorkerEntry, WorkerCapabilityError>;
  readonly forgetConnection: (attemptId: AttemptId) => Effect.Effect<void>;
  readonly entries: Effect.Effect<ReadonlyArray<SshWorkerEntry>>;
  readonly machineAt: (
    entry: SshWorkerEntry,
    id: MachineId,
    endpoint: MachineEndpoint,
    hostKey: PinnedHostKey,
  ) => SshMachine;
  /** The machine preflight of `sshMachinePreflightFor`. */
  readonly verifyMachine: (
    machine: SshMachine,
    brains: ReadonlyArray<BrainSpec>,
    maxConcurrentAttempts: number,
  ) => Effect.Effect<PreflightReport, ExecutorError>;
  readonly reset: (machine: SshMachine) => Effect.Effect<void, ExecutorOperationError>;
  readonly verifyGatewayAdmin: (
    worker: WorkerName,
    gateway: MachineGateway,
  ) => Effect.Effect<void, WorkerCapabilityError>;
  readonly settings: Pick<
    SshExecutorOptions,
    "knownHostsDirectory" | "providerEndpoints" | "machineReadyTimeout" | "machinePollInterval"
  >;
}

const provisionerOf = (entry: SshWorkerEntry): Option.Option<SshProvisioner> =>
  entry.address.machine._tag === "Provisioned"
    ? Option.some(entry.address.machine.provisioner)
    : Option.none();

/** Returns `length` random hex digits. */
const randomHex = (length: number) =>
  Effect.forEach(Array.from({ length }), () => Random.nextIntBetween(0, 16)).pipe(
    Effect.map((digits) => digits.map((digit) => digit.toString(16)).join("")),
  );

const operationError =
  (operation: "prepare" | "cleanup") => (error: { readonly message: string }) =>
    new ExecutorOperationError({ operation, message: error.message, cause: error });

/**
 * Returns the machines of the SSH executor's provisioned Workers: the `WorkerMachines` port for
 * the scheduler, the machine of each Attempt for preparation and recovery, and the provisioned
 * Workers' preflight. Requires Node for the key and host key files.
 */
export const provisionedMachinesFor = Effect.fn("SshExecutor.provisionedMachinesFor")(function* (
  options: ProvisionedMachinesOptions,
) {
  const { instance, commands, settings } = options;
  const tailnets = yield* boatTailnetsFor(commands);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const holds = yield* machineHolds;
  const { held, register, update, unregister, entryOf, byAttempt, retireIdle } = holds;
  const scope = yield* Effect.scope;
  const checks = machineChecksFor(options.verifyMachine);
  const protectedAttempts = new Set<AttemptId>();
  const earlierMachines = new WeakMap<MachineDriver, ReadonlyArray<ListedMachine>>();
  const process = yield* randomHex(12);
  const readyTimeoutFor = (entry: SshWorkerEntry) =>
    Duration.fromInputUnsafe(
      settings.machineReadyTimeout ??
        Duration.seconds(
          entry.address.machine._tag === "Provisioned"
            ? entry.address.machine.provisioner.timings.sshWait
            : 600,
        ),
    );
  const interval = Effect.sleep(settings.machinePollInterval ?? "3 seconds");
  const knownHostsDirectory =
    settings.knownHostsDirectory === undefined
      ? yield* fs.makeTempDirectoryScoped({ prefix: "usine-known-hosts-" })
      : settings.knownHostsDirectory;
  yield* fs.makeDirectory(knownHostsDirectory, { recursive: true });
  const starts = yield* machineStartsFor(path.join(knownHostsDirectory, "machine-starts.json"));
  const knownHostsFile = (provider: MachineProvider, id: MachineId) =>
    path.join(knownHostsDirectory, `${provider}-${id}`);

  const drivers = yield* machineDriversFor(options);

  /** Deletes the machine `id` and its host key file. Fails if the provider doesn't delete it. */
  const destroy = Effect.fn("SshExecutor.deleteMachine")(function* (
    driver: MachineDriver,
    worker: WorkerName,
    id: MachineId,
  ) {
    yield* Effect.annotateCurrentSpan({ worker, machine: id, provider: driver.provider });
    yield* driver.remove(id);
    yield* fs.remove(knownHostsFile(driver.provider, id), { force: true }).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Could not remove the host key file of a deleted machine", {
          worker,
          machine: id,
          message: error.message,
        }),
      ),
      Effect.ignore,
    );
  });

  /** Lists `worker`'s machines once per process, for the Attempts of earlier processes. */
  const earlierMachinesOf = Effect.fn("SshExecutor.listEarlierMachines")(function* (
    worker: WorkerName,
    driver: MachineDriver,
  ) {
    const cached = earlierMachines.get(driver);
    if (cached !== undefined) return cached;
    const listed = yield* driver.list(instance, Option.some(worker));
    earlierMachines.set(driver, listed);
    yield* Effect.logInfo("Listed the machines of a provisioned Worker for its earlier Attempts", {
      worker,
      provider: driver.provider,
      machines: listed.length,
    });
    return listed;
  });

  /**
   * Deletes the held machine, or keeps it as `deleting` for the next sweep if that fails. An
   * unlocated machine is looked up by its Attempt first.
   */
  const discard = Effect.fn("SshExecutor.discardMachine")(function* (
    hold: MachineHold,
    reason: string,
  ) {
    const entry = yield* entryOf(hold);
    if (Option.isNone(entry)) return;
    const found = entry.value;
    const fields = {
      worker: found.worker,
      provider: found.provider,
      runId: Option.getOrElse(found.runId, () => "none"),
      attemptId: Option.getOrElse(found.attemptId, () => "none"),
      reason,
    };
    yield* update(hold, (current) => ({ ...current, state: "deleting" }));
    const driver = found.driver;
    const id = Option.isSome(found.id)
      ? Option.some(found.id.value)
      : yield* Option.match(found.attemptId, {
          onNone: () => Effect.succeedNone,
          onSome: (attemptId) =>
            earlierMachinesOf(found.worker, driver).pipe(
              Effect.map((listed) =>
                Option.map(
                  Option.fromNullishOr(
                    listed.find(({ tags }) => Option.contains(tags.attempt, attemptTag(attemptId))),
                  ),
                  ({ id: listedId }) => listedId,
                ),
              ),
              Effect.tapError((error) =>
                Effect.logWarning(
                  "Could not look up the machine to delete; the next sweep tries again",
                  {
                    ...fields,
                    message: error.message,
                  },
                ),
              ),
              Effect.orElseSucceed(() => Option.none<MachineId>()),
            ),
        });
    if (Option.isNone(id)) {
      if (Option.isSome(found.attemptId) && found.state === "unlocated") return;
      yield* unregister(hold);
      return yield* Effect.logDebug(
        "The machine doesn't exist at the provider; nothing to delete",
        fields,
      );
    }
    if (Option.isSome(found.machine)) yield* tailnets.leave(found.machine.value);
    const deleted = yield* destroy(driver, found.worker, id.value).pipe(
      Effect.as(true),
      Effect.tapError((error) =>
        Effect.logWarning("Could not delete the machine; the next sweep tries again", {
          ...fields,
          machine: id.value,
          message: error.message,
        }),
      ),
      Effect.orElseSucceed(() => false),
    );
    if (!deleted) {
      yield* update(hold, (current) => ({ ...current, id }));
      return;
    }
    yield* unregister(hold);
    yield* Effect.forEach(Option.toArray(found.attemptId), options.forgetConnection);
    yield* Effect.logInfo("Deleted the machine", { ...fields, machine: id.value });
  });

  /** Writes the `known_hosts` file that pins `key` as the host key of machine `id`. */
  const pinHostKey = Effect.fn("SshExecutor.pinHostKey")(function* (
    worker: WorkerName,
    id: MachineId,
    pinned: PinnedHostKey,
    key: string,
  ) {
    yield* fs.writeFileString(pinned.file, knownHostsLine(pinned.alias, key)).pipe(
      Effect.mapError(
        (error) =>
          new WorkerCapabilityError({
            worker,
            capability: "machine",
            message: `Can't write the host key file of machine ${id} of worker "${worker}": ${error.message}`,
            cause: error,
          }),
      ),
    );
  });

  /**
   * Returns the machine at `id` once the provider reports its SSH endpoint, with its host key
   * pinned: `created`, the key the driver gave the machine, else the key the provider reports,
   * else the key an earlier process recorded. Fails if there's none, since a first connection's
   * key isn't trusted.
   */
  const machineOf = Effect.fn("SshExecutor.machineAtEndpoint")(function* (
    entry: SshWorkerEntry,
    driver: MachineDriver,
    id: MachineId,
    created: Option.Option<string>,
  ) {
    const worker = entry.address.name;
    const pinned = {
      file: knownHostsFile(driver.provider, id),
      alias: hostKeyAlias(driver.provider, id),
    };
    if (Option.isSome(created)) yield* pinHostKey(worker, id, pinned, created.value);
    const endpoint = yield* driver.endpoint(id, interval);
    if (Option.isSome(endpoint.hostKey))
      yield* pinHostKey(worker, id, pinned, endpoint.hostKey.value);
    else if (
      Option.isNone(created) &&
      !(yield* fs.exists(pinned.file).pipe(Effect.orElseSucceed(() => false)))
    )
      return yield* new MachineUnavailableError({
        worker,
        provider: driver.provider,
        reason: "provider",
        message: `usine has no SSH host key for ${driver.provider} machine ${id} of worker "${worker}": the provider reported none, and ${pinned.file} doesn't exist. usine doesn't trust the host key of a first connection.`,
      });
    return options.machineAt(entry, id, endpoint, pinned);
  });

  const checkMachine = checks.check;

  const timedOut = (
    worker: WorkerName,
    provider: MachineProvider,
    readyTimeout: Duration.Duration,
  ) =>
    new MachineUnavailableError({
      worker,
      provider,
      reason: "timeout",
      message: `The new ${provider} machine of worker "${worker}" didn't answer over SSH within ${Duration.format(readyTimeout)}`,
    });

  const reuse = machineReuseFor({
    entries: options.entries,
    instance,
    process,
    scope,
    holds,
    discard,
    reset: options.reset,
    check: checkMachine,
  });

  const create = Effect.fn("SshExecutor.createMachine")(
    function* (
      worker: WorkerName,
      runId: RunId,
      attemptId: AttemptId,
      brains: ReadonlyArray<BrainSpec>,
    ) {
      yield* Effect.annotateCurrentSpan({ worker, runId, attemptId });
      const entry = yield* options.attemptEntry(worker, attemptId);
      const driver = yield* drivers.forEntry(entry);
      const reused = yield* reuse.take(entry, runId, attemptId, brains, driver);
      if (Option.isSome(reused)) return reused.value;
      yield* Effect.gen(function* () {
        const earlier = yield* driver.list(instance, Option.some(worker));
        for (const machine of earlier.filter(({ tags }) =>
          Option.contains(tags.attempt, attemptTag(attemptId)),
        )) {
          yield* destroy(driver, worker, machine.id);
          const previous = [...(yield* Ref.get(held)).values()].filter((entry) =>
            Option.contains(entry.id, machine.id),
          );
          yield* Effect.forEach(previous, ({ hold }) => unregister(hold), { discard: true });
          yield* Effect.logInfo(
            "Deleted a machine from an earlier failed creation before retrying",
            {
              worker,
              attemptId,
              machine: machine.id,
            },
          );
        }
      }).pipe(
        Effect.mapError(
          (error) =>
            new MachineUnavailableError({
              worker,
              provider: driver.provider,
              reason: "provider",
              message: `Could not clean up the attempt's earlier machine creation: ${error.message}`,
            }),
        ),
      );
      const readyTimeout = readyTimeoutFor(entry);
      const since = yield* DateTime.now;
      const tags: MachineTags = {
        instance,
        worker,
        run: runId,
        process,
        attempt: attemptId,
        attempts: 1,
      };
      const { hold } = yield* register({
        worker,
        driver,
        workerEntry: entry,
        provider: driver.provider,
        state: "creating",
        uses: 1,
        since,
        id: Option.none(),
        runId: Option.some(runId),
        attemptId: Option.some(attemptId),
        machine: Option.none(),
        holder: "lease",
        checkout: false,
      });
      yield* Effect.logInfo("Creating a machine for the persisted Attempt", {
        worker,
        runId,
        attemptId,
        provider: driver.provider,
      });
      const created = yield* driver
        .create(machineName(worker, yield* randomHex(8)), tags)
        .pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : unregister(hold))));
      const id = created.id;
      yield* update(hold, (current) => ({ ...current, id: Option.some(id) }));
      const ready = starts
        .record(worker, driver.provider)
        .pipe(Effect.andThen(machineOf(entry, driver, id, created.hostKey)))
        .pipe(
          Effect.tap((machine) =>
            awaitMachineSsh(commands, interval, machine).pipe(
              Effect.catchTag("ExecutorOperationError", (error) =>
                Effect.fail(
                  new MachineUnavailableError({
                    worker,
                    provider: driver.provider,
                    reason: "unreachable",
                    message: error.message,
                  }),
                ),
              ),
            ),
          ),
          Effect.tap((machine) =>
            update(hold, (current) => ({ ...current, machine: Option.some(machine) })),
          ),
          Effect.tap(tailnets.join),
          Effect.timeoutOrElse({
            duration: readyTimeout,
            orElse: () => Effect.fail(timedOut(worker, driver.provider, readyTimeout)),
          }),
        );
      const prepared = yield* ready.pipe(
        Effect.flatMap((machine) =>
          checkMachine(machine, brains).pipe(Effect.map((checked) => ({ machine, checked }))),
        ),
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) ? Effect.void : discard(hold, "the machine didn't become ready"),
        ),
      );
      yield* update(hold, (current) => ({
        ...current,
        state: "located",
        machine: Option.some(prepared.machine),
      }));
      yield* Effect.logInfo("The machine for the Attempt is ready", {
        worker,
        runId,
        attemptId,
        provider: driver.provider,
        machine: id,
        host: prepared.machine.shell.destination,
        seconds: Math.round(Duration.toSeconds(DateTime.distance(since, yield* DateTime.now))),
        checked: Option.isSome(prepared.checked),
      });
      return new MachineGrant({
        hold,
        id,
        worker,
        provider: driver.provider,
        checked: prepared.checked,
      });
    },
    (effect, _worker, _runId, attemptId) =>
      effect.pipe(Effect.tapError(() => options.forgetConnection(attemptId))),
  );

  /**
   * Looks up the machine that an earlier process created for `entry`'s Attempt and records it
   * in `entry`. Returns `false` if the provider doesn't list one.
   */
  const locateEarlier = Effect.fn("SshExecutor.locateEarlierMachine")(function* (entry: Held) {
    const worker = entry.worker;
    const attemptId = Option.getOrUndefined(entry.attemptId);
    if (attemptId === undefined) return false;
    const { workerEntry, driver } = entry;
    const listed = (yield* earlierMachinesOf(worker, driver)).find(({ tags }) =>
      Option.contains(tags.attempt, attemptTag(attemptId)),
    );
    if (listed === undefined) return false;
    const readyTimeout = readyTimeoutFor(workerEntry);
    const machine = yield* machineOf(workerEntry, driver, listed.id, Option.none()).pipe(
      Effect.timeoutOrElse({
        duration: readyTimeout,
        orElse: () => Effect.fail(timedOut(worker, driver.provider, readyTimeout)),
      }),
    );
    yield* update(entry.hold, (current) => ({
      ...current,
      state: "located",
      id: Option.some(listed.id),
      since: listed.createdAt,
      uses: listed.attempts,
      machine: Option.some(machine),
    }));
    yield* Effect.logInfo("Found the machine an earlier process created for the Attempt", {
      worker,
      attemptId,
      machine: listed.id,
      host: machine.shell.destination,
      holder: entry.holder,
    });
    return true;
  });

  /**
   * Returns the machine of `attemptId`: the one this process holds, or else one an earlier
   * process created, which it then holds as `holder`. `None` if the provider lists none.
   */
  const locate = Effect.fn("SshExecutor.locateMachine")(function* (
    worker: WorkerName,
    attemptId: AttemptId,
    holder: Held["holder"],
  ) {
    const existing = yield* byAttempt(attemptId);
    const entry = Option.isSome(existing)
      ? existing.value
      : yield* Effect.gen(function* () {
          const workerEntry = yield* options.attemptEntry(
            worker,
            attemptId,
            holder === "recovery" ? "recovery" : "prepare",
          );
          const driver = yield* drivers.forEntry(workerEntry);
          return yield* register({
            worker,
            workerEntry,
            driver,
            provider: driver.provider,
            state: "unlocated",
            uses: 0,
            since: yield* DateTime.now,
            id: Option.none(),
            runId: Option.none(),
            attemptId: Option.some(attemptId),
            machine: Option.none(),
            holder,
            checkout: false,
          });
        });
    if (holder === "lease" && entry.holder !== "lease")
      yield* update(entry.hold, (current) => ({ ...current, holder }));
    if (entry.state === "located") return Option.some({ hold: entry.hold, machine: entry.machine });
    if (!(yield* locateEarlier(entry))) {
      yield* unregister(entry.hold);
      return Option.none();
    }
    const located = yield* entryOf(entry.hold);
    return Option.map(located, ({ hold, machine }) => ({ hold, machine }));
  });

  const adopt = Effect.fn("SshExecutor.adoptMachine")(function* (
    worker: WorkerName,
    attemptId: AttemptId,
  ) {
    yield* Effect.annotateCurrentSpan({ worker, attemptId });
    protectedAttempts.add(attemptId);
    const entry = yield* options.attemptEntry(worker, attemptId).pipe(
      Effect.tapError((error) =>
        Effect.logWarning(
          "Could not restore the retained attempt connection; its machines stay protected",
          { worker, attemptId, message: error.message },
        ),
      ),
      Effect.option,
    );
    if (Option.isNone(entry)) return Option.none<MachineHold>();
    if (Option.isNone(provisionerOf(entry.value))) {
      protectedAttempts.delete(attemptId);
      return Option.none<MachineHold>();
    }
    const located = yield* locate(worker, attemptId, "lease").pipe(Effect.result);
    if (Result.isSuccess(located)) {
      protectedAttempts.delete(attemptId);
      if (Option.isNone(located.success))
        yield* Effect.logInfo("The Attempt's machine is gone; its slot holds no machine", {
          worker,
          attemptId,
        });
      return Option.map(located.success, ({ hold }) => hold);
    }
    yield* Effect.logWarning(
      "Could not look up the machine of an Attempt from before the restart; it stays held, so no sweep deletes it, and its next use looks it up again",
      { worker, attemptId, message: located.failure.message },
    );
    return Option.map(yield* byAttempt(attemptId), ({ hold }) => hold);
  });

  const release = Effect.fn("SshExecutor.releaseMachine")(function* (hold: MachineHold) {
    yield* Effect.annotateCurrentSpan({ hold });
    const entry = yield* entryOf(hold);
    if (Option.isSome(entry) && entry.value.state === "idle")
      return yield* Effect.logDebug("Machine release was already completed", {
        hold,
        worker: entry.value.worker,
      });
    // A machine never looked up may have the Attempt's checkout too.
    if (Option.isSome(entry) && (entry.value.checkout || entry.value.state === "unlocated")) {
      yield* update(hold, (current) => ({ ...current, holder: "retained" }));
      return yield* Effect.logWarning(
        "The released slot's machine keeps its Attempt's checkout, or couldn't be looked up, so it stays for the next process to reattach or recover",
        {
          worker: entry.value.worker,
          attemptId: Option.getOrElse(entry.value.attemptId, () => "none"),
          machine: Option.getOrElse(entry.value.id, () => "none"),
        },
      );
    }
    if (Option.isSome(entry) && (yield* reuse.release(entry.value))) return;
    yield* discard(hold, "its slot was released without another permitted use");
  });

  const checkoutHeld = Effect.fn("SshExecutor.machineCheckoutHeld")(function* (
    attemptId: AttemptId,
    held: boolean,
  ) {
    const entry = yield* byAttempt(attemptId);
    if (Option.isNone(entry) || entry.value.checkout === held) return;
    yield* update(entry.value.hold, (current) => ({ ...current, checkout: held }));
    yield* Effect.logDebug(
      held
        ? "The machine has the Attempt's checkout"
        : "The Attempt's checkout is removed from its machine",
      { worker: entry.value.worker, attemptId },
    );
    // Its slot was released while the checkout stayed, so nothing else deletes it.
    if (!held && entry.value.holder === "retained")
      yield* discard(entry.value.hold, "its kept checkout was removed");
  });

  /** Lists `entry`'s machines and deletes those no Attempt or creation in this process holds. */
  const sweepWorker = Effect.fn("SshExecutor.sweepMachines")(function* (entry: SshWorkerEntry) {
    const worker = entry.address.name;
    yield* Effect.annotateCurrentSpan({ worker });
    const driver = yield* drivers.forEntry(entry);
    const listed = yield* driver.list(instance, Option.some(worker));
    const current = [...(yield* Ref.get(held)).values()].filter(
      (machine) => machine.worker === worker && machine.provider === driver.provider,
    );
    const listedIds = new Set(listed.map(({ id }) => id));
    const holding = (machine: ListedMachine) =>
      current.find(
        (entry) =>
          Option.contains(entry.id, machine.id) ||
          (Option.isNone(entry.id) &&
            Option.exists(entry.attemptId, (attemptId) =>
              Option.contains(machine.tags.attempt, attemptTag(attemptId)),
            )),
      );
    let deleted = 0;
    let failed = 0;
    for (const machine of listed) {
      const holder = holding(machine);
      if (holder !== undefined) {
        if (holder.state === "deleting") {
          if (Option.isNone(holder.id))
            yield* update(holder.hold, (found) => ({ ...found, id: Option.some(machine.id) }));
          yield* discard(holder.hold, "an earlier deletion failed");
          if (Option.isSome(yield* entryOf(holder.hold))) failed += 1;
        }
        continue;
      }
      if (
        Option.exists(machine.tags.attempt, (tag) =>
          [...protectedAttempts].some(
            (id) =>
              attemptTag(id) === tag &&
              !current.some((held) => Option.contains(held.attemptId, id)),
          ),
        )
      )
        continue;
      const removed = yield* destroy(driver, worker, machine.id).pipe(
        Effect.as(true),
        Effect.tapError((error) =>
          Effect.logWarning("Could not delete a machine no Attempt holds", {
            worker,
            machine: machine.id,
            message: error.message,
          }),
        ),
        Effect.orElseSucceed(() => false),
      );
      if (!removed) {
        failed += 1;
        continue;
      }
      deleted += 1;
      yield* Effect.logInfo("Deleted a machine that no Attempt holds", {
        worker,
        provider: driver.provider,
        machine: machine.id,
        attemptTag: Option.getOrElse(machine.tags.attempt, () => "none"),
        runTag: machine.tags.run,
        createdAt: DateTime.formatIso(machine.createdAt),
      });
    }
    // Drops the machines whose deletion failed but which the provider no longer lists.
    for (const machine of current)
      if (
        machine.driver === driver &&
        machine.state === "deleting" &&
        Option.exists(machine.id, (id) => !listedIds.has(id))
      )
        yield* unregister(machine.hold);
    yield* Effect.logDebug("Swept the machines of a provisioned Worker", {
      worker,
      listed: listed.length,
      deleted,
      held: current.length,
      failed,
    });
    return failed;
  });

  const sweep = Effect.fn("SshExecutor.sweepProvisionedMachines")(function* () {
    const provisioned = [
      ...new Set([
        ...(yield* options.entries),
        ...[...(yield* Ref.get(held)).values()].map(({ workerEntry }) => workerEntry),
      ]),
    ].filter((entry) => Option.isSome(provisionerOf(entry)));
    yield* drivers.warnUnowned(provisioned);
    yield* Effect.forEach(
      provisioned,
      (entry) =>
        sweepWorker(entry).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("Could not sweep the machines of a provisioned Worker", {
              worker: entry.address.name,
              message: error.message,
            }),
          ),
          Effect.ignore,
        ),
      { discard: true },
    );
  });

  const retire = Effect.fn("SshExecutor.sweepRemovedWorker")(function* (worker: WorkerName) {
    yield* Effect.annotateCurrentSpan({ worker });
    yield* Effect.gen(function* () {
      const entry = yield* options.workerFor(worker);
      if (Option.isNone(provisionerOf(entry))) return;
      for (const machine of (yield* Ref.get(held)).values())
        if (machine.worker === worker && (yield* retireIdle(machine.hold)))
          yield* discard(machine.hold, "its worker connection was removed");
      const failed = yield* sweepWorker(entry);
      if (failed > 0)
        return yield* Effect.logWarning(
          "The removed Worker's final sweep could not delete all machines; delete them at the provider using the instance and worker labels",
          { worker, instance, failed },
        );
      yield* Effect.logInfo(
        "Swept the removed Worker's machines before discarding its provider token",
        { worker },
      );
    }).pipe(
      Effect.tapError((error) =>
        Effect.logWarning(
          "The removed Worker's final machine sweep failed; delete its machines at the provider using the instance and worker labels",
          { worker, instance, message: error.message },
        ),
      ),
      Effect.ignore,
    );
    const remaining = yield* Ref.modify(held, (current) => {
      const next = new Map(current);
      let remaining = 0;
      for (const [hold, entry] of current) {
        if (entry.worker !== worker) continue;
        remaining += 1;
        if (entry.state === "deleting") next.delete(hold);
        else next.set(hold, { ...entry, state: "unlocated", machine: Option.none() });
      }
      return [remaining, next] as const;
    });
    if (remaining > 0)
      yield* Effect.logWarning(
        "Removed Worker still has machines with retained checkouts or failed deletions; restore its configuration to recover them or delete them at the provider",
        { worker, instance, remaining },
      );
  });

  const machines = Ref.get(held).pipe(
    Effect.map((current) =>
      [...current.values()]
        .filter((entry) => entry.state !== "unlocated")
        .sort(
          (left, right) => DateTime.toEpochMillis(left.since) - DateTime.toEpochMillis(right.since),
        )
        .map(
          (entry) =>
            new MachineStatus({
              worker: entry.worker,
              provider: entry.provider,
              state:
                entry.state === "creating" || entry.state === "deleting" || entry.state === "idle"
                  ? entry.state
                  : "ready",
              id: entry.id,
              runId: entry.runId,
              attemptId: entry.attemptId,
              since: entry.since,
              attempts: entry.uses,
            }),
        ),
    ),
  );

  /** Returns the machine of an Attempt for its preparation. Fails if it has none. */
  const attemptMachine = Effect.fn("SshExecutor.attemptMachine")(function* (
    worker: WorkerName,
    attemptId: AttemptId,
  ) {
    yield* Effect.annotateCurrentSpan({ worker, attemptId });
    const existing = yield* byAttempt(attemptId);
    if (Option.isNone(existing)) {
      const entry = yield* options.attemptEntry(worker, attemptId);
      if (Option.isSome(entry.machine)) return entry.machine.value;
    }
    const located = yield* locate(worker, attemptId, "lease").pipe(
      Effect.mapError(operationError("prepare")),
    );
    const machine = Option.flatMap(located, ({ machine }) => machine);
    if (Option.isSome(machine)) {
      yield* Effect.logDebug("Preparing attempt on its retained provisioned SSH machine", {
        worker,
        attemptId,
        host: machine.value.shell.destination,
      });
      return machine.value;
    }
    return yield* new ExecutorOperationError({
      operation: "prepare",
      message: `Worker "${worker}" has no machine for the attempt`,
      cause: new Error(`no machine for attempt ${attemptId}`),
    });
  });

  const leftovers = Effect.fn("SshExecutor.recoveryLeftovers")(function* (
    attempt: AttemptRecovery,
  ) {
    const { worker, attemptId } = attempt;
    yield* Effect.annotateCurrentSpan({ worker, attemptId });
    const existing = yield* byAttempt(attemptId);
    protectedAttempts.add(attemptId);
    if (Option.isNone(existing)) {
      const entry = yield* options.attemptEntry(worker, attemptId, "recovery");
      if (Option.isSome(entry.machine)) {
        protectedAttempts.delete(attemptId);
        const machine = entry.machine.value;
        return Option.some({
          machine,
          checkouts: new Set([`${machine.workerDirectory}/attempts/${safeSegment(attemptId)}`]),
        });
      }
    }
    const located = yield* locate(worker, attemptId, "recovery").pipe(
      Effect.mapError(operationError("cleanup")),
    );
    protectedAttempts.delete(attemptId);
    const machine = Option.flatMap(located, ({ machine }) => machine);
    yield* Effect.logInfo("Resolved retained SSH machine for attempt recovery", {
      worker,
      attemptId,
      found: Option.isSome(machine),
    });
    return Option.map(machine, (machine) => ({
      machine,
      checkouts: new Set([`${machine.workerDirectory}/attempts/${safeSegment(attemptId)}`]),
    }));
  });

  /**
   * Deletes the machine of `attemptId` after its recovery succeeded, unless a lease holds it.
   * After a failed recovery, keeps it for the next process.
   */
  const recovered = Effect.fn("SshExecutor.machineRecovered")(function* (
    attemptId: AttemptId,
    succeeded: boolean,
  ) {
    const entry = yield* byAttempt(attemptId);
    if (Option.isNone(entry) || entry.value.holder !== "recovery") return;
    if (succeeded && !entry.value.checkout)
      return yield* discard(entry.value.hold, "its Attempt's checkout was reconciled");
    yield* update(entry.value.hold, (current) => ({ ...current, holder: "retained" }));
    yield* Effect.logWarning(
      "Kept the machine of an Attempt whose recovery failed or left its checkout; the next process tries again",
      {
        worker: entry.value.worker,
        attemptId,
        machine: Option.getOrElse(entry.value.id, () => "none"),
      },
    );
  });

  /**
   * Verifies a provisioned Worker without a machine: the provider token, image, key, and limits,
   * the Gateway's admin API, and that every harness has a credential no machine has to keep.
   * The machine checks run at the configured interval.
   */
  const verifyProvisioned = Effect.fn("SshExecutor.verifyProvisioned")(function* (
    entry: SshWorkerEntry,
    brains: ReadonlyArray<BrainSpec>,
    maxConcurrentAttempts: number,
  ) {
    const worker = entry.address.name;
    const provisioner = provisionerOf(entry);
    if (Option.isNone(provisioner))
      return yield* Effect.die(new Error(`SSH worker "${worker}" isn't provisioned`));
    const driver = yield* drivers.forEntry(entry);
    const report = yield* driver.verify(worker, maxConcurrentAttempts);
    yield* Effect.forEach(
      report.warnings,
      (warning) => Effect.logWarning(warning, { worker, provider: driver.provider }),
      { discard: true },
    );
    if (Option.isSome(entry.gateway))
      yield* options.verifyGatewayAdmin(worker, entry.gateway.value);
    yield* tailnets.verify(entry.address);
    const gap = harnessCredentialGap(entry, brains);
    if (Option.isSome(gap)) return yield* gap.value;
    yield* Effect.logInfo(
      "Provisioned SSH Worker preflight verified; its next due machine check verifies the harnesses",
      {
        worker,
        provider: driver.provider,
        harnesses: Arr.dedupe(brains.map(({ harness }) => harness)).join(","),
      },
    );
    return {
      degraded: Option.none(),
      deferred: Option.some(
        Option.isSome(provisioner.value.reuse)
          ? "Checked before every attempt while machine reuse is enabled."
          : `Checked on the first machine, then every ${provisioner.value.timings.machineCheckInterval} seconds when a machine is created.`,
      ),
      containerLimits: Option.none(),
    } satisfies PreflightReport;
  });

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      for (const machine of (yield* Ref.get(held)).values())
        if (yield* retireIdle(machine.hold))
          yield* discard(machine.hold, "the orchestrator stopped");
    }),
  );

  const provisions = (worker: WorkerName) =>
    options.workerFor(worker).pipe(
      Effect.map((entry) => Option.isSome(provisionerOf(entry))),
      Effect.orElseSucceed(() => false),
    );

  return {
    port: WorkerMachines.of({
      provisions,
      create,
      adopt,
      release,
      sweep: sweep(),
      machines,
      starts: starts.counts,
    }),
    retire,
    refresh: reuse.refresh,
    attemptMachine,
    leftovers,
    recovered,
    checkoutHeld,
    verifyProvisioned,
    provisions,
  };
});
