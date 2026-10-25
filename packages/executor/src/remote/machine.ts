import type { RemoteShell } from "@usine/agents/child-host";
import type { BrainSpec, Harness } from "@usine/core/agent/brain";
import type { AttemptId } from "@usine/core/attempt";
import type { LoopPermissions } from "@usine/core/loop";
import type { RepositoryName } from "@usine/core/repository";
import type { GatewayCredentialKind, WorkerKind, WorkerName } from "@usine/core/worker";
import type { Effect, Option, Redacted, Scope } from "effect";
import type {
  CredentialUnavailableError,
  ExecutorError,
  ExecutorOperation,
  PreflightReport,
} from "../executor.ts";
import type { HarnessProbe } from "../harness-preflight.ts";
import type { RemoteCommands } from "./commands.ts";
import type { AttemptIsolation } from "./container.ts";

export interface RemoteMachine {
  readonly shell: RemoteShell;
  /** The Worker directory on the machine, with cached clones under `repos` and checkouts under `attempts`. */
  readonly workerDirectory: string;
}

export interface RemoteAccess {
  /**
   * The shell for the Attempt's children, harvesting, and git commands: the machine's own, or one
   * that sends `secrets` through the SSH connection (`sendingShell`). An Attempt container gets
   * `secrets` when it starts instead.
   */
  readonly shell: RemoteShell;
  /** The variables with the Attempt's secrets, which never appear in a command line. */
  readonly secrets: Readonly<Record<string, Redacted.Redacted<string>>>;
  /** The machine directories that the Attempt's container mounts read-only, such as its credential directory. */
  readonly readOnlyPaths: ReadonlyArray<string>;
  /** The extra environment for the Attempt's children and harvesting commands. Values appear in the command line, so none can be secret. */
  readonly environment: Readonly<Record<string, string>>;
  /** The extra environment for the executor's git commands on the checkout. Values appear in the command line, so none can be secret. */
  readonly gitEnvironment: Readonly<Record<string, string>>;
  /** Renews the credential on the machine if it's about to expire. Run before each git and harvesting command. */
  readonly refresh: Effect.Effect<void, ExecutorError>;
  /** Removes every credential this process issued for the Attempt from a command's output. */
  readonly scrub: (text: string) => string;
}

export interface RemoteGrant<M extends RemoteMachine> {
  /**
   * Grants the Attempt access to its repository on `machine` until the caller's scope closes,
   * restricted to its Loop `permissions` if the Worker kind supports it.
   */
  readonly acquire: (
    attemptId: AttemptId,
    worker: WorkerName,
    permissions: LoopPermissions,
    machine: M,
    operation: ExecutorOperation,
  ) => Effect.Effect<RemoteAccess, ExecutorError, Scope.Scope>;
}

/** The Worker-kind implementation for the remote executor. */
export interface RemoteWorker<M extends RemoteMachine> {
  /** Reported as `Executor.kind`; the scheduler rejects Workers of other kinds. */
  readonly kind: WorkerKind;
  /** The span name prefix, for example `ExeDevExecutor`. */
  readonly spanPrefix: string;
  readonly label: string;
  readonly commands: RemoteCommands;
  /** Returns a Worker's machine. Fails with a typed error if the machine is missing or doesn't respond. */
  readonly machineFor: (worker: WorkerName) => Effect.Effect<M, ExecutorError>;
  /** See `Executor.preflight`. */
  readonly preflight: (
    worker: WorkerName,
    brains: ReadonlyArray<BrainSpec>,
    maxConcurrentAttempts: number,
  ) => Effect.Effect<PreflightReport, ExecutorError>;
  /** Returns the probe of a brain's binary and login through `shell`, on `machine` or in a container on it. */
  readonly harnessProbe: (machine: M, shell: RemoteShell) => HarnessProbe;
  /** Returns how new Attempts on `machine` run, as the Worker's last preflight found. */
  readonly isolation: (machine: M) => Effect.Effect<AttemptIsolation, ExecutorError>;
  /** Returns the URL the cached clone on `machine` fetches `repository` from. */
  readonly repositoryUrl: (machine: M, repository: RepositoryName) => string;
  /** Returns the credential kind that the Gateway on `machine` injects for `harness`. Returns `None` if the machine has no Gateway or the harness uses its own login. */
  readonly gatewayCredential: (
    machine: M,
    harness: Harness,
  ) => Effect.Effect<Option.Option<GatewayCredentialKind>>;
  /** Returns the access grant for `repository`. Fails if none is configured. */
  readonly grantFor: (
    repository: RepositoryName,
  ) => Effect.Effect<RemoteGrant<M>, CredentialUnavailableError>;
  /** The reason this Worker kind can't grant read-only repository access, or `None` if it can. */
  readonly readOnlyAccessGap: Option.Option<string>;
  /** Removes leftovers of earlier processes that no Attempt can use. Runs before the Worker's checkouts are listed. */
  readonly reclaim: (worker: WorkerName) => Effect.Effect<void>;
  /** The timeout for the parent task's cancellation, then separately for the Attempt to finish. */
  readonly interruptGrace: Parameters<typeof Effect.timeoutOption>[1];
}
