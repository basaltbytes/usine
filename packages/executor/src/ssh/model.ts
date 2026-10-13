import type { SshCommand } from "@usine/agents/child-host";
import type {
  SshDestination,
  SshIdentityFile,
  SshPort,
  WorkerName,
  WorkerRoot,
} from "@usine/core/worker";
import type { Effect, Option } from "effect";
import type { HarnessProbe } from "../harness-preflight.ts";
import type { RemoteMachine } from "../remote/machine.ts";

/** How the orchestrator reaches one SSH Worker's machine, and where the Worker keeps its state there. */
export interface SshWorkerAddress {
  readonly name: WorkerName;
  /** What the local `ssh` client connects to: `user@host`, or a Host alias from the SSH configuration. */
  readonly destination: SshDestination;
  /** The private key the client authenticates with; the SSH agent and configuration decide when absent. */
  readonly identityFile: Option.Option<SshIdentityFile>;
  /** The SSH server's port; the SSH configuration decides when absent. */
  readonly port: Option.Option<SshPort>;
  /** The directory under which the Worker keeps `workers/<name>` on the machine. */
  readonly root: WorkerRoot;
}

/** The machines and SSH settings for the configured SSH Workers. */
export interface SshExecutorOptions {
  /** Every SSH Worker this executor runs Attempts on, each with its own machine. */
  readonly workers: ReadonlyArray<SshWorkerAddress>;
  /** Local SSH executable and the options placed before each Worker's port and identity file; defaults to `ssh` in batch mode with keepalives. */
  readonly ssh?: SshCommand;
  /** Grace for the parent task's cancellation, then for the Attempt to settle; each wait is bounded separately. Defaults to 10 seconds. */
  readonly interruptGrace?: Parameters<typeof Effect.timeoutOption>[1];
  /** Probes one rostered brain on a Worker's machine; defaults to the `@usine/agents/preflight` checks over SSH, which start no prompt. */
  readonly harnessReadiness?: (machine: SshMachine) => HarnessProbe;
}

/** An SSH Worker's machine with the child host every command and child reaches it through. */
export interface SshMachine extends RemoteMachine {
  readonly worker: WorkerName;
  readonly address: SshWorkerAddress;
}
