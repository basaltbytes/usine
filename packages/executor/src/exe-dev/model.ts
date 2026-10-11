import { RepositoryName } from "@usine/core/repository";
import { Schema, type Effect } from "effect";
import type { SshCommand } from "../executor.ts";

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

/** Repository access and SSH settings for the configured exe.dev Workers. */
export interface ExeDevExecutorOptions {
  /** Existing native GitHub integrations, one per repository this Worker may receive. */
  readonly githubIntegrations: ReadonlyArray<GitHubIntegration>;
  /** Local SSH executable and its arguments, used for the lobby, VM commands, and every child. */
  readonly ssh?: SshCommand;
  /** Length of each edge credential attachment, renewed at half this length for as long as the Attempt runs; independent of any Attempt ceiling. Defaults to 65 minutes. */
  readonly credentialGrantMinutes?: CredentialGrantMinutes;
  /** Grace for the parent task's cancellation, then for the Attempt to settle; each wait is bounded separately. Defaults to 10 seconds. */
  readonly interruptGrace?: Parameters<typeof Effect.timeoutOption>[1];
}

export interface VmState {
  readonly home: HomePath;
  readonly sshDest: SshDestination;
}
