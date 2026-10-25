import type { SshCommand } from "@usine/agents/child-host";
import type {
  ContainerCpus,
  ContainerImage,
  ContainerMemoryMib,
  ContainerPids,
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

/** The Gateway in front of an SSH Worker's machine on a private network (ADR 0027). */
export interface SshWorkerGateway {
  /** The Gateway's private DNS domain. GitHub is at `git.<domain>`, LLM providers at `llm.<domain>`, and the forward proxy at `<domain>:3128`. */
  readonly domain: GatewayDomain;
  /** The `ssh` destination for the Gateway: `user@host` or a Host alias. The admin API forward connects through it. */
  readonly destination: SshDestination;
  /** The admin API port on the Gateway's loopback interface. */
  readonly adminPort: GatewayAdminPort;
  /** The admin API bearer token. */
  readonly adminToken: Redacted.Redacted<string>;
  /** The LLM providers the Gateway has credentials for. A harness whose provider isn't listed uses its own login through the forward proxy. */
  readonly llmProviders: ReadonlyArray<GatewayLlmProvider>;
}

/** The container of each Attempt on an SSH Worker whose machine has Docker. */
export interface SshWorkerContainer {
  /** The image to run. If `None`, `ATTEMPT_IMAGE`. */
  readonly image: Option.Option<ContainerImage>;
  readonly cpus: ContainerCpus;
  readonly memoryMib: ContainerMemoryMib;
  /** The maximum number of processes and threads. */
  readonly pids: ContainerPids;
}

export interface SshWorkerAddress {
  /**
   * The Worker's name in `usine.yaml`; its state is in `workers/<name>` under `root`. A request
   * for a Worker without an address fails with a `machine` capability error.
   */
  readonly name: WorkerName;
  /** The `ssh` destination: `user@host` or a Host alias. */
  readonly destination: SshDestination;
  /** The private key for authentication. If `None`, the SSH agent and configuration are used. */
  readonly identityFile: Option.Option<SshIdentityFile>;
  /** The SSH server port. If `None`, the SSH configuration's port is used. */
  readonly port: Option.Option<SshPort>;
  /** The machine directory that contains `workers/<name>`. */
  readonly root: WorkerRoot;
  /** The Gateway in front of the machine. If `None`, each Attempt's token is written on the machine (ADR 0026). */
  readonly gateway: Option.Option<SshWorkerGateway>;
  /** Each Attempt's container. Used only if the machine has Docker. */
  readonly container: SshWorkerContainer;
}

export interface SshExecutorOptions {
  readonly workers: ReadonlyArray<SshWorkerAddress>;
  /**
   * The identity of this usine instance on the Workers' machines. It labels each Attempt
   * container, so that a later process removes only this instance's containers.
   */
  readonly instance: string;
  /** The local SSH command and the options placed before each Worker's port and identity file. Defaults to `ssh` in batch mode with keepalives. */
  readonly ssh?: SshCommand;
  /** The timeout for the parent task's cancellation, then separately for the Attempt to finish. Defaults to 10 seconds. */
  readonly interruptGrace?: Parameters<typeof Effect.timeoutOption>[1];
  /** Probes a brain's binary and login on a Worker's machine. Defaults to the `@usine/agents/preflight` checks over SSH, which send no prompt. Behind a Gateway, the Gateway checks also apply. */
  readonly harnessReadiness?: (machine: SshMachine) => HarnessProbe;
}

export interface MachineGateway {
  readonly settings: SshWorkerGateway;
  readonly forward: GatewayForward;
  readonly admin: GatewayAdmin;
  /**
   * The Anthropic credential kind the Gateway uses for Claude Code, from the last preflight.
   * `None` before the first preflight, if `llmProviders` doesn't include `anthropic`, or if the
   * Gateway is too old to report it.
   */
  readonly anthropicCredential: Ref.Ref<Option.Option<GatewayCredentialKind>>;
  /** Whether a preflight already warned that the Gateway is too old to report its Anthropic credential kind. */
  readonly warnedOfUnreportedCredential: Ref.Ref<boolean>;
}

export interface SshMachine extends RemoteMachine {
  /** The Worker's address from `usine.yaml`; preflight checks its root. */
  readonly address: SshWorkerAddress;
  readonly gateway: Option.Option<MachineGateway>;
}
