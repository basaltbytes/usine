import type { RepositoryName } from "@usine/core/repository";
import type { WorkerName } from "@usine/core/worker";
import type { AttemptRuntime } from "@usine/durable/attempt-runtime";
import { Context, Effect, Layer, Option } from "effect";
import type { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { type CredentialProvider, Executor } from "../executor.ts";
import { agentsHarnessProbe } from "../harness-preflight.ts";
import { DEFAULT_SSH, remoteCommandsFor } from "../remote/commands.ts";
import type { RemoteGrant } from "../remote/machine.ts";
import { remoteExecutorFor } from "../remote/remote.ts";
import { sshCredentialsFor } from "./credentials.ts";
import { gatewayAttachmentsFor } from "./gateway/attachments.ts";
import { gatewayRepositoryUrl } from "./gateway/environment.ts";
import { gatewayHarnessProbe } from "./gateway/preflight.ts";
import type { SshExecutorOptions, SshMachine } from "./model.ts";
import { sshPreflightFor } from "./preflight.ts";
import { sshMachinesFor, SshWorkers } from "./workers.ts";

const makeSshExecutor = (options: SshExecutorOptions) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const commands = yield* remoteCommandsFor;
    const base = options.ssh ?? DEFAULT_SSH;
    if (new Set(options.workers.map(({ name }) => name)).size !== options.workers.length)
      return yield* Effect.die(new Error("SshExecutorOptions.workers contains duplicate names"));
    const { machineFor, workers } = yield* sshMachinesFor(base, commands);
    // Distinct names cannot clash with a Worker added before them.
    yield* Effect.forEach(options.workers, workers.addWorker, { discard: true }).pipe(Effect.orDie);

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

    const executor = yield* remoteExecutorFor<SshMachine>({
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
    return Context.make(Executor, executor).pipe(Context.add(SshWorkers, workers));
  });

/**
 * Runs Attempts on Linux machines the orchestrator connects to over SSH: each
 * Attempt's Pi parent is a durable task in this process (`AttemptRuntime`),
 * and its children run on the Worker's machine, one SSH command each. A
 * Worker without a Gateway gets the Attempt's single-repository GitHub token
 * written beside its checkout (ADR 0026); a Worker behind a Gateway gets no
 * token, only a caller token for the attachment the executor makes on the
 * Gateway's admin API through `HttpClient` (ADR 0027). It starts with the
 * Workers of `options`, and `SshWorkers` adds and removes Workers while it
 * runs. The executor opens its own SSH forward to a Gateway's admin API with
 * the first Worker behind that Gateway, reopens it whenever its SSH client
 * exits, and closes it with the last Worker behind it or with the layer. An
 * orchestrator restart reattaches a live Attempt to its checkout. Requires
 * Node; worker contracts are platform-free.
 */
export const layer = (
  options: SshExecutorOptions,
): Layer.Layer<
  Executor | SshWorkers,
  never,
  | AttemptRuntime
  | CredentialProvider
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient
> => Layer.effectContext(makeSshExecutor(options));

export type {
  SshExecutorOptions,
  SshMachine,
  SshWorkerAddress,
  SshWorkerGateway,
} from "./model.ts";
export { SshWorkers } from "./workers.ts";
