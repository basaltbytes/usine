import { listMachineLeftovers } from "../remote/leftovers.ts";
import { safeSegment } from "@usine/core/repository";
import type { AttemptId } from "@usine/core/attempt";
import { attemptConnectionsFor } from "../attempt-connections.ts";
import type { RemoteHost } from "@usine/agents/child-host";
import { Harnesses } from "@usine/agents/harness/node";
import type { Harness } from "@usine/core/agent/brain";
import type { RepositoryName } from "@usine/core/repository";
import type { GatewayCredentialKind, WorkerName } from "@usine/core/worker";
import type { AttemptRuntime } from "@usine/durable/attempt-runtime";
import { Cache, Context, type Crypto, Effect, FileSystem, Layer, Option, type Path } from "effect";
import type { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import {
  type CredentialProvider,
  Executor,
  WorkerCapabilityError,
  WorkerMachines,
} from "../executor.ts";
import { agentsHarnessProbe, type HarnessProbe } from "../harness-preflight.ts";
import { DEFAULT_SSH, remoteCommandsFor } from "../remote/commands.ts";
import type { RemoteGrant } from "../remote/machine.ts";
import { remoteExecutorFor } from "../remote/remote.ts";
import { attemptHomesFor } from "./attempt-homes.ts";
import { sshContainersFor } from "./container.ts";
import { sshCredentialsFor } from "./credentials.ts";
import { gatewayAttachmentsFor } from "./gateway/attachments.ts";
import { gatewayRepositoryUrl } from "./gateway/environment.ts";
import { machineCredentialRoute, provisionedApiKey, withApiKeys } from "./api-keys.ts";
import {
  gatewayCredentialFor,
  gatewayHarnessProbe,
  verifyGatewayAdmin,
} from "./gateway/preflight.ts";
import type { SshExecutorOptions, SshMachine, SshWorkerAddress } from "./model.ts";
import { sshMachinePreflightFor, sshPreflightFor } from "./preflight.ts";
import { machineResetFor } from "./provisioner/reset.ts";
import { provisionedMachinesFor } from "./provisioner/machines.ts";
import { sshWorkerRecordsFor } from "./worker-records.ts";
import { sshMachinesFor, SshWorkers } from "./workers.ts";

const makeSshExecutor = (options: SshExecutorOptions) =>
  Effect.gen(function* () {
    const harnesses = yield* Harnesses;
    const { catalog } = harnesses;
    const remoteCommands = yield* remoteCommandsFor;
    const reset = machineResetFor(catalog, remoteCommands, options.instance, options.instanceId);
    const { commands } = reset;
    const base = options.ssh ?? DEFAULT_SSH;
    if (new Set(options.workers.map(({ name }) => name)).size !== options.workers.length)
      return yield* Effect.die(new Error("SshExecutorOptions.workers contains duplicate names"));
    const { machineFor, workerFor, entryFor, machineAt, entries, workers } = yield* sshMachinesFor(
      base,
      commands,
    );
    const connections = yield* attemptConnectionsFor(options.attemptConnections);
    const attemptEntry = (
      worker: WorkerName,
      attemptId: AttemptId,
      purpose: "prepare" | "recovery" = "prepare",
    ) =>
      connections
        .resolve(
          worker,
          attemptId,
          workerFor(worker).pipe(Effect.map(({ address }) => address)),
          purpose,
        )
        .pipe(
          Effect.flatMap(entryFor),
          Effect.mapError((cause) =>
            cause._tag === "WorkerCapabilityError"
              ? cause
              : WorkerCapabilityError.make({
                  worker,
                  capability: "machine",
                  message: `Can't restore the connection of attempt ${attemptId}: ${cause.message}`,
                  cause,
                }),
          ),
        );
    const fs = yield* FileSystem.FileSystem;
    const records = yield* sshWorkerRecordsFor(
      catalog,
      options.workerRecordsDirectory ??
        (yield* fs.makeTempDirectoryScoped({ prefix: "usine-ssh-workers-" }).pipe(Effect.orDie)),
      base,
    );
    // Records each long-lived Worker it adds, so its leftovers can be discarded once usine.yaml
    // drops it.
    const addWorker = (address: SshWorkerAddress) =>
      workers.addWorker(address).pipe(Effect.andThen(records.remember(address)));
    // Worker names are distinct, so adding them can't fail.
    yield* Effect.forEach(options.workers, addWorker, { discard: true }).pipe(Effect.orDie);

    // Probes with no extra environment; the harness login is on the machine or at its Gateway,
    // or a provisioned machine's Attempts get an API key.
    const harnessProbe = (machine: SshMachine, shell: RemoteHost): HarnessProbe => {
      const own = options.harnessReadiness?.(machine) ?? agentsHarnessProbe(harnesses, shell, {});
      const keyed = (harness: Harness) =>
        Option.isSome(provisionedApiKey(catalog, machine, harness));
      const external = agentsHarnessProbe(harnesses, shell, {}, "api-key");
      const probe: HarnessProbe = (brain, login) =>
        keyed(brain.harness) ? external(brain, login) : own(brain, login);
      return Option.match(machine.gateway, {
        onNone: () => probe,
        onSome: (gateway) =>
          gatewayHarnessProbe(
            catalog,
            commands,
            machine,
            gateway,
            probe,
            shell,
            keyed,
            agentsHarnessProbe(harnesses, shell, {}, "gateway"),
          ),
      });
    };
    const credentials = yield* sshCredentialsFor(commands);
    const attemptHomes = yield* attemptHomesFor(commands);
    const attachments = yield* gatewayAttachmentsFor(commands, attemptHomes.hold, (machine) =>
      reset.failed(machine.shell),
    );
    const containers = yield* sshContainersFor(commands, options.instance, options.instanceId);
    const verifyMachine = sshMachinePreflightFor(catalog, commands, harnessProbe, containers);
    const forgetConnection = Effect.fn("SshExecutor.forgetReleasedConnection")(function* (
      attemptId: AttemptId,
    ) {
      yield* Effect.annotateCurrentSpan({ attemptId });
      yield* connections.forget(attemptId).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Could not remove a finished attempt connection", {
            attemptId,
            message: error.message,
          }),
        ),
        Effect.ignore,
      );
    });
    const provisioned = yield* provisionedMachinesFor({
      instance: options.instance,
      commands,
      workerFor,
      attemptEntry,
      forgetConnection,
      entries,
      machineAt,
      verifyMachine,
      prepareContainers: (machine) => containers.isolation(machine).pipe(Effect.asVoid),
      reset: reset.reset,
      verifyGatewayAdmin,
      settings: options,
    });

    // Runs for every Worker, because one that moved behind a Gateway can still have tokens from
    // an earlier process. A provisioned Worker's machines are new, so only its Gateway can have
    // leftovers.
    const reclaimMachine = (machine: SshMachine) =>
      Option.isSome(machine.provisioned)
        ? attachments.reclaim(machine)
        : credentials
            .reclaim(machine)
            .pipe(
              Effect.andThen(attachments.reclaim(machine)),
              Effect.andThen(containers.reclaim(machine)),
            );
    const reclaim = (worker: WorkerName) =>
      workerFor(worker).pipe(
        Effect.flatMap((entry) =>
          Option.match(entry.machine, {
            onNone: () => attachments.reclaim(entry),
            onSome: reclaimMachine,
          }),
        ),
        Effect.tapError((error) =>
          Effect.logWarning("Could not reclaim worker resources", {
            worker,
            message: error.message,
          }),
        ),
        Effect.ignore,
      );

    const grantFor = (repository: RepositoryName) =>
      Effect.succeed({
        acquire: (attemptId, worker, permissions, machine, operation, harness) =>
          Effect.gen(function* () {
            yield* reclaimMachine(machine);
            const access = Option.isNone(machine.gateway)
              ? yield* credentials.acquire(
                  attemptId,
                  worker,
                  repository,
                  permissions,
                  machine,
                  operation,
                )
              : yield* attachments.acquire(
                  attemptId,
                  worker,
                  repository,
                  permissions,
                  machine,
                  machine.gateway.value,
                  operation,
                  harness,
                );
            const isolation = yield* containers.isolation(machine);
            const sessionMounts = yield* attemptHomes.mounts(
              machine,
              attemptId,
              harness,
              isolation,
              operation,
            );
            const keyed = yield* withApiKeys(
              catalog,
              commands,
              attemptHomes.hold,
              machine,
              attemptId,
              access,
              operation,
              harness,
            );
            return { ...keyed, writableMounts: [...keyed.writableMounts, ...sessionMounts] };
          }),
      } satisfies RemoteGrant<SshMachine>);

    // Provisioned machines remove their harness homes during reset or machine deletion.
    const sweep = Effect.fn("SshExecutor.sweep")(function* () {
      const machines = (yield* entries).flatMap(({ machine }) => Option.toArray(machine));
      yield* Effect.forEach(machines, (machine) => attemptHomes.sweep(machine), {
        concurrency: "unbounded",
        discard: true,
      });
    });

    const fixedLeftovers = yield* Cache.make({
      capacity: Number.POSITIVE_INFINITY,
      lookup: (machine: SshMachine) =>
        reclaimMachine(machine).pipe(
          Effect.andThen(listMachineLeftovers(commands, machine.address.name, machine)),
          Effect.tapError((error) =>
            Effect.logWarning(
              "Could not list leftover checkouts; this connection is not reconciled until the next start",
              {
                worker: machine.address.name,
                host: machine.shell.destination,
                message: error.message,
              },
            ),
          ),
        ),
    });

    const checkoutStates = new Map<AttemptId, "held" | "removed">();
    const executor = yield* remoteExecutorFor<SshMachine>({
      kind: "ssh",
      spanPrefix: "SshExecutor",
      label: "SSH",
      commands,
      machineFor,
      attemptMachine: (worker, attemptId) =>
        provisioned.attemptMachine(worker, attemptId).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              checkoutStates.set(attemptId, "held");
            }),
          ),
        ),
      leftovers: (attempt) =>
        provisioned.leftovers(attempt).pipe(
          Effect.flatMap((located) =>
            Effect.transposeOption(
              Option.map(located, (leftovers) =>
                Option.isSome(leftovers.machine.provisioned) ||
                checkoutStates.get(attempt.attemptId) === "held"
                  ? reclaimMachine(leftovers.machine).pipe(Effect.as(leftovers))
                  : Cache.get(fixedLeftovers, leftovers.machine),
              ),
            ),
          ),
          Effect.tap((located) =>
            Option.match(located, {
              onNone: () => Effect.void,
              onSome: ({ machine, checkouts }) =>
                checkouts.has(
                  `${machine.workerDirectory}/attempts/${safeSegment(attempt.attemptId)}`,
                )
                  ? connections
                      .resolve(attempt.worker, attempt.attemptId, Effect.succeed(machine.address))
                      .pipe(Effect.asVoid)
                  : Effect.void,
            }),
          ),
        ),
      recovered: (attempt, succeeded) => provisioned.recovered(attempt.attemptId, succeeded),
      checkoutHeld: (attemptId, held) =>
        provisioned.checkoutHeld(attemptId, held).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              checkoutStates.set(attemptId, held ? "held" : "removed");
            }),
          ),
        ),
      released: Effect.fn("SshExecutor.releaseConnection")(function* (
        attemptId: AttemptId,
        machine: SshMachine,
      ) {
        yield* Effect.annotateCurrentSpan({ attemptId, worker: machine.address.name });
        if (checkoutStates.get(attemptId) !== "removed") return;
        checkoutStates.delete(attemptId);
        if (Option.isSome(machine.provisioned)) return;
        if (reset.cleanupSucceeded(machine.shell)) return yield* forgetConnection(attemptId);
        yield* Effect.logInfo("Kept the attempt connection after incomplete resource cleanup", {
          attemptId,
          worker: machine.address.name,
        });
      }),
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
          onSome: (gateway) => gatewayCredentialFor(catalog, gateway, harness),
        }),
      credentialRoute: (machine, harness) => machineCredentialRoute(catalog, machine, harness),
      grantFor,
      readOnlyAccessGap: Option.none(),
      reclaim,
      sweep: sweep(),
      interruptGrace: options.interruptGrace ?? "10 seconds",
    });
    return Context.make(Executor, executor).pipe(
      Context.add(
        SshWorkers,
        SshWorkers.of({
          addWorker: (address) =>
            addWorker(address).pipe(Effect.andThen(provisioned.refresh(address))),
          removeWorker: (worker) =>
            provisioned.retire(worker).pipe(Effect.andThen(workers.removeWorker(worker))),
        }),
      ),
      Context.add(WorkerMachines, provisioned.port),
    );
  });

/**
 * The executor for Linux machines accessed over SSH. Each Attempt's Pi parent is a durable task
 * in this process (`AttemptRuntime`), and each child runs on the machine as one SSH command, in
 * the Attempt's own container if the machine has Docker. Without a Gateway, the Attempt's GitHub
 * token is written next to its checkout (ADR 0011). Behind a Gateway, the machine gets only a
 * caller token for an attachment made through the Gateway's admin API (ADR 0027). A provisioned
 * Worker creates machines at a provider and optionally reuses them between attempts
 * (`WorkerMachines`, #550). `SshWorkers` adds and removes Workers at runtime. Requires Node.
 */
export const layer = (
  options: SshExecutorOptions,
): Layer.Layer<
  Executor | SshWorkers | WorkerMachines,
  never,
  | AttemptRuntime
  | Harnesses
  | CredentialProvider
  | Crypto.Crypto
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
> => Layer.effectContext(makeSshExecutor(options).pipe(Effect.orDie));

export type {
  BoatProvisioner,
  BoxdProvisioner,
  ProvisionerTailnet,
  BoatTailnet,
  HetznerProvisioner,
  ProviderApiKeys,
  SshExecutorOptions,
  SshMachine,
  SshProvisioner,
  SshTailnet,
  SshWorkerAddress,
  SshWorkerContainer,
  SshWorkerGateway,
  SshWorkerMachine,
} from "./model.ts";
export { ATTEMPT_IMAGE } from "./container.ts";
export { type SshWorkerRecords, sshWorkerRecordsFor } from "./worker-records.ts";
export { SshWorkers } from "./workers.ts";
