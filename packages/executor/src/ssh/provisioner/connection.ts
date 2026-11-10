import { RemoteShell } from "@usine/agents/child-host";
import type { MachineId } from "@usine/core/worker";
import { Effect, FileSystem, Option, Ref } from "effect";
import { WorkerCapabilityError } from "../../executor.ts";
import type { ConnectionProbe, Probe, ProbeConnection } from "../../remote/liveness.ts";
import type { SshMachine } from "../model.ts";
import type { PinnedHostKey } from "../workers.ts";
import { type MachineDriver, MachineEndpoint, type SshEndpoint } from "./model.ts";

const addressOf = (endpoint: SshEndpoint) =>
  `${endpoint.destination}:${Option.getOrElse(endpoint.port, () => 22)}`;

/**
 * Keeps retained attempt shells connected. An SSH endpoint that the provider can move is reached
 * through an atomically updated OpenSSH config file; an `Exec` endpoint never moves, so its probe
 * only asks the provider whether the machine is gone.
 */
export const machineConnections = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return Effect.fn("SshExecutor.machineConnectionFor")(function* (
    id: MachineId,
    endpoint: MachineEndpoint,
    driver: MachineDriver,
    pinned: PinnedHostKey,
    connect: (endpoint: MachineEndpoint) => SshMachine,
  ) {
    const machine = connect(endpoint);
    const refresh = driver.refreshEndpoint;
    if (refresh === undefined) return machine;
    const worker = machine.address.name;
    const fields = { worker, machine: id, provider: driver.provider };
    yield* Effect.annotateCurrentSpan(fields);
    const gone = {
      _tag: "Gone",
      reason: `The ${driver.provider} sandbox ${id} stopped or was removed`,
    } satisfies ConnectionProbe;
    if (endpoint._tag === "Exec") {
      const probe: ProbeConnection = Effect.fn("SshExecutor.probeExecMachine")((inspect) =>
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan(fields);
          const initial = yield* inspect(machine.shell);
          if (initial._tag === "Answered") return initial;
          const current = yield* refresh(id).pipe(
            Effect.catchTag("ProviderApiError", (error) =>
              Effect.logWarning(
                "Could not ask the provider whether the unanswering machine is gone",
                { ...fields, message: error.message },
              ).pipe(Effect.as(Option.some<MachineEndpoint>(endpoint))),
            ),
          );
          return Option.isNone(current) ? gone : initial;
        }),
      );
      return { ...machine, probe } satisfies SshMachine;
    }
    const file = `${pinned.file}.ssh-config`;
    const write = Effect.fn("SshExecutor.updateMachineConnection")(function* (next: SshEndpoint) {
      yield* Effect.annotateCurrentSpan({ ...fields, endpoint: addressOf(next) });
      const host = next.destination.slice(next.destination.lastIndexOf("@") + 1);
      yield* fs.writeFileString(
        `${file}.next`,
        `Host *\n  HostName ${host}\n  Port ${Option.getOrElse(next.port, () => 22)}\n`,
      );
      yield* fs.rename(`${file}.next`, file);
    });
    const state = yield* Ref.make({ selected: endpoint, previous: Option.none<SshEndpoint>() });
    yield* write(endpoint).pipe(
      Effect.mapError((cause) =>
        WorkerCapabilityError.make({
          worker,
          capability: "machine",
          message: `Can't record the SSH endpoint of machine ${id}: ${cause.message}`,
          cause,
        }),
      ),
    );
    const base = connect(
      MachineEndpoint.Ssh({
        destination: endpoint.destination,
        port: Option.none(),
        hostKey: endpoint.hostKey,
      }),
    ).shell;
    if (base._tag !== "RemoteShell")
      return yield* Effect.die(new Error(`The SSH endpoint of ${id} has no SSH client`));
    const shell = RemoteShell.make({
      ...base,
      ssh: { command: base.ssh.command, args: ["-F", file, ...base.ssh.args] },
    });

    const probe: ProbeConnection = Effect.fn("SshExecutor.reconnectMachine")((inspect) =>
      Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan(fields);
        const initial = yield* inspect(shell);
        if (initial._tag === "Answered") return initial;
        const current = yield* Ref.get(state);
        const advertised = yield* refresh(id).pipe(
          Effect.catchTag("ProviderApiError", (error) =>
            Effect.logWarning(
              "Could not refresh the machine endpoint; trying the last working endpoints",
              { ...fields, message: error.message },
            ).pipe(Effect.as(Option.some(current.selected))),
          ),
        );
        if (Option.isNone(advertised)) return gone;

        const tried = new Set([addressOf(current.selected)]);
        const candidates = [advertised.value, ...Option.toArray(current.previous)].filter(
          (candidate): candidate is SshEndpoint => candidate._tag === "Ssh",
        );
        for (const candidate of candidates) {
          const address = addressOf(candidate);
          if (tried.has(address)) continue;
          tried.add(address);
          const result = yield* inspect(connect(candidate).shell);
          if (result._tag === "Unanswered") {
            yield* Effect.logWarning("The alternate SSH endpoint did not answer", {
              ...fields,
              endpoint: address,
              reason: result.reason,
            });
            continue;
          }
          yield* write(candidate);
          yield* Ref.set(state, { selected: candidate, previous: Option.some(current.selected) });
          yield* Effect.logInfo("Reconnected the machine at a different SSH endpoint", {
            ...fields,
            previousEndpoint: addressOf(current.selected),
            endpoint: address,
          });
          return result;
        }
        yield* Effect.logWarning("The running machine did not answer at any known SSH endpoint", {
          ...fields,
          endpoints: [...tried],
        });
        return initial;
      }).pipe(
        Effect.catchTag("PlatformError", (error) =>
          Effect.logWarning("Could not update the machine's SSH connection", {
            ...fields,
            message: error.message,
          }).pipe(Effect.as<Probe>({ _tag: "Unanswered", reason: error.message })),
        ),
      ),
    );
    return { ...machine, shell, probe } satisfies SshMachine;
  });
});
