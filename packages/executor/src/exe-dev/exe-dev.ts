import { RepositoryName, safeSegment } from "@usine/core/repository";
import type { WorkerName } from "@usine/core/worker";
import type { AttemptRuntime } from "@usine/durable/attempt-runtime";
import { Effect, Layer, Option } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { CredentialUnavailableError, Executor } from "../executor.ts";
import type { RemoteAccess, RemoteGrant, RemoteMachine } from "../remote/machine.ts";
import { remoteExecutorFor } from "../remote/remote.ts";
import { commandsFor } from "./commands.ts";
import { credentialGrantsFor } from "./grants.ts";
import type { ExeDevExecutorOptions } from "./model.ts";
import { preflightFor } from "./preflight.ts";

/** exe.dev injects the GitHub credential for requests to this host at its edge. */
const EDGE_GITHUB_HOST = "github.int.exe.xyz";

/**
 * What every child and harvesting command exports on the VM. Nothing secret
 * passes through this process: the VM's own environment and exe.dev's edge
 * supply the credential (ADR 0011), so there is nothing to scrub either.
 */
const edgeAccess = (machine: RemoteMachine): RemoteAccess => ({
  shell: machine.shell,
  environment: { GH_HOST: EDGE_GITHUB_HOST },
  gitEnvironment: {},
  refresh: Effect.void,
  scrub: (text) => text,
});

const makeExeDevExecutor = (options: ExeDevExecutorOptions) =>
  Effect.gen(function* () {
    const commands = yield* commandsFor(options.ssh);
    const integrations = new Map(
      options.githubIntegrations.map(({ name, repository }) => [repository, name]),
    );
    const integrationNames = new Set(options.githubIntegrations.map(({ name }) => name));

    if (integrations.size !== options.githubIntegrations.length) {
      return yield* Effect.die(
        new Error("ExeDevExecutorOptions.githubIntegrations contains duplicate repositories"),
      );
    }
    if (integrationNames.size !== options.githubIntegrations.length) {
      return yield* Effect.die(
        new Error("ExeDevExecutorOptions.githubIntegrations contains duplicate integration names"),
      );
    }

    const machines = yield* preflightFor(options, commands);
    const credentialGrants = yield* credentialGrantsFor(options, commands);

    const machineFor = Effect.fn("ExeDevExecutor.machineFor")(function* (worker: WorkerName) {
      const vm = yield* machines.vmFor(worker);
      return {
        shell: commands.childHost(vm.sshDest),
        workerDirectory: `${vm.home}/.usine/workers/${safeSegment(worker)}`,
      } satisfies RemoteMachine;
    });

    const grantFor = Effect.fn("ExeDevExecutor.grantFor")(function* (repository: RepositoryName) {
      const integration = integrations.get(repository);
      if (integration === undefined)
        return yield* new CredentialUnavailableError({
          repository,
          message: `No exe.dev GitHub integration is configured for ${repository}`,
          cause: new Error("repository integration missing"),
        });
      return {
        acquire: (attemptId, worker, _permissions, machine) =>
          credentialGrants
            .acquire(attemptId, worker, repository, integration)
            .pipe(Effect.as(edgeAccess(machine))),
      } satisfies RemoteGrant<RemoteMachine>;
    });

    return yield* remoteExecutorFor<RemoteMachine>({
      kind: "exe.dev",
      spanPrefix: "ExeDevExecutor",
      label: "exe.dev",
      commands: commands.shared,
      machineFor,
      preflight: machines.preflight,
      harnessProbe: (machine) => machines.harnessProbe(machine.shell),
      repositoryUrl: (_machine, repository) => `https://${EDGE_GITHUB_HOST}/${repository}.git`,
      grantFor,
      readOnlyAccessGap: Option.some(
        "exe.dev's GitHub integration grants the access of exe.dev's own GitHub App and cannot narrow it to read-only",
      ),
      reclaim: () => Effect.void,
      // The grace covers an SSH round trip plus the agent flushing its final
      // events, not just a local pipe.
      interruptGrace: options.interruptGrace ?? "10 seconds",
    });
  });

/**
 * Runs Attempts on exe.dev Workers: each Attempt's Pi parent is a durable task
 * in this process (`AttemptRuntime`), and its children run on the Worker's VM
 * over SSH. An orchestrator restart reattaches a live Attempt to its VM
 * checkout. Requires Node; worker contracts are platform-free.
 */
export const layer = (
  options: ExeDevExecutorOptions,
): Layer.Layer<Executor, never, AttemptRuntime | ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(Executor, makeExeDevExecutor(options));

export {
  CredentialGrantMinutes,
  type ExeDevExecutorOptions,
  GitHubIntegration,
  IntegrationName,
} from "./model.ts";
