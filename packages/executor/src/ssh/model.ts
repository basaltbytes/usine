import type { SshCommand } from "@usine/agents/child-host";
import type {
  GatewayAdminPort,
  GatewayCredentialKind,
  GatewayDomain,
  GatewayLlmProvider,
  SshDestination,
  SshIdentityFile,
  SshPort,
  WorkerName,
  WorkerRoot,
} from "@usine/core/worker";
import type { Effect, Option, Redacted, Ref } from "effect";
import type { HarnessProbe } from "../harness-preflight.ts";
import type { RemoteMachine } from "../remote/machine.ts";
import type { GatewayAdmin } from "./gateway/admin.ts";
import type { GatewayForward } from "./gateway/forward.ts";

/**
 * The Gateway in front of an SSH Worker's machine on a private network
 * (ADR 0027): the executor attaches each Attempt's token to it, and the
 * Attempt's children reach GitHub and the listed LLM providers through it.
 */
export interface SshWorkerGateway {
  /** The Gateway's private DNS domain: GitHub at `git.<domain>`, LLM providers at `llm.<domain>`, the forward proxy at `<domain>:3128`. */
  readonly domain: GatewayDomain;
  /** What the local `ssh` client connects to for the Gateway: `user@host`, or a Host alias from the SSH configuration. The executor keeps its own forward to the admin API open through it. */
  readonly destination: SshDestination;
  /** The admin API's port on the Gateway's loopback interface. */
  readonly adminPort: GatewayAdminPort;
  /** The admin API's bearer token. */
  readonly adminToken: Redacted.Redacted<string>;
  /** The LLM providers whose credential the Gateway holds. A harness whose provider is not listed uses its login on the machine and reaches the provider through the forward proxy. */
  readonly llmProviders: ReadonlyArray<GatewayLlmProvider>;
}

/** How the orchestrator connects to one SSH Worker's machine, and where the Worker keeps its state there. */
export interface SshWorkerAddress {
  /**
   * The Worker's name in `usine.yaml`. Requests and preflight name the Worker by
   * it, and its state lives in `workers/<name>` under `root`. A request for a
   * Worker without an address fails with a `machine` capability error.
   */
  readonly name: WorkerName;
  /** What the local `ssh` client connects to: `user@host`, or a Host alias from the SSH configuration. */
  readonly destination: SshDestination;
  /** The private key the client authenticates with; the SSH agent and configuration decide when absent. */
  readonly identityFile: Option.Option<SshIdentityFile>;
  /** The SSH server's port; the SSH configuration decides when absent. */
  readonly port: Option.Option<SshPort>;
  /** The directory under which the Worker keeps `workers/<name>` on the machine. */
  readonly root: WorkerRoot;
  /** The Gateway in front of the machine; without one, each Attempt's token is written on the machine (ADR 0026). */
  readonly gateway: Option.Option<SshWorkerGateway>;
}

/** The machines and SSH settings for the configured SSH Workers. */
export interface SshExecutorOptions {
  /** Every SSH Worker this executor runs Attempts on, each with its own machine. */
  readonly workers: ReadonlyArray<SshWorkerAddress>;
  /** Local SSH executable and the options placed before each Worker's port and identity file; defaults to `ssh` in batch mode with keepalives. */
  readonly ssh?: SshCommand;
  /** Grace for the parent task's cancellation, then for the Attempt to settle; each wait is bounded separately. Defaults to 10 seconds. */
  readonly interruptGrace?: Parameters<typeof Effect.timeoutOption>[1];
  /** Probes one rostered brain's binary and login on a Worker's machine; defaults to the `@usine/agents/preflight` checks over SSH, which start no prompt. Behind a Gateway, the Gateway's checks for the brain still apply. */
  readonly harnessReadiness?: (machine: SshMachine) => HarnessProbe;
}

/** A Gateway in front of a machine, with the executor's forward to its admin API and the client that attaches through it. */
export interface MachineGateway {
  readonly settings: SshWorkerGateway;
  readonly forward: GatewayForward;
  readonly admin: GatewayAdmin;
  /**
   * The kind of Anthropic credential the Gateway pays Claude Code's requests
   * with, as the Worker's last preflight read it from the admin API. None
   * before the first preflight, when the Worker's `llmProviders` does not
   * list `anthropic`, and when the Gateway is too old to report it.
   */
  readonly anthropicCredential: Ref.Ref<Option.Option<GatewayCredentialKind>>;
  /**
   * Whether a preflight of this Worker has already warned that the Gateway
   * is too old to report the kind of its Anthropic credential. The warning
   * is logged once per Worker; later preflights still read the kind, so an
   * upgraded Gateway's kind is recorded at the next one.
   */
  readonly warnedOfUnreportedCredential: Ref.Ref<boolean>;
}

/** An SSH Worker's machine with the child host that every command and child on it runs through. */
export interface SshMachine extends RemoteMachine {
  /** The Worker's address in `usine.yaml`, for preflight to check its root. */
  readonly address: SshWorkerAddress;
  /** The Gateway in front of the machine, when the Worker has one. */
  readonly gateway: Option.Option<MachineGateway>;
}
