import type { SshCommand } from "@usine/agents/child-host";
import { safeSegment } from "@usine/core/repository";
import type { GatewayCredentialKind, WorkerName } from "@usine/core/worker";
import { Context, Effect, Equal, Exit, Option, Ref, Scope, SynchronizedRef } from "effect";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { WorkerCapabilityError } from "../executor.ts";
import type { RemoteCommands } from "../remote/commands.ts";
import { gatewayAdminFor } from "./gateway/admin.ts";
import { type GatewayForward, gatewayForwardFor } from "./gateway/forward.ts";
import type { MachineGateway, SshMachine, SshWorkerAddress, SshWorkerGateway } from "./model.ts";

/**
 * The Workers the SSH executor runs Attempts on. It starts with the Workers
 * of `SshExecutorOptions.workers`, and a reload adds and removes Workers
 * through it while the executor runs.
 */
export class SshWorkers extends Context.Service<
  SshWorkers,
  {
    /**
     * Gives the executor the machine at `address`, so preflight and Attempts
     * can use the Worker it names. Behind a Gateway, the Worker shares the
     * forward to the Gateway's admin API with the other Workers behind the
     * same `destination` and `adminPort`, or opens it when it is the first.
     * Adding a Worker the executor has with the same address changes nothing;
     * with another address it fails with a `machine` capability error,
     * because the Worker's running Attempts still use the machine it has.
     */
    readonly addWorker: (address: SshWorkerAddress) => Effect.Effect<void, WorkerCapabilityError>;
    /**
     * Takes the machine of `worker` away, so a request that names the Worker
     * fails with a `machine` capability error. Call it once no Attempt runs
     * on the Worker: when it was the last Worker behind its Gateway, the
     * forward to the Gateway's admin API closes. Removing a Worker the
     * executor does not have changes nothing.
     */
    readonly removeWorker: (worker: WorkerName) => Effect.Effect<void>;
  }
>()("@usine/executor/SshWorkers") {}

/** The executor's forward to one Gateway's admin API, the scope it runs in, and the Workers behind that Gateway. */
interface HeldForward {
  readonly forward: GatewayForward;
  readonly scope: Scope.Closeable;
  readonly workers: ReadonlySet<WorkerName>;
}

interface Machines {
  readonly byWorker: ReadonlyMap<WorkerName, SshMachine>;
  /** By Gateway destination and admin port. */
  readonly forwards: ReadonlyMap<string, HeldForward>;
}

const forwardKey = ({ destination, adminPort }: SshWorkerGateway) =>
  `${destination} ${String(adminPort)}`;

/** The SSH client for one Worker: the shared options, then its own port and key. */
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

/**
 * The SSH Workers' machines, which `addWorker` and `removeWorker` change
 * while the executor runs, and `machineFor`, which reads them at each call.
 * Each forward to a Gateway's admin API runs in its own scope inside the
 * caller's, so it closes with its last Worker or with the caller's scope.
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

  /** The Gateway in front of `address`'s machine, with the forward it shares or opens, and the forwards afterwards. */
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
    const anthropicCredential = yield* Ref.make(Option.none<GatewayCredentialKind>());
    const warnedOfUnreportedCredential = yield* Ref.make(false);
    return {
      gateway: {
        settings,
        forward,
        admin,
        anthropicCredential,
        warnedOfUnreportedCredential,
      } satisfies MachineGateway,
      forwards: new Map(current.forwards).set(key, { forward, scope: forwardScope, workers }),
      opened: Option.isNone(shared),
    };
  });

  const addWorker = Effect.fn("SshExecutor.addWorker")(function* (address: SshWorkerAddress) {
    const fields = {
      worker: address.name,
      host: address.destination,
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
            message: `SSH Worker ${address.name} still has its earlier settings, which its running Attempts use; reload again once they end`,
            cause: new Error(
              `SSH Worker ${address.name} is in use at ${existing.address.destination}`,
            ),
          });
        }
        const behind = yield* Effect.transposeOption(
          Option.map(address.gateway, (settings) => gatewayFor(current, address, settings)),
        );
        const machine: SshMachine = {
          address,
          gateway: Option.map(behind, ({ gateway }) => gateway),
          shell: commands.shellFor(sshCommandFor(base, address), address.destination),
          workerDirectory: `${address.root}/workers/${safeSegment(address.name)}`,
        };
        return [
          Option.some(Option.exists(behind, ({ opened }) => opened)),
          {
            byWorker: new Map(current.byWorker).set(address.name, machine),
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
    const fields = { worker, host: machine.address.destination };
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

  const machineFor = Effect.fn("SshExecutor.machineFor")(function* (worker: WorkerName) {
    const machine = (yield* SynchronizedRef.get(machines)).byWorker.get(worker);
    if (machine === undefined)
      return yield* new WorkerCapabilityError({
        worker,
        capability: "machine",
        message: `No SSH Worker named ${worker} is configured`,
        cause: new Error("SSH Worker address missing"),
      });
    return machine;
  });

  return { machineFor, workers: SshWorkers.of({ addWorker, removeWorker }) };
});
