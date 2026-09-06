import { RepositoryName } from "@usine/core/repository";
import { Schema, type Effect } from "effect";
import type { RunHostCommand } from "../executor.ts";

/** The name of one exe.dev edge-injected integration. */
export const IntegrationName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/u, {
    message: "Expected an exe.dev integration name safe for the lobby command boundary",
  }),
).pipe(Schema.brand("ExeDevIntegrationName"));
export type IntegrationName = typeof IntegrationName.Type;

/**
 * An SSH destination handed to the local `ssh` client as argv, so anything
 * that could read as an option (`-oProxyCommand=...`) is unrepresentable.
 */
export const SshDestination = Schema.String.check(
  Schema.isPattern(/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u, {
    message: "Expected an exe.dev SSH hostname, optionally prefixed by a user",
  }),
).pipe(Schema.brand("ExeDevSshDestination"));
export type SshDestination = typeof SshDestination.Type;

/** An absolute remote home directory that cannot smuggle bytes past shell quoting. */
export const HomePath = Schema.String.check(
  Schema.isPattern(/^\/[^\0\r\n]*$/u, {
    message: "Expected an absolute remote home directory without control bytes",
  }),
).pipe(Schema.brand("ExeDevHomePath"));
export type HomePath = typeof HomePath.Type;

/** One standing exe.dev GitHub integration; only its VM attachment is per Attempt. */
export class GitHubIntegration extends Schema.Class<GitHubIntegration>(
  "@usine/executor/ExeDevGitHubIntegration",
)({
  repository: RepositoryName,
  name: IntegrationName,
}) {}

/** How long an exe.dev Worker's repository credential attachment may remain active, in minutes. */
export const CredentialGrantMinutes = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("ExeDevCredentialGrantMinutes"),
);
export type CredentialGrantMinutes = typeof CredentialGrantMinutes.Type;

/** Repository access and run-host settings for the configured exe.dev Workers. */
export interface ExeDevExecutorOptions {
  /** Existing native GitHub integrations, one per repository this Worker may receive. */
  readonly githubIntegrations: ReadonlyArray<GitHubIntegration>;
  /** Installed in the baked image; defaults to the published worker executable. */
  readonly runHost?: RunHostCommand;
  /** Local SSH executable and its control-plane-only arguments. */
  readonly ssh?: RunHostCommand;
  /** Time-box for the edge credential attachment. Defaults to 65 minutes. */
  readonly credentialGrantMinutes?: CredentialGrantMinutes;
  /** Grace for delivering a stop request, then for the run host to exit; each wait is bounded separately. Defaults to 10 seconds. */
  readonly interruptGrace?: Parameters<typeof Effect.timeoutOption>[1];
}

export interface VmState {
  readonly home: HomePath;
  readonly sshDest: SshDestination;
}
