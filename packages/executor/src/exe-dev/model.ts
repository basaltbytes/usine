import { RepositoryName } from "@usine/core/repository";
import { BotLogin, type SshDestination } from "@usine/core/worker";
import { Schema, type Effect } from "effect";
import type { SshCommand } from "@usine/agents/child-host";

/** The bot used by exe.dev's native GitHub integration (ADR 0011). */
export const EXE_DEV_BOT_LOGIN = BotLogin.make("exe-dev-github-integration[bot]");

export const IntegrationName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/u, {
    message:
      "Expected an exe.dev integration name of letters and digits, separated by single dots, underscores, or hyphens",
  }),
).pipe(Schema.brand("ExeDevIntegrationName"));
export type IntegrationName = typeof IntegrationName.Type;

/** An absolute remote home directory path without NUL, CR, or LF bytes. */
export const HomePath = Schema.String.check(
  Schema.isPattern(/^\/[^\0\r\n]*$/u, {
    message: "Expected an absolute remote home directory without control bytes",
  }),
).pipe(Schema.brand("ExeDevHomePath"));
export type HomePath = typeof HomePath.Type;

/** An existing exe.dev GitHub integration, attached to the Worker's VM per Attempt. */
export class GitHubIntegration extends Schema.Class<GitHubIntegration>(
  "@usine/executor/ExeDevGitHubIntegration",
)({
  /** Must be unique across integrations. */
  repository: RepositoryName,
  /**
   * The integration name on exe.dev, unique in the options. Each Attempt attaches it to the
   * Worker's VM for `credentialGrantMinutes`.
   */
  name: IntegrationName,
}) {}

/** The duration of one credential attachment, in minutes. */
export const CredentialGrantMinutes = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("ExeDevCredentialGrantMinutes"),
);
export type CredentialGrantMinutes = typeof CredentialGrantMinutes.Type;

export interface ExeDevExecutorOptions {
  /** Existing exe.dev GitHub integrations, one per repository. */
  readonly githubIntegrations: ReadonlyArray<GitHubIntegration>;
  /** The local SSH command for lobby, VM, and child commands. */
  readonly ssh?: SshCommand;
  /** The length of each credential attachment, in minutes, renewed at half this length. Defaults to 65. */
  readonly credentialGrantMinutes?: CredentialGrantMinutes;
  /** The timeout for the parent task's cancellation, then separately for the Attempt to finish. Defaults to 10 seconds. */
  readonly interruptGrace?: Parameters<typeof Effect.timeoutOption>[1];
}

export interface VmState {
  readonly home: HomePath;
  readonly sshDest: SshDestination;
}
