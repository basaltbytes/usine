import type { ClaudeLoginLock } from "@usine/agents/runtime";
import { RepositoryName, safeSegment } from "@usine/core/repository";
import type { WorkerName } from "@usine/core/worker";
import type { AttemptRuntime } from "@usine/durable/attempt-runtime";
import { Effect, Layer, Option } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { CredentialUnavailableError, Executor } from "../executor.ts";
import type { RemoteAccess, RemoteGrant, RemoteMachine } from "../remote/machine.ts";
import { sharedUser } from "../remote/container.ts";
import { remoteExecutorFor } from "../remote/remote.ts";
import { commandsFor } from "./commands.ts";
import { credentialGrantsFor } from "./grants.ts";
import type { ExeDevExecutorOptions } from "./model.ts";
import { preflightFor } from "./preflight.ts";

/** The host for which the exe.dev edge injects the GitHub credential. */
const EDGE_GITHUB_HOST = "github.int.exe.xyz";

/**
 * Returns the environment for every child and harvesting command on the VM. It contains no
 * secrets; the exe.dev edge injects the credential (ADR 0011).
 */
const edgeAccess = (machine: RemoteMachine): RemoteAccess => ({
  shell: machine.shell,
  secrets: {},
  readOnlyPaths: [],
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
          reason: "refused",
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
      harnessProbe: (_machine, shell) => machines.harnessProbe(shell),
      // exe.dev runs every Attempt of a Worker on its one VM as the VM's user.
      isolation: () => Effect.succeed(sharedUser),
      repositoryUrl: (_machine, repository) => `https://${EDGE_GITHUB_HOST}/${repository}.git`,
      // exe.dev Workers have no Gateway; every harness uses its own login.
      gatewayCredential: () => Effect.succeedNone,
      grantFor,
      readOnlyAccessGap: Option.some(
        "An exe.dev GitHub integration has the access of exe.dev's GitHub App, which can't be limited to read-only",
      ),
      reclaim: () => Effect.void,
      interruptGrace: options.interruptGrace ?? "10 seconds",
    });
  });

/**
 * The executor for exe.dev Workers. Each Attempt's Pi parent is a durable task in this process
 * (`AttemptRuntime`), and its children run on the Worker's VM over SSH. A live Attempt
 * reattaches to its checkout after an orchestrator restart. Requires Node.
 */
export const layer = (
  options: ExeDevExecutorOptions,
): Layer.Layer<
  Executor,
  never,
  AttemptRuntime | ClaudeLoginLock | ChildProcessSpawner.ChildProcessSpawner
> => Layer.effect(Executor, makeExeDevExecutor(options));

export {
  CredentialGrantMinutes,
  type ExeDevExecutorOptions,
  GitHubIntegration,
  IntegrationName,
} from "./model.ts";
