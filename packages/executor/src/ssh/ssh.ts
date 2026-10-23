import { ClaudeLoginLock } from "@usine/agents/runtime";
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
import { gatewayCredentialFor, gatewayHarnessProbe } from "./gateway/preflight.ts";
import type { SshExecutorOptions, SshMachine } from "./model.ts";
import { sshPreflightFor } from "./preflight.ts";
import { sshMachinesFor, SshWorkers } from "./workers.ts";

const makeSshExecutor = (options: SshExecutorOptions) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const logins = yield* ClaudeLoginLock;
    const commands = yield* remoteCommandsFor;
    const base = options.ssh ?? DEFAULT_SSH;
    if (new Set(options.workers.map(({ name }) => name)).size !== options.workers.length)
      return yield* Effect.die(new Error("SshExecutorOptions.workers contains duplicate names"));
    const { machineFor, workers } = yield* sshMachinesFor(base, commands);
    // Worker names are distinct, so adding them can't fail.
    yield* Effect.forEach(options.workers, workers.addWorker, { discard: true }).pipe(Effect.orDie);

    // Probes with no extra environment; the harness login is on the machine or at its Gateway.
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

    // Runs for every Worker, because one that moved behind a Gateway can still have tokens from
    // an earlier process.
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
      preflight: sshPreflightFor(commands, machineFor, harnessProbe, logins),
      harnessProbe,
      repositoryUrl: (machine, repository) =>
        Option.match(machine.gateway, {
          onNone: () => `https://github.com/${repository}.git`,
          onSome: ({ settings }) => gatewayRepositoryUrl(settings.domain, repository),
        }),
      gatewayCredential: (machine, harness) =>
        Option.match(machine.gateway, {
          onNone: () => Effect.succeedNone,
          onSome: (gateway) => gatewayCredentialFor(gateway, harness),
        }),
      grantFor,
      readOnlyAccessGap: Option.none(),
      reclaim,
      interruptGrace: options.interruptGrace ?? "10 seconds",
    });
    return Context.make(Executor, executor).pipe(Context.add(SshWorkers, workers));
  });

/**
 * The executor for Linux machines accessed over SSH. Each Attempt's Pi parent is a durable task
 * in this process (`AttemptRuntime`), and each child runs on the machine as one SSH command.
 * Without a Gateway, the Attempt's GitHub token is written next to its checkout (ADR 0026).
 * Behind a Gateway, the machine gets only a caller token for an attachment made through the
 * Gateway's admin API (ADR 0027). `SshWorkers` adds and removes Workers at runtime. Requires
 * Node.
 */
export const layer = (
  options: SshExecutorOptions,
): Layer.Layer<
  Executor | SshWorkers,
  never,
  | AttemptRuntime
  | ClaudeLoginLock
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
