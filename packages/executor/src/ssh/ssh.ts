import type { RemoteShell } from "@usine/agents/child-host";
import { ClaudeLoginLock } from "@usine/agents/runtime";
import type { Harness } from "@usine/core/agent/brain";
import type { AttemptId } from "@usine/core/attempt";
import type { AttemptRecovery } from "@usine/core/attempt/salvage";
import { type RepositoryName, safeSegment } from "@usine/core/repository";
import type { GatewayCredentialKind, WorkerName } from "@usine/core/worker";
import type { AttemptRuntime } from "@usine/durable/attempt-runtime";
import { Context, Effect, type FileSystem, Layer, Option, type Path, Redacted } from "effect";
import type { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  type CredentialProvider,
  Executor,
  type ExecutorError,
  WorkerMachines,
} from "../executor.ts";
import { agentsHarnessProbe, type HarnessProbe } from "../harness-preflight.ts";
import { DEFAULT_SSH, remoteCommandsFor, sendingShell } from "../remote/commands.ts";
import type { RemoteAccess, RemoteGrant } from "../remote/machine.ts";
import { remoteExecutorFor } from "../remote/remote.ts";
import { sshContainersFor } from "./container.ts";
import { sshCredentialsFor } from "./credentials.ts";
import { gatewayAttachmentsFor } from "./gateway/attachments.ts";
import { gatewayRepositoryUrl } from "./gateway/environment.ts";
import {
  claudeBinaryProbe,
  gatewayCredentialFor,
  gatewayHarnessProbe,
  verifyGatewayAdmin,
} from "./gateway/preflight.ts";
import type { SshExecutorOptions, SshMachine } from "./model.ts";
import { sshMachinePreflightFor, sshPreflightFor } from "./preflight.ts";
import { provisionedMachinesFor } from "./provisioner/machines.ts";
import { sshMachinesFor, SshWorkers } from "./workers.ts";

/**
 * Returns the API key that each Attempt on `machine` gets for `harness`, or `None` if its
 * machine isn't provisioned, the provisioner sets no key, or the Gateway has the provider's
 * credential.
 */
const apiKeyFor = (
  machine: SshMachine,
  harness: Harness,
): Option.Option<Redacted.Redacted<string>> => {
  const { address } = machine;
  if (address.machine._tag !== "Provisioned" || harness !== "claude") return Option.none();
  if (Option.exists(machine.gateway, ({ settings }) => settings.llmProviders.includes("anthropic")))
    return Option.none();
  return address.machine.provisioner.apiKeys.anthropic;
};

/** Returns `access` with the provisioner's API keys among the Attempt's secrets. */
const withApiKeys = (machine: SshMachine, access: RemoteAccess): RemoteAccess => {
  const key = apiKeyFor(machine, "claude");
  if (Option.isNone(key)) return access;
  const value = Redacted.value(key.value);
  const secrets = { ANTHROPIC_API_KEY: key.value };
  return {
    ...access,
    // An Attempt container gets the secrets when it starts; without one, the SSH connection
    // sends them.
    shell: sendingShell(access.shell, secrets),
    secrets: { ...access.secrets, ...secrets },
    scrub: (text) => access.scrub(text).replaceAll(value, "<redacted>"),
  };
};

const makeSshExecutor = (options: SshExecutorOptions) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const logins = yield* ClaudeLoginLock;
    const commands = yield* remoteCommandsFor;
    const base = options.ssh ?? DEFAULT_SSH;
    if (new Set(options.workers.map(({ name }) => name)).size !== options.workers.length)
      return yield* Effect.die(new Error("SshExecutorOptions.workers contains duplicate names"));
    const { machineFor, workerFor, machineAt, entries, workers } = yield* sshMachinesFor(
      base,
      commands,
    );
    // Worker names are distinct, so adding them can't fail.
    yield* Effect.forEach(options.workers, workers.addWorker, { discard: true }).pipe(Effect.orDie);

    // Probes with no extra environment; the harness login is on the machine or at its Gateway,
    // or a provisioned machine's Attempts get an API key.
    const harnessProbe = (machine: SshMachine, shell: RemoteShell): HarnessProbe => {
      const own = options.harnessReadiness?.(machine) ?? agentsHarnessProbe(spawner, shell, {});
      const probe: HarnessProbe = (brain) =>
        Option.isSome(apiKeyFor(machine, brain.harness))
          ? claudeBinaryProbe(
              commands,
              machine.shell.destination,
              shell,
              "the API key in the attempt's environment",
            )
          : own(brain);
      return Option.match(machine.gateway, {
        onNone: () => probe,
        onSome: (gateway) => gatewayHarnessProbe(commands, machine, gateway, probe, shell),
      });
    };
    const credentials = yield* sshCredentialsFor(commands, machineFor);
    const attachments = yield* gatewayAttachmentsFor(commands, workerFor);
    const containers = yield* sshContainersFor(commands, machineFor, options.instance);
    const verifyMachine = sshMachinePreflightFor(commands, harnessProbe, logins, containers);
    const provisioned = yield* provisionedMachinesFor({
      instance: options.instance,
      commands,
      workerFor,
      entries,
      machineAt,
      verifyMachine,
      verifyGatewayAdmin,
      settings: options,
    });

    // Runs for every Worker, because one that moved behind a Gateway can still have tokens from
    // an earlier process. A provisioned Worker's machines are new, so only its Gateway can have
    // leftovers.
    const reclaim = (worker: WorkerName) =>
      provisioned
        .provisions(worker)
        .pipe(
          Effect.flatMap((perAttempt) =>
            perAttempt
              ? attachments.reclaim(worker)
              : credentials
                  .reclaim(worker)
                  .pipe(
                    Effect.andThen(attachments.reclaim(worker)),
                    Effect.andThen(containers.reclaim(worker)),
                  ),
          ),
        );

    const grantFor = (repository: RepositoryName) =>
      Effect.succeed({
        acquire: (attemptId, worker, permissions, machine, operation) =>
          Effect.gen(function* () {
            yield* reclaim(worker);
            if (Option.isNone(machine.gateway))
              return withApiKeys(
                machine,
                yield* credentials.acquire(
                  attemptId,
                  worker,
                  repository,
                  permissions,
                  machine,
                  operation,
                ),
              );
            return withApiKeys(
              machine,
              yield* attachments.acquire(
                attemptId,
                worker,
                repository,
                permissions,
                machine,
                machine.gateway.value,
                operation,
              ),
            );
          }),
      } satisfies RemoteGrant<SshMachine>);

    const attemptMachine = (
      worker: WorkerName,
      attemptId: AttemptId,
    ): Effect.Effect<SshMachine, ExecutorError> =>
      Effect.flatMap(
        provisioned.provisions(worker),
        (perAttempt): Effect.Effect<SshMachine, ExecutorError> =>
          perAttempt ? provisioned.attemptMachine(worker, attemptId) : machineFor(worker),
      );

    const executor = yield* remoteExecutorFor<SshMachine>({
      kind: "ssh",
      spanPrefix: "SshExecutor",
      label: "SSH",
      commands,
      machineFor,
      attemptMachine,
      leftovers: (attempt: AttemptRecovery, listed) =>
        provisioned.provisions(attempt.worker).pipe(
          Effect.flatMap((perAttempt) =>
            perAttempt
              ? provisioned.recoveryMachine(attempt.worker, attempt.attemptId).pipe(
                  Effect.map(
                    Option.map((machine) => ({
                      machine,
                      checkouts: new Set([
                        `${machine.workerDirectory}/attempts/${safeSegment(attempt.attemptId)}`,
                      ]),
                    })),
                  ),
                )
              : Effect.map(listed, Option.some),
          ),
        ),
      recovered: (attempt, succeeded) => provisioned.recovered(attempt.attemptId, succeeded),
      checkoutHeld: provisioned.checkoutHeld,
      preflight: sshPreflightFor(workerFor, verifyMachine, provisioned.verifyProvisioned),
      harnessProbe,
      isolation: containers.isolation,
      runsContainers: true,
      repositoryUrl: (machine, repository) =>
        Option.match(machine.gateway, {
          onNone: () => `https://github.com/${repository}.git`,
          onSome: ({ settings }) => gatewayRepositoryUrl(settings.domain, repository),
        }),
      gatewayCredential: (machine, harness) =>
        Option.match(machine.gateway, {
          onNone: () => Effect.succeed(Option.none<GatewayCredentialKind>()),
          onSome: (gateway) => gatewayCredentialFor(gateway, harness),
        }).pipe(
          Effect.map((kind): Option.Option<GatewayCredentialKind> =>
            Option.isSome(kind) || Option.isNone(apiKeyFor(machine, harness))
              ? kind
              : Option.some("api-key"),
          ),
        ),
      grantFor,
      readOnlyAccessGap: Option.none(),
      reclaim,
      interruptGrace: options.interruptGrace ?? "10 seconds",
    });
    return Context.make(Executor, executor).pipe(
      Context.add(SshWorkers, workers),
      Context.add(WorkerMachines, provisioned.port),
    );
  });

/**
 * The executor for Linux machines accessed over SSH. Each Attempt's Pi parent is a durable task
 * in this process (`AttemptRuntime`), and each child runs on the machine as one SSH command, in
 * the Attempt's own container if the machine has Docker. Without a Gateway, the Attempt's GitHub
 * token is written next to its checkout (ADR 0026). Behind a Gateway, the machine gets only a
 * caller token for an attachment made through the Gateway's admin API (ADR 0027). A provisioned
 * Worker creates one machine per Attempt at a provider and deletes it afterwards
 * (`WorkerMachines`, #550). `SshWorkers` adds and removes Workers at runtime. Requires Node.
 */
export const layer = (
  options: SshExecutorOptions,
): Layer.Layer<
  Executor | SshWorkers | WorkerMachines,
  never,
  | AttemptRuntime
  | ClaudeLoginLock
  | CredentialProvider
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
> => Layer.effectContext(makeSshExecutor(options).pipe(Effect.orDie));

export type {
  BoatProvisioner,
  HetznerProvisioner,
  ProviderApiKeys,
  SshExecutorOptions,
  SshMachine,
  SshProvisioner,
  SshWorkerAddress,
  SshWorkerContainer,
  SshWorkerGateway,
  SshWorkerMachine,
} from "./model.ts";
export { ATTEMPT_IMAGE } from "./container.ts";
export { SshWorkers } from "./workers.ts";
