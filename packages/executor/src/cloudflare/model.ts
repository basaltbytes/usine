import type { SshCommand } from "@usine/agents/child-host";
import type {
  CloudflareImageName,
  CloudflareInstanceType,
  CloudflareLlmProvider,
  WorkerName,
} from "@usine/core/worker";
import type { Effect, Redacted } from "effect";

/** A provider API key that the Worker's outbound handler holds for each Attempt. */
export interface CloudflareProviderKey {
  readonly provider: CloudflareLlmProvider;
  readonly apiKey: Redacted.Redacted<string>;
}

/** How the executor reaches one `cloudflare` Worker's deployed Worker and what it runs there. */
export interface CloudflareWorkerAddress {
  readonly name: WorkerName;
  /** The deployed Worker's origin. */
  readonly workerUrl: URL;
  readonly accessClientId: Redacted.Redacted<string>;
  readonly accessClientSecret: Redacted.Redacted<string>;
  readonly image: CloudflareImageName;
  readonly instanceType: CloudflareInstanceType;
  /** At most one key per provider. */
  readonly providers: ReadonlyArray<CloudflareProviderKey>;
}

export interface CloudflareExecutorOptions {
  readonly workers: ReadonlyArray<CloudflareWorkerAddress>;
  /**
   * The local command that runs one command in a sandbox, with the arguments of an SSH client.
   * Defaults to this package's `shell.js` under the running Node.js.
   */
  readonly shell?: SshCommand;
  /** The timeout for the parent task's cancellation, then separately for the Attempt to finish. Defaults to 10 seconds. */
  readonly interruptGrace?: Parameters<typeof Effect.timeoutOption>[1];
}
