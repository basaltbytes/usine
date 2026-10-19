import type { SshCommand } from "@usine/agents/child-host";
import { type RepositoryName, safeSegment } from "@usine/core/repository";
import type { WorkerName } from "@usine/core/worker";
import type { AttemptRuntime } from "@usine/durable/attempt-runtime";
import { Effect, Layer, Option } from "effect";
import type { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { type CredentialProvider, Executor, WorkerCapabilityError } from "../executor.ts";
import { agentsHarnessProbe } from "../harness-preflight.ts";
import { DEFAULT_SSH, remoteCommandsFor } from "../remote/commands.ts";
import type { RemoteGrant } from "../remote/machine.ts";
import { remoteExecutorFor } from "../remote/remote.ts";
import { sshCredentialsFor } from "./credentials.ts";
import { gatewayAdminFor } from "./gateway/admin.ts";
import { gatewayAttachmentsFor } from "./gateway/attachments.ts";
import { gatewayRepositoryUrl } from "./gateway/environment.ts";
import { type GatewayForward, gatewayForwardFor } from "./gateway/forward.ts";
import { gatewayHarnessProbe } from "./gateway/preflight.ts";
import type {
  SshExecutorOptions,
  SshMachine,
  SshWorkerAddress,
  SshWorkerGateway,
} from "./model.ts";
import { sshPreflightFor } from "./preflight.ts";

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

const makeSshExecutor = (options: SshExecutorOptions) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const commands = yield* remoteCommandsFor;
    const base = options.ssh ?? DEFAULT_SSH;
    if (new Set(options.workers.map(({ name }) => name)).size !== options.workers.length)
      return yield* Effect.die(new Error("SshExecutorOptions.workers contains duplicate names"));
    const forwards = new Map<string, GatewayForward>();
    const forwardTo = Effect.fn("SshExecutor.forwardTo")(function* (settings: SshWorkerGateway) {
      const key = `${settings.destination} ${String(settings.adminPort)}`;
      const existing = forwards.get(key);
      if (existing !== undefined) return existing;
      const forward = yield* gatewayForwardFor(
        spawner,
        commands.shellFor(base, settings.destination),
        settings.destination,
        settings.adminPort,
      );
      forwards.set(key, forward);
      return forward;
    });
    const machines = new Map(
      yield* Effect.forEach(options.workers, (address) =>
        Effect.gen(function* () {
          const gateway = yield* Effect.transposeOption(
            Option.map(address.gateway, (settings) =>
              Effect.gen(function* () {
                const forward = yield* forwardTo(settings);
                const admin = yield* gatewayAdminFor(address.name, settings, forward);
                return { settings, forward, admin };
              }),
            ),
          );
          const machine: SshMachine = {
            address,
            gateway,
            shell: commands.shellFor(sshCommandFor(base, address), address.destination),
            workerDirectory: `${address.root}/workers/${safeSegment(address.name)}`,
          };
          return [address.name, machine] as const;
        }),
      ),
    );

    const machineFor = Effect.fn("SshExecutor.machineFor")(function* (worker: WorkerName) {
      const machine = machines.get(worker);
      if (machine === undefined)
        return yield* new WorkerCapabilityError({
          worker,
          capability: "machine",
          message: `No SSH Worker named ${worker} is configured`,
          cause: new Error("SSH Worker address missing"),
        });
      return machine;
    });

    // The checks export nothing on the machine: a child's harness login lives
    // there, or at the Gateway in front of it.
    const harnessProbe = (machine: SshMachine) => {
      const probe =
        options.harnessReadiness?.(machine) ?? agentsHarnessProbe(spawner, machine.shell, {});
      return Option.match(machine.gateway, {
        onNone: () => probe,
        onSome: (gateway) => gatewayHarnessProbe(commands, machine, gateway, probe),
      });
    };
    const credentials = yield* sshCredentialsFor(commands, machineFor);
    const attachments = yield* gatewayAttachmentsFor(commands, machineFor);

    // A Worker that moved behind a Gateway may still have tokens an earlier
    // process wrote on its machine, so every Worker removes them.
    const reclaim = (worker: WorkerName) =>
      credentials.reclaim(worker).pipe(Effect.andThen(attachments.reclaim(worker)));

    const grantFor = (repository: RepositoryName) =>
      Effect.succeed({
        acquire: (attemptId, worker, permissions, machine, operation) =>
          Effect.gen(function* () {
            yield* reclaim(worker);
            if (Option.isNone(machine.gateway))
              return yield* credentials.acquire(
                attemptId,
                worker,
                repository,
                permissions,
                machine,
                operation,
              );
            return yield* attachments.acquire(
              attemptId,
              worker,
              repository,
              permissions,
              machine,
              machine.gateway.value,
              operation,
            );
          }),
      } satisfies RemoteGrant<SshMachine>);

    return yield* remoteExecutorFor<SshMachine>({
      kind: "ssh",
      spanPrefix: "SshExecutor",
      label: "SSH",
      commands,
      machineFor,
      preflight: sshPreflightFor(commands, machineFor, harnessProbe),
      harnessProbe,
      repositoryUrl: (machine, repository) =>
        Option.match(machine.gateway, {
          onNone: () => `https://github.com/${repository}.git`,
          onSome: ({ settings }) => gatewayRepositoryUrl(settings.domain, repository),
        }),
      grantFor,
      readOnlyAccessGap: Option.none(),
      reclaim,
      // The grace covers an SSH round trip plus the agent flushing its final
      // events, not just a local pipe.
      interruptGrace: options.interruptGrace ?? "10 seconds",
    });
  });

/**
 * Runs Attempts on Linux machines the orchestrator connects to over SSH: each
 * Attempt's Pi parent is a durable task in this process (`AttemptRuntime`),
 * and its children run on the Worker's machine, one SSH command each. A
 * Worker without a Gateway gets the Attempt's single-repository GitHub token
 * written beside its checkout (ADR 0026); a Worker behind a Gateway gets no
 * token, only a caller token for the attachment the executor makes on the
 * Gateway's admin API through `HttpClient` (ADR 0027). The executor opens
 * its own SSH forward to each Gateway's admin API when the layer is built,
 * reopens it whenever its SSH client exits, and closes it with the layer. An
 * orchestrator restart reattaches a live Attempt to its checkout. Requires
 * Node; worker contracts are platform-free.
 */
export const layer = (
  options: SshExecutorOptions,
): Layer.Layer<
  Executor,
  never,
  | AttemptRuntime
  | CredentialProvider
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient
> => Layer.effect(Executor, makeSshExecutor(options));

export type {
  SshExecutorOptions,
  SshMachine,
  SshWorkerAddress,
  SshWorkerGateway,
} from "./model.ts";
