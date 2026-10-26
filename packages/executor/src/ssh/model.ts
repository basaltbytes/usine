import type { SshCommand } from "@usine/agents/child-host";
import type {
  BoatSize,
  ContainerCpus,
  ContainerImage,
  ContainerMemoryMib,
  ContainerPids,
  GatewayAdminPort,
  GatewayCredentialKind,
  GatewayDomain,
  GatewayLlmProvider,
  HetznerImage,
  HetznerLabels,
  HetznerLocation,
  HetznerResourceName,
  HetznerServerType,
  MachineProvider,
  SshDestination,
  SshIdentityFile,
  SshPort,
  SshUser,
  WorkerName,
  WorkerRoot,
} from "@usine/core/worker";
import type { Duration, Effect, Option, Redacted, Ref } from "effect";
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

/**
 * The container of each Attempt on an SSH Worker whose machine has Docker. Each limit that is
 * `None` is derived from the machine at preflight: its total less a reserve for the machine's own
 * processes, divided by the Attempts that run on it at once.
 */
export interface SshWorkerContainer {
  /** The image to run. If `None`, `ATTEMPT_IMAGE`. */
  readonly image: Option.Option<ContainerImage>;
  readonly cpus: Option.Option<ContainerCpus>;
  readonly memoryMib: Option.Option<ContainerMemoryMib>;
  /** The maximum number of processes and threads. */
  readonly pids: Option.Option<ContainerPids>;
}

/** The LLM provider API keys that each Attempt on a provisioned Worker gets in its environment. */
export interface ProviderApiKeys {
  /** Claude Code's `ANTHROPIC_API_KEY`. */
  readonly anthropic: Option.Option<Redacted.Redacted<string>>;
  /** Codex's `OPENAI_API_KEY`. */
  readonly openai: Option.Option<Redacted.Redacted<string>>;
}

/** Creates each Attempt's machine as a Hetzner Cloud server from a snapshot. */
export interface HetznerProvisioner {
  readonly provider: "hetzner";
  /** The Hetzner Cloud API token, with read and write access to the project. */
  readonly token: Redacted.Redacted<string>;
  readonly serverType: HetznerServerType;
  readonly location: HetznerLocation;
  /** A snapshot's ID or description, or a system image's name. */
  readonly image: HetznerImage;
  /** The private network to attach each server to. Behind a Gateway, each server gets no public address. */
  readonly network: Option.Option<HetznerResourceName>;
  /** The project's firewall to apply to each server. */
  readonly firewall: Option.Option<HetznerResourceName>;
  /** The project's SSH key that each server authorizes. */
  readonly sshKey: HetznerResourceName;
  readonly sshUser: SshUser;
  readonly labels: HetznerLabels;
  readonly apiKeys: ProviderApiKeys;
}

/** Creates each Attempt's machine as a Boat sandbox. */
export interface BoatProvisioner {
  readonly provider: "boat";
  /** The Boat API key. */
  readonly token: Redacted.Redacted<string>;
  readonly size: BoatSize;
  readonly apiKeys: ProviderApiKeys;
}

export type SshProvisioner = HetznerProvisioner | BoatProvisioner;

/** How the executor finds a Worker's machines: one long-lived machine, or one per Attempt. */
export type SshWorkerMachine =
  | {
      readonly _tag: "Fixed";
      /** The `ssh` destination: `user@host` or a Host alias. */
      readonly destination: SshDestination;
    }
  | { readonly _tag: "Provisioned"; readonly provisioner: SshProvisioner };

export interface SshWorkerAddress {
  /**
   * The Worker's name in `usine.yaml`; its state is in `workers/<name>` under `root`. A request
   * for a Worker without an address fails with a `machine` capability error.
   */
  readonly name: WorkerName;
  readonly machine: SshWorkerMachine;
  /** The private key for authentication. If `None`, the SSH agent and configuration are used. */
  readonly identityFile: Option.Option<SshIdentityFile>;
  /** The SSH server port. If `None`, the SSH configuration's port, or a provisioned machine's, is used. */
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
  /**
   * The local directory for the host keys of provisioned machines, one file per machine, which
   * the executor creates. Defaults to a temporary directory removed with the executor.
   */
  readonly knownHostsDirectory?: string;
  /**
   * The local directory where the executor records how to reach each long-lived Worker's machine
   * when it adds the Worker, which `sshWorkerRecordsFor` reads. Defaults to a temporary
   * directory removed with the executor.
   */
  readonly workerRecordsDirectory?: string;
  /** The provider API endpoints, which tests replace. Defaults to the providers' own. */
  readonly providerEndpoints?: Partial<Record<MachineProvider, string>>;
  /** The longest wait for a created machine to answer over SSH. Defaults to 10 minutes. */
  readonly machineReadyTimeout?: Duration.Input;
  /** The pause between checks of a machine being created. Defaults to 3 seconds. */
  readonly machinePollInterval?: Duration.Input;
}

export interface MachineGateway {
  readonly settings: SshWorkerGateway;
  readonly forward: GatewayForward;
  readonly admin: GatewayAdmin;
  /**
   * The credential kind the Gateway uses for each provider, from the last preflight: Anthropic
   * for Claude Code, OpenAI for Codex. `None` before the first preflight, for a provider that
   * `llmProviders` doesn't list, or for Anthropic if the Gateway is too old to report it.
   */
  readonly credentials: Ref.Ref<GatewayCredentials>;
  /** Whether a preflight already warned that the Gateway is too old to report its Anthropic credential kind. */
  readonly warnedOfUnreportedCredential: Ref.Ref<boolean>;
}

/** The credential kind the Gateway holds for each provider; see `MachineGateway.credentials`. */
export type GatewayCredentials = Readonly<
  Record<GatewayLlmProvider, Option.Option<GatewayCredentialKind>>
>;

export interface SshMachine extends RemoteMachine {
  /** The Worker's address from `usine.yaml`; preflight checks its root. */
  readonly address: SshWorkerAddress;
  readonly gateway: Option.Option<MachineGateway>;
}
