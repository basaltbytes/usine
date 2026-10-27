import type { BrainSpec } from "@usine/core/agent/brain";
import { HarnessUnavailableError } from "@usine/core/agent/capability";
import type { AttemptId } from "@usine/core/attempt";
import type { RunId } from "@usine/core/run";
import type {
  GatewayLlmProvider,
  MachineId,
  MachineProvider,
  WorkerName,
} from "@usine/core/worker";
import { RemoteShell, SSH_FAILURE } from "@usine/agents/child-host";
import {
  Array as Arr,
  Cache,
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
import { homedir } from "node:os";
import {
  type ExecutorError,
  ExecutorOperationError,
  MachineCheck,
  MachineGrant,
  MachineHold,
  MachineStatus,
  MachineUnavailableError,
  type PreflightReport,
  WorkerCapabilityError,
  WorkerMachines,
} from "../../executor.ts";
import type { RemoteCommands } from "../../remote/commands.ts";
import { gatewayHolds, provisionedApiKey } from "../api-keys.ts";
import type { MachineGateway, SshExecutorOptions, SshMachine, SshProvisioner } from "../model.ts";
import {
  hostKeyAlias,
  knownHostsLine,
  type PinnedHostKey,
  type SshWorkerEntry,
} from "../workers.ts";
import { BOAT_API, boatDriverFor } from "./boat.ts";
import { HETZNER_API, hetznerDriverFor } from "./hetzner.ts";
import {
  attemptTag,
  tagValue,
  type ListedMachine,
  type MachineDriver,
  type MachineEndpoint,
  machineName,
  type MachineTags,
} from "./model.ts";

/**
 * A script that waits for cloud-init to finish, if the machine has it, creates the Worker root
 * `$1`, and waits up to a minute for Docker to answer, if the machine has it.
 */
const READY_SCRIPT = String.raw`
if command -v cloud-init >/dev/null 2>&1; then cloud-init status --wait >/dev/null 2>&1 || true; fi
mkdir -p "$1" || exit 1
if command -v docker >/dev/null 2>&1; then
  tries=0
  until docker version >/dev/null 2>&1; do
    tries=$((tries + 1))
    [ "$tries" -ge 30 ] && break
    sleep 2
  done
fi
`.trim();

/**
 * Returns the error for the first harness in `brains` that can't authenticate on a machine
 * created for one Attempt, which keeps no login: one whose provider credential is neither at
 * the Gateway nor in the provisioner's `api_keys`.
 */
const harnessCredentialGap = (
  entry: SshWorkerEntry,
  provisioner: SshProvisioner,
  brains: ReadonlyArray<BrainSpec>,
): Option.Option<WorkerCapabilityError> => {
  const worker = entry.address.name;
  const noGateway =
    provisioner.provider === "boat"
      ? "A subscription login needs a gateway, which a Boat worker can't have."
      : "A subscription login needs a gateway, which this worker doesn't have.";
  const missing = (label: string, provider: GatewayLlmProvider, login: string) => {
    const head = `${label} on provisioned worker "${worker}" has no credential, because a machine created for one attempt keeps no login.`;
    return Option.isSome(entry.gateway)
      ? `${head} Add ${provider} to the gateway's llm_providers, with ${login} or an API key on the gateway, or set provisioner.api_keys.${provider}.`
      : `${head} Set provisioner.api_keys.${provider}. ${noGateway}`;
  };
  for (const harness of Arr.dedupe(brains.map((brain) => brain.harness))) {
    if (gatewayHolds(entry.gateway, harness) || Option.isSome(provisionedApiKey(entry, harness)))
      continue;
    const message = (() => {
      switch (harness) {
        case "claude":
          return missing("Claude Code", "anthropic", "a subscription token");
        case "codex":
          return missing("Codex", "openai", "a ChatGPT login");
        case "pi":
          return `Pi children run only on local workers, not on provisioned worker "${worker}".`;
      }
    })();
    return Option.some(
      new WorkerCapabilityError({
        worker,
        capability: "harness-login",
        message,
        cause: new HarnessUnavailableError({ harness, capability: "login", message }),
      }),
    );
  }
  return Option.none();
};

/** One machine that this process created, adopted, or found for a recovery. */
interface Held {
  readonly hold: MachineHold;
  readonly worker: WorkerName;
  readonly provider: MachineProvider;
  /**
   * `creating` until the machine answers over SSH, `located` while it serves an Attempt,
   * `unlocated` for an adopted Attempt whose machine the provider couldn't be asked about yet,
   * and `deleting` until its deletion succeeds.
   */
  readonly state: "creating" | "located" | "unlocated" | "deleting";
  readonly since: DateTime.Utc;
  readonly id: Option.Option<MachineId>;
  readonly runId: Option.Option<RunId>;
  readonly attemptId: Option.Option<AttemptId>;
  readonly machine: Option.Option<SshMachine>;
  readonly tags: Option.Option<MachineTags>;
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

export interface ProvisionedMachinesOptions {
  readonly instance: string;
  readonly commands: RemoteCommands;
  readonly workerFor: (worker: WorkerName) => Effect.Effect<SshWorkerEntry, ExecutorError>;
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

/** Returns the absolute path of a key file given as absolute or `~/`. */
const expandHome = (file: string): string =>
  file.startsWith("~/") ? `${homedir()}/${file.slice(2)}` : file;

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
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const held = yield* Ref.make<ReadonlyMap<MachineHold, Held>>(new Map());
  const nextHold = yield* Ref.make(0);
  const checkedOn = yield* Ref.make<ReadonlyMap<WorkerName, string>>(new Map());
  const earlierMachines = yield* Ref.make<ReadonlyMap<WorkerName, ReadonlyArray<ListedMachine>>>(
    new Map(),
  );
  const process = yield* randomHex(12);
  const readyTimeout = Duration.fromInputUnsafe(settings.machineReadyTimeout ?? "10 minutes");
  const interval = Effect.sleep(settings.machinePollInterval ?? "3 seconds");
  const knownHostsDirectory =
    settings.knownHostsDirectory === undefined
      ? yield* fs.makeTempDirectoryScoped({ prefix: "usine-known-hosts-" })
      : settings.knownHostsDirectory;
  yield* fs.makeDirectory(knownHostsDirectory, { recursive: true });
  const knownHostsFile = (provider: MachineProvider, id: MachineId) =>
    path.join(knownHostsDirectory, `${provider}-${id}`);

  const readPublicKey = Effect.fn("SshExecutor.readPublicKey")(function* (entry: SshWorkerEntry) {
    const worker = entry.address.name;
    const identity = Option.getOrUndefined(entry.address.identityFile);
    const file = identity === undefined ? undefined : `${expandHome(identity)}.pub`;
    const text =
      file === undefined
        ? Option.none<string>()
        : yield* fs.readFileString(file).pipe(Effect.option);
    const key = Option.filter(
      Option.map(text, (content) => content.trim()),
      (content) => content.length > 0,
    );
    if (Option.isSome(key)) return key.value;
    return yield* new WorkerCapabilityError({
      worker,
      capability: "credentials",
      message: `Provisioned worker "${worker}" needs the public key of identity_file at ${file ?? "<identity_file>.pub"}, which it adds to each Boat sandbox`,
      cause: new Error(`no public key at ${file ?? "identity_file"}`),
    });
  });

  const buildDriver = Effect.fn("SshExecutor.machineDriver")(function* (worker: WorkerName) {
    const entry = yield* options.workerFor(worker);
    const provisioner = provisionerOf(entry);
    if (Option.isNone(provisioner))
      return yield* new WorkerCapabilityError({
        worker,
        capability: "machine",
        message: `SSH worker "${worker}" has a machine of its own and creates none`,
        cause: new Error("long-lived SSH worker"),
      });
    const value = provisioner.value;
    switch (value.provider) {
      case "hetzner":
        return yield* hetznerDriverFor(
          worker,
          value,
          Option.isSome(entry.gateway),
          settings.providerEndpoints?.hetzner ?? HETZNER_API,
        );
      case "boat":
        return yield* boatDriverFor(
          worker,
          value,
          yield* readPublicKey(entry),
          settings.providerEndpoints?.boat ?? BOAT_API,
        );
    }
  });
  const drivers = yield* Cache.make({ capacity: Number.POSITIVE_INFINITY, lookup: buildDriver });
  const driverFor = (worker: WorkerName): Effect.Effect<MachineDriver, ExecutorError> =>
    Cache.get(drivers, worker);

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
    const cached = (yield* Ref.get(earlierMachines)).get(worker);
    if (cached !== undefined) return cached;
    const listed = yield* driver.list(instance, worker);
    yield* Ref.update(earlierMachines, (current) => new Map(current).set(worker, listed));
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
    const driver = yield* driverFor(found.worker).pipe(Effect.option);
    if (Option.isNone(driver)) {
      yield* unregister(hold);
      return yield* Effect.logWarning(
        "The Worker of the machine is gone, so the machine can't be deleted; delete it at the provider",
        { ...fields, machine: Option.getOrElse(found.id, () => "unknown") },
      );
    }
    const id = Option.isSome(found.id)
      ? Option.some(found.id.value)
      : yield* Option.match(found.attemptId, {
          onNone: () => Effect.succeedNone,
          onSome: (attemptId) =>
            earlierMachinesOf(found.worker, driver.value).pipe(
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
    const deleted = yield* destroy(driver.value, found.worker, id.value).pipe(
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

  /** Waits until the machine answers over SSH and runs `READY_SCRIPT`. */
  const awaitSsh = Effect.fn("SshExecutor.awaitMachineSsh")(function* (machine: SshMachine) {
    const worker = machine.address.name;
    const host = machine.shell.destination;
    yield* Effect.annotateCurrentSpan({ worker, host });
    const shell = new RemoteShell({
      ssh: {
        command: machine.shell.ssh.command,
        args: [...machine.shell.ssh.args, "-o", "ConnectTimeout=10"],
      },
      sshEnvironment: machine.shell.sshEnvironment,
      destination: machine.shell.destination,
    });
    let tries = 0;
    while (true) {
      tries += 1;
      const result = yield* commands.inspect("prepare", shell, "sh", [
        "-c",
        READY_SCRIPT,
        "sh",
        machine.address.root,
      ]);
      if (result.exitCode === 0) {
        yield* Effect.logInfo("The new machine answers over SSH", { worker, host, tries });
        return;
      }
      if (result.exitCode !== SSH_FAILURE)
        return yield* new WorkerCapabilityError({
          worker,
          capability: "machine",
          message: `The new machine of worker "${worker}" at ${host} can't create the root ${machine.address.root}`,
          cause: new Error(result.stderr.trim() || `exit code ${String(result.exitCode)}`),
        });
      yield* Effect.logDebug("The new machine doesn't answer over SSH yet", {
        worker,
        host,
        tries,
        message: result.stderr.trim(),
      });
      yield* interval;
    }
  });

  /**
   * Runs the machine preflight on the first machine of `worker` each day, which a provisioned
   * Worker's preflight at `usine up` can't. Each machine runs one Attempt, so the container
   * limits it derives are for one Attempt; the Worker's machines get them until the next check.
   */
  const checkDaily = Effect.fn("SshExecutor.checkMachineOfTheDay")(function* (
    machine: SshMachine,
    brains: ReadonlyArray<BrainSpec>,
  ) {
    const worker = machine.address.name;
    const today = DateTime.formatIsoDateUtc(yield* DateTime.now);
    if ((yield* Ref.get(checkedOn)).get(worker) === today) return Option.none<MachineCheck>();
    yield* Effect.logInfo(
      "Checking the first machine of the day on a provisioned Worker: Git, memory, the Gateway, Docker, the container limits, and the harnesses",
      { worker, host: machine.shell.destination, brains: brains.length },
    );
    const report = yield* options.verifyMachine(machine, brains, 1).pipe(
      Effect.catchTags({
        ExecutorOperationError: (error) =>
          Effect.fail(
            new WorkerCapabilityError({
              worker,
              capability: "machine",
              message: `The check of the new machine of worker "${worker}" couldn't run: ${error.message}`,
              cause: error,
            }),
          ),
        CredentialUnavailableError: (error) =>
          Effect.fail(
            new WorkerCapabilityError({
              worker,
              capability: "credentials",
              message: error.message,
              cause: error,
            }),
          ),
      }),
    );
    yield* Ref.update(checkedOn, (current) => new Map(current).set(worker, today));
    return Option.some(new MachineCheck({ brains, containerLimits: report.containerLimits }));
  });

  const timedOut = (worker: WorkerName, provider: MachineProvider) =>
    new MachineUnavailableError({
      worker,
      provider,
      reason: "timeout",
      message: `The new ${provider} machine of worker "${worker}" didn't answer over SSH within ${Duration.format(readyTimeout)}`,
    });

  const create = Effect.fn("SshExecutor.createMachine")(function* (
    worker: WorkerName,
    runId: RunId,
    brains: ReadonlyArray<BrainSpec>,
  ) {
    yield* Effect.annotateCurrentSpan({ worker, runId });
    const defect = <E>(error: E) => Effect.die(error);
    const entry = yield* options
      .workerFor(worker)
      .pipe(
        Effect.catchTags({ ExecutorOperationError: defect, CredentialUnavailableError: defect }),
      );
    const driver = yield* driverFor(worker).pipe(
      Effect.catchTags({ ExecutorOperationError: defect, CredentialUnavailableError: defect }),
    );
    const since = yield* DateTime.now;
    const tags: MachineTags = { instance, worker, run: runId, process, attempt: Option.none() };
    const { hold } = yield* register({
      worker,
      provider: driver.provider,
      state: "creating",
      since,
      id: Option.none(),
      runId: Option.some(runId),
      attemptId: Option.none(),
      machine: Option.none(),
      tags: Option.some(tags),
      holder: "lease",
      checkout: false,
    });
    yield* Effect.logInfo("Creating a machine for the Run's next Attempt", {
      worker,
      runId,
      provider: driver.provider,
    });
    const created = yield* driver
      .create(machineName(worker, yield* randomHex(8)), tags)
      .pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : unregister(hold))));
    const id = created.id;
    yield* update(hold, (current) => ({ ...current, id: Option.some(id) }));
    const ready = machineOf(entry, driver, id, created.hostKey).pipe(
      Effect.tap((machine) =>
        awaitSsh(machine).pipe(
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
      Effect.timeoutOrElse({
        duration: readyTimeout,
        orElse: () => Effect.fail(timedOut(worker, driver.provider)),
      }),
    );
    const prepared = yield* ready.pipe(
      Effect.flatMap((machine) =>
        checkDaily(machine, brains).pipe(Effect.map((checked) => ({ machine, checked }))),
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
    yield* Effect.logInfo("The machine for the Run's next Attempt is ready", {
      worker,
      runId,
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
  });

  const assign = Effect.fn("SshExecutor.assignMachine")(function* (
    hold: MachineHold,
    attemptId: AttemptId,
  ) {
    yield* Effect.annotateCurrentSpan({ hold, attemptId });
    const entry = yield* entryOf(hold);
    const holding = Option.flatMap(entry, (found) =>
      Option.flatMap(found.id, (id) => Option.map(found.tags, (tags) => ({ found, id, tags }))),
    );
    if (Option.isNone(holding))
      return yield* new ExecutorOperationError({
        operation: "prepare",
        message: "The attempt's machine is no longer held",
        cause: new Error(`no machine for hold ${hold}`),
      });
    const { found, id } = holding.value;
    const tags = { ...holding.value.tags, attempt: Option.some(attemptId) };
    const driver = yield* driverFor(found.worker).pipe(Effect.mapError(operationError("prepare")));
    yield* driver.tag(id, tags).pipe(Effect.mapError(operationError("prepare")));
    yield* update(hold, (current) => ({
      ...current,
      attemptId: Option.some(attemptId),
      tags: Option.some(tags),
    }));
    yield* Effect.logInfo("The machine is the Attempt's", {
      worker: found.worker,
      machine: id,
      attemptId,
      runId: Option.getOrElse(found.runId, () => "none"),
    });
  });

  /**
   * Looks up the machine that an earlier process created for `entry`'s Attempt and records it
   * in `entry`. Returns `false` if the provider doesn't list one.
   */
  const locateEarlier = Effect.fn("SshExecutor.locateEarlierMachine")(function* (entry: Held) {
    const worker = entry.worker;
    const attemptId = Option.getOrUndefined(entry.attemptId);
    if (attemptId === undefined) return false;
    const workerEntry = yield* options.workerFor(worker);
    const driver = yield* driverFor(worker);
    const listed = (yield* earlierMachinesOf(worker, driver)).find(({ tags }) =>
      Option.contains(tags.attempt, attemptTag(attemptId)),
    );
    if (listed === undefined) return false;
    const machine = yield* machineOf(workerEntry, driver, listed.id, Option.none()).pipe(
      Effect.timeoutOrElse({
        duration: readyTimeout,
        orElse: () => Effect.fail(timedOut(worker, driver.provider)),
      }),
    );
    yield* update(entry.hold, (current) => ({
      ...current,
      state: "located",
      id: Option.some(listed.id),
      since: listed.createdAt,
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
      : yield* register({
          worker,
          provider: (yield* driverFor(worker)).provider,
          state: "unlocated",
          since: yield* DateTime.now,
          id: Option.none(),
          runId: Option.none(),
          attemptId: Option.some(attemptId),
          machine: Option.none(),
          tags: Option.none(),
          holder,
          checkout: false,
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
    const entry = yield* options.workerFor(worker).pipe(Effect.option);
    if (Option.isNone(entry) || Option.isNone(provisionerOf(entry.value)))
      return Option.none<MachineHold>();
    const located = yield* locate(worker, attemptId, "lease").pipe(Effect.result);
    if (Result.isSuccess(located)) {
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
    yield* discard(hold, "its slot was released");
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
    const driver = yield* driverFor(worker);
    const listed = yield* driver.list(instance, worker);
    const current = [...(yield* Ref.get(held)).values()].filter(
      (machine) => machine.worker === worker,
    );
    const listedIds = new Set(listed.map(({ id }) => id));
    const creatingRuns = new Set(
      current.flatMap((entry) =>
        entry.state === "creating" && Option.isNone(entry.id)
          ? Option.match(entry.runId, {
              onNone: () => [],
              onSome: (runId) => [tagValue(runId), tagValue(runId, 32)],
            })
          : [],
      ),
    );
    const holding = (machine: ListedMachine) =>
      current.find(
        (entry) =>
          Option.contains(entry.id, machine.id) ||
          Option.exists(entry.attemptId, (attemptId) =>
            Option.contains(machine.tags.attempt, attemptTag(attemptId)),
          ),
      );
    let deleted = 0;
    for (const machine of listed) {
      const holder = holding(machine);
      if (holder !== undefined) {
        if (holder.state === "deleting") {
          if (Option.isNone(holder.id))
            yield* update(holder.hold, (found) => ({ ...found, id: Option.some(machine.id) }));
          yield* discard(holder.hold, "an earlier deletion failed");
        }
        continue;
      }
      // A machine of this process that no entry holds yet is still being created, unless its
      // creation ended without the provider's answer.
      if (machine.tags.process === process && creatingRuns.has(machine.tags.run)) continue;
      const removed = yield* destroy(driver, worker, machine.id).pipe(
        Effect.as(true),
        Effect.tapError((error) =>
          Effect.logWarning(
            "Could not delete a machine no Attempt holds; the next sweep tries again",
            { worker, machine: machine.id, message: error.message },
          ),
        ),
        Effect.orElseSucceed(() => false),
      );
      if (!removed) continue;
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
      if (machine.state === "deleting" && Option.exists(machine.id, (id) => !listedIds.has(id)))
        yield* unregister(machine.hold);
    yield* Effect.logDebug("Swept the machines of a provisioned Worker", {
      worker,
      listed: listed.length,
      deleted,
      held: current.length,
    });
  });

  const sweep = Effect.fn("SshExecutor.sweepProvisionedMachines")(function* () {
    const provisioned = (yield* options.entries).filter((entry) =>
      Option.isSome(provisionerOf(entry)),
    );
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
                entry.state === "creating" || entry.state === "deleting" ? entry.state : "ready",
              id: entry.id,
              runId: entry.runId,
              attemptId: entry.attemptId,
              since: entry.since,
            }),
        ),
    ),
  );

  /** Returns the machine of an Attempt for its preparation. Fails if it has none. */
  const attemptMachine = Effect.fn("SshExecutor.attemptMachine")(function* (
    worker: WorkerName,
    attemptId: AttemptId,
  ) {
    const located = yield* locate(worker, attemptId, "lease").pipe(
      Effect.mapError(operationError("prepare")),
    );
    const machine = Option.flatMap(located, ({ machine }) => machine);
    if (Option.isSome(machine)) return machine.value;
    return yield* new ExecutorOperationError({
      operation: "prepare",
      message: `Worker "${worker}" has no machine for the attempt`,
      cause: new Error(`no machine for attempt ${attemptId}`),
    });
  });

  /**
   * Returns the machine of an Attempt that startup recovery reconciles, or `None` if it has
   * none. `recovered` deletes a machine that no lease holds.
   */
  const recoveryMachine = (worker: WorkerName, attemptId: AttemptId) =>
    locate(worker, attemptId, "recovery").pipe(
      Effect.map((located) => Option.flatMap(located, ({ machine }) => machine)),
      Effect.mapError(operationError("cleanup")),
    );

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
   * The machine checks run on the Worker's first machine each day.
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
    const driver = yield* driverFor(worker);
    const report = yield* driver.verify(worker, maxConcurrentAttempts);
    yield* Effect.forEach(
      report.warnings,
      (warning) => Effect.logWarning(warning, { worker, provider: driver.provider }),
      { discard: true },
    );
    if (Option.isSome(entry.gateway))
      yield* options.verifyGatewayAdmin(worker, entry.gateway.value);
    const gap = harnessCredentialGap(entry, provisioner.value, brains);
    if (Option.isSome(gap)) return yield* gap.value;
    yield* Effect.logInfo(
      "Provisioned SSH Worker preflight verified; its first machine each day checks the harnesses",
      {
        worker,
        provider: driver.provider,
        harnesses: Arr.dedupe(brains.map(({ harness }) => harness)).join(","),
      },
    );
    return {
      degraded: Option.none(),
      deferred: Option.some(
        "Checked on the worker's first machine each day, since no machine exists before an attempt.",
      ),
      containerLimits: Option.none(),
    } satisfies PreflightReport;
  });

  const provisions = (worker: WorkerName) =>
    options.workerFor(worker).pipe(
      Effect.map((entry) => Option.isSome(provisionerOf(entry))),
      Effect.orElseSucceed(() => false),
    );

  return {
    port: WorkerMachines.of({
      provisions,
      create,
      assign,
      adopt,
      release,
      sweep: sweep(),
      machines,
    }),
    attemptMachine,
    recoveryMachine,
    recovered,
    checkoutHeld,
    verifyProvisioned,
    provisions,
  };
});
