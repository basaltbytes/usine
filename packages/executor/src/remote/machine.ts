import type { RemoteShell } from "@usine/agents/child-host";
import type { BrainSpec } from "@usine/core/agent/brain";
import type { AttemptId } from "@usine/core/attempt";
import type { RepositoryName } from "@usine/core/repository";
import type { WorkerKind, WorkerName } from "@usine/core/worker";
import type { Effect, Scope } from "effect";
import type { CredentialUnavailableError, ExecutorError, ExecutorOperation } from "../executor.ts";
import type { HarnessProbe } from "../harness-preflight.ts";
import type { RemoteCommands } from "./commands.ts";

/** A Worker's machine and how the remote executor connects to it. */
export interface RemoteMachine {
  /** The SSH client and destination that every command and child on the machine runs through. */
  readonly shell: RemoteShell;
  /** The Worker's directory on the machine: cached clones under `repos`, checkouts under `attempts`. */
  readonly workerDirectory: string;
}

/** What an Attempt's repository access gives the commands it runs on the machine. */
export interface RemoteAccess {
  /** Exported on top of the machine's own environment for the Attempt's children and harvesting commands. */
  readonly environment: Readonly<Record<string, string>>;
  /** Exported for the executor's own git commands on the Attempt's checkout: clone, fetch, salvage push. */
  readonly gitEnvironment: Readonly<Record<string, string>>;
  /** Renews the credential on the machine when it expires within minutes; runs before each git and harvesting command. */
  readonly refresh: Effect.Effect<void, ExecutorError>;
  /** Removes every credential this process issued for the Attempt from a command's output. */
  readonly scrub: (text: string) => string;
}

/** How a remote Worker gives Attempts access to one repository. */
export interface RemoteGrant<M extends RemoteMachine> {
  /** Gives the Attempt access to its repository on `machine` until the caller's scope closes. */
  readonly acquire: (
    attemptId: AttemptId,
    worker: WorkerName,
    machine: M,
    operation: ExecutorOperation,
  ) => Effect.Effect<RemoteAccess, ExecutorError, Scope.Scope>;
}

/** What a remote Worker kind supplies to the executor that runs its Attempts over SSH. */
export interface RemoteWorker<M extends RemoteMachine> {
  /** The Worker kind the executor reports as `Executor.kind`; the scheduler refuses Workers of any other kind. */
  readonly kind: WorkerKind;
  /** Prefixes the executor's span names, such as `ExeDevExecutor`. */
  readonly spanPrefix: string;
  /** Names the Worker kind in log messages and errors, such as `exe.dev`. */
  readonly label: string;
  /** Runs every command on the Worker's machines over SSH. */
  readonly commands: RemoteCommands;
  /** Resolves the machine a Worker runs on; fails with a typed error when the machine is missing or does not answer. */
  readonly machineFor: (worker: WorkerName) => Effect.Effect<M, ExecutorError>;
  /** Verifies a Worker without changing it, as `Executor.preflight` documents. */
  readonly preflight: (
    worker: WorkerName,
    brains: ReadonlyArray<BrainSpec>,
  ) => Effect.Effect<void, ExecutorError>;
  /** Checks one brain where the machine runs the Attempt's children. */
  readonly harnessProbe: (machine: M) => HarnessProbe;
  /** The URL the Worker's cached clone fetches `repository` from. */
  readonly repositoryUrl: (repository: RepositoryName) => string;
  /** Finds how the Worker gets access to `repository`; fails when no access is configured for it. */
  readonly grantFor: (
    repository: RepositoryName,
  ) => Effect.Effect<RemoteGrant<M>, CredentialUnavailableError>;
  /** Removes what earlier processes left on the machine that no Attempt can still use; runs before its checkouts are listed. */
  readonly reclaim: (worker: WorkerName, machine: M) => Effect.Effect<void>;
  /** Grace for the parent task's cancellation, then for the Attempt to settle. */
  readonly interruptGrace: Parameters<typeof Effect.timeoutOption>[1];
}
