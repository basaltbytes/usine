import type { RemoteHost } from "@usine/agents/child-host";
import type { CredentialRoute } from "@usine/agents/harness";
import type { BrainSpec, Harness } from "@usine/core/agent/brain";
import type { AttemptId } from "@usine/core/attempt";
import type { AttemptRecovery } from "@usine/core/attempt/salvage";
import type { LoopPermissions } from "@usine/core/loop";
import type { RepositoryName } from "@usine/core/repository";
import type { GatewayCredentialKind, MachineId, WorkerKind, WorkerName } from "@usine/core/worker";
import type { Effect, Option, Redacted, Scope } from "effect";
import type {
  CredentialUnavailableError,
  ExecutorError,
  ExecutorOperation,
  PreflightReport,
} from "../executor.ts";
import type { HarnessProbe } from "../harness-preflight.ts";
import type { RemoteCommands } from "./commands.ts";
import type { AttemptIsolation, WritableMount } from "./container.ts";
import type { ProbeConnection } from "./liveness.ts";

/** A machine with checkouts left for reconciliation. */
interface RemoteLeftovers<M extends RemoteMachine> {
  readonly machine: M;
  /** The paths directly under the Worker's `attempts` directory. */
  readonly checkouts: ReadonlySet<string>;
}

export interface RemoteMachine {
  readonly shell: RemoteHost;
  /** Follows provider endpoint changes and detects machine loss during a liveness probe. */
  readonly probe?: ProbeConnection;
  /** The Worker directory on the machine, with cached clones under `repos` and checkouts under `attempts`. */
  readonly workerDirectory: string;
  /** The provider's ID of a machine created for one Attempt, or `None` for a long-lived machine. */
  readonly provisioned: Option.Option<MachineId>;
}

/** How an Attempt's harness authenticates on a Worker's machine. */
export type MachineCredentialRoute = Extract<CredentialRoute, "host-login" | "gateway" | "api-key">;

export interface RemoteAccess {
  /** The harnesses whose model API keys were installed with this access. */
  readonly apiKeyHarnesses: ReadonlySet<Harness>;
  /**
   * The shell for the Attempt's children, harvesting, and git commands: the machine's own, or one
   * that sends `secrets` through the SSH connection (`sendingShell`). An Attempt container gets
   * `secrets` when it starts instead.
   */
  readonly shell: RemoteHost;
  /** The variables with the Attempt's secrets, which never appear in a command line. */
  readonly secrets: Readonly<Record<string, Redacted.Redacted<string>>>;
  /** The machine directories that the Attempt's container mounts read-only, such as its credential directory. */
  readonly readOnlyPaths: ReadonlyArray<string>;
  /** The machine directories of the Attempt that its container mounts read-write, such as a harness's home. */
  readonly writableMounts: ReadonlyArray<WritableMount>;
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
    harness: Option.Option<Harness>,
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
  /**
   * Returns the machine an Attempt runs on, if the Worker kind creates one per Attempt.
   * Defaults to `machineFor`.
   */
  readonly attemptMachine?: (
    worker: WorkerName,
    attemptId: AttemptId,
  ) => Effect.Effect<M, ExecutorError>;
  /**
   * Returns the machine with `attempt`'s leftover checkout and the paths under its `attempts`
   * directory, or `None` if the Attempt's machine is gone. `listed` is the Worker's machine and
   * its listed checkouts, the default.
   */
  readonly leftovers?: (
    attempt: AttemptRecovery,
    listed: Effect.Effect<RemoteLeftovers<M>, ExecutorError>,
  ) => Effect.Effect<Option.Option<RemoteLeftovers<M>>, ExecutorError>;
  /**
   * Runs after the attempt's scoped cleanup, including container and credential finalizers.
   * `gone` is true after a recovery that returned `gone`: nothing of the Attempt is left on
   * `machine`, and no later recovery visits it.
   */
  readonly released?: (attemptId: AttemptId, machine: M, gone?: boolean) => Effect.Effect<void>;
  /** Runs after `recover` reconciled `attempt`'s machine, with whether it succeeded. */
  readonly recovered?: (attempt: AttemptRecovery, succeeded: boolean) => Effect.Effect<void>;
  /**
   * Records whether the machine of `attemptId` has the Attempt's checkout: from its preparation
   * or a recovery that finds it, until its removal succeeds.
   */
  readonly checkoutHeld?: (attemptId: AttemptId, held: boolean) => Effect.Effect<void>;
  /** See `Executor.preflight`. */
  readonly preflight: (
    worker: WorkerName,
    brains: ReadonlyArray<BrainSpec>,
    maxConcurrentAttempts: number,
  ) => Effect.Effect<PreflightReport, ExecutorError>;
  /** Returns the probe of a brain's binary and login through `shell`, on `machine` or in a container on it. */
  readonly harnessProbe: (machine: M, shell: RemoteHost) => HarnessProbe;
  /** Returns how new Attempts on `machine` run, as the Worker's last preflight found. */
  readonly isolation: (machine: M) => Effect.Effect<AttemptIsolation, ExecutorError>;
  /**
   * Whether the Worker kind runs Attempt containers. If true, each existing checkout's container
   * marker decides how a reattachment or recovery runs commands in it.
   */
  readonly runsContainers: boolean;
  /** Returns the URL the cached clone on `machine` fetches `repository` from. */
  readonly repositoryUrl: (machine: M, repository: RepositoryName) => string;
  /** Returns the credential kind that the Gateway on `machine` injects for `harness`. Returns `None` if the machine has no Gateway or the harness uses its own login. */
  readonly gatewayCredential: (
    machine: M,
    harness: Harness,
  ) => Effect.Effect<Option.Option<GatewayCredentialKind>>;
  /**
   * Returns how each Attempt's `harness` authenticates on `machine`. An Attempt's container
   * mounts the harness's login files from the machine only for `host-login`.
   */
  readonly credentialRoute: (machine: M, harness: Harness) => MachineCredentialRoute;
  /** Returns the access grant for `repository`. Fails if none is configured. */
  readonly grantFor: (
    repository: RepositoryName,
  ) => Effect.Effect<RemoteGrant<M>, CredentialUnavailableError>;
  /** The reason this Worker kind can't grant read-only repository access, or `None` if it can. */
  readonly readOnlyAccessGap: Option.Option<string>;
  /** Removes leftovers of earlier processes that no Attempt can use. Runs before the Worker's checkouts are listed. */
  readonly reclaim: (worker: WorkerName) => Effect.Effect<void>;
  /** See `Executor.sweep`. Defaults to removing nothing. */
  readonly sweep?: Effect.Effect<void>;
  /** The timeout for the parent task's cancellation, then separately for the Attempt to finish. */
  readonly interruptGrace: Parameters<typeof Effect.timeoutOption>[1];
}
