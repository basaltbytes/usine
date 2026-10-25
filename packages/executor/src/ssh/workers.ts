import type { SshCommand } from "@usine/agents/child-host";
import { safeSegment } from "@usine/core/repository";
import type { MachineId, MachineProvider, WorkerName } from "@usine/core/worker";
import { Context, Effect, Equal, Exit, Option, Ref, Scope, SynchronizedRef } from "effect";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { WorkerCapabilityError } from "../executor.ts";
import type { RemoteCommands } from "../remote/commands.ts";
import { gatewayAdminFor } from "./gateway/admin.ts";
import { type GatewayForward, gatewayForwardFor } from "./gateway/forward.ts";
import type {
  GatewayCredentials,
  MachineGateway,
  SshMachine,
  SshWorkerAddress,
  SshWorkerGateway,
} from "./model.ts";
import type { MachineEndpoint } from "./provisioner/model.ts";

/** The Workers of the SSH executor, starting with `SshExecutorOptions.workers`. A reload adds and removes Workers at runtime. */
export class SshWorkers extends Context.Service<
  SshWorkers,
  {
    /**
     * Adds the machine at `address` for preflight and Attempts. Behind a Gateway, shares the admin
     * API forward with other Workers that have the same `destination` and `adminPort`, or opens it.
     * Adding a Worker again with the same address does nothing; with a different address, fails
     * with a `machine` capability error.
     */
    readonly addWorker: (address: SshWorkerAddress) => Effect.Effect<void, WorkerCapabilityError>;
    /**
     * Removes `worker`'s machine, so later requests for it fail with a `machine` capability error.
     * Call only when no Attempt runs on the Worker. If it was the last Worker behind its Gateway,
     * closes the admin API forward. Removing an unknown Worker does nothing.
     */
    readonly removeWorker: (worker: WorkerName) => Effect.Effect<void>;
  }
>()("@usine/executor/SshWorkers") {}

interface HeldForward {
  readonly forward: GatewayForward;
  readonly scope: Scope.Closeable;
  readonly workers: ReadonlySet<WorkerName>;
}

/** A Worker the executor has: its address and Gateway, and its machine if it's long-lived. */
export interface SshWorkerEntry {
  readonly address: SshWorkerAddress;
  readonly gateway: Option.Option<MachineGateway>;
  /** `None` for a provisioned Worker, whose machines exist one per Attempt. */
  readonly machine: Option.Option<SshMachine>;
}

interface Machines {
  readonly byWorker: ReadonlyMap<WorkerName, SshWorkerEntry>;
  /** Keyed by Gateway destination and admin port. */
  readonly forwards: ReadonlyMap<string, HeldForward>;
}

const forwardKey = ({ destination, adminPort }: SshWorkerGateway) =>
  `${destination} ${String(adminPort)}`;

/** Returns where a Worker's machines are, for logs: its destination, or its provider. */
const placeOf = (address: SshWorkerAddress): string =>
  address.machine._tag === "Fixed"
    ? address.machine.destination
    : `a ${address.machine.provisioner.provider} machine per attempt`;

const workerDirectoryOf = (address: SshWorkerAddress): string =>
  `${address.root}/workers/${safeSegment(address.name)}`;

/** Returns the SSH command for one Worker: the shared options, then its port and key. */
const sshCommandFor = (base: SshCommand, address: SshWorkerAddress): SshCommand => ({
  command: base.command,
  args: [
    ...base.args,
    ...Option.match(address.port, { onNone: () => [], onSome: (port) => ["-p", String(port)] }),
    ...Option.match(address.identityFile, {
      onNone: () => [],
      onSome: (file) => ["-i", file, "-o", "IdentitiesOnly=yes"],
    }),
  ],
});

/** A provisioned machine's pinned SSH host key: its `known_hosts` file and the name the key is recorded under. */
export interface PinnedHostKey {
  readonly file: string;
  readonly alias: string;
}

/**
 * Returns the SSH command for a machine created for one Attempt: the shared options, its pinned
 * host key, the Gateway as jump host if the Worker has one, and its port and the Worker's key.
 * The key is recorded under an alias rather than the address, so it holds for the machine
 * whatever address it reports, and the client accepts no other key.
 */
const provisionedSshCommandFor = (
  base: SshCommand,
  entry: SshWorkerEntry,
  endpoint: MachineEndpoint,
  hostKey: PinnedHostKey,
): SshCommand => ({
  command: base.command,
  args: [
    ...base.args,
    "-o",
    `UserKnownHostsFile=${hostKey.file}`,
    "-o",
    `HostKeyAlias=${hostKey.alias}`,
    "-o",
    "StrictHostKeyChecking=yes",
    ...Option.match(entry.gateway, {
      onNone: () => [],
      onSome: ({ settings }) => ["-J", settings.destination],
    }),
    ...Option.match(endpoint.port, { onNone: () => [], onSome: (port) => ["-p", String(port)] }),
    ...Option.match(entry.address.identityFile, {
      onNone: () => [],
      onSome: (file) => ["-i", file, "-o", "IdentitiesOnly=yes"],
    }),
  ],
});

/** Returns the name that a provisioned machine's host key is recorded under. */
export const hostKeyAlias = (provider: MachineProvider, id: MachineId): string =>
  `usine-${provider}-${id}`;

/** Returns the `known_hosts` line that pins `key` for the machine recorded under `alias`. */
export const knownHostsLine = (alias: string, key: string): string => `${alias} ${key}\n`;

/**
 * Returns the SSH Workers' machines, which `addWorker` and `removeWorker` change at runtime and
 * `machineFor` reads on each call. Each admin API forward runs in its own child scope and
 * closes with its last Worker or the caller's scope.
 */
export const sshMachinesFor = Effect.fnUntraced(function* (
  base: SshCommand,
  commands: RemoteCommands,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const http = yield* HttpClient.HttpClient;
  const scope = yield* Scope.Scope;
  const machines = yield* SynchronizedRef.make<Machines>({
    byWorker: new Map(),
    forwards: new Map(),
  });

  const openForward = Effect.fnUntraced(function* (settings: SshWorkerGateway) {
    const forwardScope = yield* Scope.fork(scope);
    const forward = yield* gatewayForwardFor(
      spawner,
      commands.shellFor(base, settings.destination),
      settings.destination,
      settings.adminPort,
    ).pipe(Scope.provide(forwardScope));
    return { forward, scope: forwardScope };
  });

  /** Returns the Gateway for `address`'s machine with the forward it shares or opens, and the updated forwards. */
  const gatewayFor = Effect.fnUntraced(function* (
    current: Machines,
    address: SshWorkerAddress,
    settings: SshWorkerGateway,
  ) {
    const key = forwardKey(settings);
    const shared = Option.fromNullishOr(current.forwards.get(key));
    const { forward, scope: forwardScope } = Option.isSome(shared)
      ? shared.value
      : yield* openForward(settings);
    const admin = yield* gatewayAdminFor(address.name, settings, forward).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );
    const workers = Option.match(shared, {
      onNone: () => new Set([address.name]),
      onSome: (held) => new Set([...held.workers, address.name]),
    });
    const credentials = yield* Ref.make<GatewayCredentials>({
      anthropic: Option.none(),
      openai: Option.none(),
    });
    const warnedOfUnreportedCredential = yield* Ref.make(false);
    return {
      gateway: {
        settings,
        forward,
        admin,
        credentials,
        warnedOfUnreportedCredential,
      } satisfies MachineGateway,
      forwards: new Map(current.forwards).set(key, { forward, scope: forwardScope, workers }),
      opened: Option.isNone(shared),
    };
  });

  const addWorker = Effect.fn("SshExecutor.addWorker")(function* (address: SshWorkerAddress) {
    const fields = {
      worker: address.name,
      host: placeOf(address),
      ...Option.match(address.gateway, {
        onNone: () => ({}),
        onSome: ({ destination }) => ({ gateway: destination }),
      }),
    };
    yield* Effect.annotateCurrentSpan(fields);
    const added = yield* SynchronizedRef.modifyEffect(machines, (current) =>
      Effect.gen(function* () {
        const existing = current.byWorker.get(address.name);
        if (existing !== undefined) {
          if (Equal.equals(existing.address, address)) return [Option.none(), current] as const;
          return yield* new WorkerCapabilityError({
            worker: address.name,
            capability: "machine",
            message: `Can't change the settings of SSH worker "${address.name}" while its attempts run. Reload again after they end.`,
            cause: new Error(
              `SSH worker "${address.name}" is in use at ${placeOf(existing.address)}`,
            ),
          });
        }
        const behind = yield* Effect.transposeOption(
          Option.map(address.gateway, (settings) => gatewayFor(current, address, settings)),
        );
        const gateway = Option.map(behind, ({ gateway }) => gateway);
        const entry: SshWorkerEntry = {
          address,
          gateway,
          machine:
            address.machine._tag === "Fixed"
              ? Option.some({
                  address,
                  gateway,
                  shell: commands.shellFor(
                    sshCommandFor(base, address),
                    address.machine.destination,
                  ),
                  workerDirectory: workerDirectoryOf(address),
                  provisioned: Option.none(),
                })
              : Option.none(),
        };
        return [
          Option.some(Option.exists(behind, ({ opened }) => opened)),
          {
            byWorker: new Map(current.byWorker).set(address.name, entry),
            forwards: Option.match(behind, {
              onNone: () => current.forwards,
              onSome: ({ forwards }) => forwards,
            }),
          },
        ] as const;
      }).pipe(Effect.uninterruptible),
    );
    yield* Option.match(added, {
      onNone: () =>
        Effect.logDebug("The SSH executor has this Worker with the same settings already", fields),
      onSome: (opened) =>
        Effect.logInfo(
          Option.isNone(address.gateway)
            ? "SSH Worker added to the executor"
            : opened
              ? "SSH Worker added to the executor; it is the first behind its Gateway, so the forward to the Gateway's admin API opens"
              : "SSH Worker added to the executor; it shares the forward to its Gateway's admin API",
          fields,
        ),
    });
  });

  const removeWorker = Effect.fn("SshExecutor.removeWorker")(function* (worker: WorkerName) {
    yield* Effect.annotateCurrentSpan({ worker });
    const removed = yield* SynchronizedRef.modify(machines, (current) => {
      const machine = current.byWorker.get(worker);
      if (machine === undefined) return [Option.none(), current] as const;
      const byWorker = new Map(current.byWorker);
      byWorker.delete(worker);
      const forwards = new Map(current.forwards);
      const left = Option.flatMap(machine.gateway, ({ settings }) => {
        const key = forwardKey(settings);
        const held = forwards.get(key);
        if (held === undefined) return Option.none();
        const workers = new Set(held.workers);
        workers.delete(worker);
        if (workers.size === 0) forwards.delete(key);
        else forwards.set(key, { ...held, workers });
        return Option.some({ held, others: workers.size });
      });
      return [Option.some({ machine, left }), { byWorker, forwards }] as const;
    });
    if (Option.isNone(removed)) {
      yield* Effect.logDebug("The SSH executor has no Worker by this name to remove", { worker });
      return;
    }
    const { machine, left } = removed.value;
    const fields = { worker, host: placeOf(machine.address) };
    if (Option.isNone(left)) {
      yield* Effect.logInfo("SSH Worker removed from the executor", fields);
      return;
    }
    const { held, others } = left.value;
    const gatewayFields = { ...fields, gateway: held.forward.gateway };
    if (others > 0) {
      yield* Effect.logInfo(
        "SSH Worker removed from the executor; the forward to its Gateway's admin API stays open for the other Workers behind it",
        { ...gatewayFields, others },
      );
      return;
    }
    yield* Scope.close(held.scope, Exit.void);
    yield* Effect.logInfo(
      "SSH Worker removed from the executor; it was the last behind its Gateway, so the forward to the Gateway's admin API closed",
      gatewayFields,
    );
  });

  const workerFor = Effect.fn("SshExecutor.workerFor")(function* (worker: WorkerName) {
    const entry = (yield* SynchronizedRef.get(machines)).byWorker.get(worker);
    if (entry === undefined)
      return yield* new WorkerCapabilityError({
        worker,
        capability: "machine",
        message: `No SSH worker named "${worker}" is configured`,
        cause: new Error("SSH worker address missing"),
      });
    return entry;
  });

  /** Returns a long-lived Worker's machine. Fails for a provisioned Worker, which has none. */
  const machineFor = Effect.fn("SshExecutor.machineFor")(function* (worker: WorkerName) {
    const entry = yield* workerFor(worker);
    if (Option.isNone(entry.machine))
      return yield* new WorkerCapabilityError({
        worker,
        capability: "machine",
        message: `SSH worker "${worker}" creates a machine for each attempt, so it has no machine of its own`,
        cause: new Error("provisioned SSH worker"),
      });
    return entry.machine.value;
  });

  /** Returns the machine at `endpoint` that a provider created for one Attempt on `entry`'s Worker. */
  const machineAt = (
    entry: SshWorkerEntry,
    id: MachineId,
    endpoint: MachineEndpoint,
    hostKey: PinnedHostKey,
  ): SshMachine => ({
    address: entry.address,
    gateway: entry.gateway,
    shell: commands.shellFor(
      provisionedSshCommandFor(base, entry, endpoint, hostKey),
      endpoint.destination,
    ),
    workerDirectory: workerDirectoryOf(entry.address),
    provisioned: Option.some(id),
  });

  return {
    machineFor,
    workerFor,
    machineAt,
    entries: SynchronizedRef.get(machines).pipe(
      Effect.map(({ byWorker }) => [...byWorker.values()]),
    ),
    workers: SshWorkers.of({ addWorker, removeWorker }),
  };
});
