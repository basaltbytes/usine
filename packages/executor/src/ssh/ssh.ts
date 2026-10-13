import type { SshCommand } from "@usine/agents/child-host";
import { type RepositoryName, safeSegment } from "@usine/core/repository";
import type { WorkerName } from "@usine/core/worker";
import type { AttemptRuntime } from "@usine/durable/attempt-runtime";
import { Effect, Layer, Option } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { type CredentialProvider, Executor, WorkerCapabilityError } from "../executor.ts";
import { agentsHarnessProbe } from "../harness-preflight.ts";
import { DEFAULT_SSH, remoteCommandsFor } from "../remote/commands.ts";
import type { RemoteGrant } from "../remote/machine.ts";
import { remoteExecutorFor } from "../remote/remote.ts";
import { sshCredentialsFor } from "./credentials.ts";
import type { SshExecutorOptions, SshMachine, SshWorkerAddress } from "./model.ts";
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
    const machines = new Map(
      options.workers.map((address): [WorkerName, SshMachine] => [
        address.name,
        {
          worker: address.name,
          address,
          shell: commands.shellFor(sshCommandFor(base, address), address.destination),
          workerDirectory: `${address.root}/workers/${safeSegment(address.name)}`,
        },
      ]),
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

    // The checks export nothing on the machine: a child's harness login lives there.
    const harnessProbe =
      options.harnessReadiness ??
      ((machine: SshMachine) => agentsHarnessProbe(spawner, machine.shell, {}));
    const credentials = yield* sshCredentialsFor(commands, machineFor);

    const grantFor = (repository: RepositoryName) =>
      Effect.succeed({
        acquire: (attemptId, worker, machine, operation) =>
          credentials.acquire(attemptId, worker, repository, machine, operation),
      } satisfies RemoteGrant<SshMachine>);

    return yield* remoteExecutorFor<SshMachine>({
      kind: "ssh",
      spanPrefix: "SshExecutor",
      label: "SSH",
      commands,
      machineFor,
      preflight: sshPreflightFor(commands, machineFor, harnessProbe),
      harnessProbe,
      repositoryUrl: (repository) => `https://github.com/${repository}.git`,
      grantFor,
      reclaim: (worker) => credentials.reclaim(worker),
      // The grace covers an SSH round trip plus the agent flushing its final
      // events, not just a local pipe.
      interruptGrace: options.interruptGrace ?? "10 seconds",
    });
  });

/**
 * Runs Attempts on Linux machines the orchestrator reaches over SSH: each
 * Attempt's Pi parent is a durable task in this process (`AttemptRuntime`),
 * and its children run on the Worker's machine, one SSH command each, with
 * the Attempt's single-repository GitHub token written beside its checkout
 * (ADR 0026). An orchestrator restart reattaches a live Attempt to its
 * checkout. Requires Node; worker contracts are platform-free.
 */
export const layer = (
  options: SshExecutorOptions,
): Layer.Layer<
  Executor,
  never,
  AttemptRuntime | CredentialProvider | ChildProcessSpawner.ChildProcessSpawner
> => Layer.effect(Executor, makeSshExecutor(options));

export type { SshExecutorOptions, SshMachine, SshWorkerAddress } from "./model.ts";
