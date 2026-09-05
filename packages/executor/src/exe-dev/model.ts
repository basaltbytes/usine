import { AttemptId } from "@usine/core/attempt";
import { RepositoryName } from "@usine/core/repository";
import { Schema, type Effect, type Ref } from "effect";
import type { RunHostCommand } from "../executor.ts";

/** The name of one exe.dev edge-injected integration. */
export const IntegrationName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/u, {
    message: "Expected an exe.dev integration name safe for the lobby command boundary",
  }),
).pipe(Schema.brand("ExeDevIntegrationName"));
export type IntegrationName = typeof IntegrationName.Type;

/**
 * The SSH argv boundary: this string is handed to the local `ssh` client as a
 * destination, so anything that could read as an option (`-oProxyCommand=...`)
 * must be unrepresentable, not merely unexpected.
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

/** A harness-owned command that exits zero only while its operator login remains usable. */
export class HarnessLoginCheck extends Schema.Class<HarnessLoginCheck>(
  "@usine/executor/ExeDevHarnessLoginCheck",
)({
  harness: Schema.NonEmptyString,
  command: Schema.NonEmptyString,
  args: Schema.Array(Schema.String),
}) {}

export const CredentialGrantMinutes = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("ExeDevCredentialGrantMinutes"),
);
export type CredentialGrantMinutes = typeof CredentialGrantMinutes.Type;

export interface ExeDevExecutorOptions {
  /** Existing native GitHub integrations, one per repository this Worker may receive. */
  readonly githubIntegrations: ReadonlyArray<GitHubIntegration>;
  /** Every harness used on this Worker must prove that its operator login is still valid. */
  readonly harnessLoginChecks: readonly [HarnessLoginCheck, ...ReadonlyArray<HarnessLoginCheck>];
  /** Installed in the baked image; defaults to the published worker executable. */
  readonly runHost?: RunHostCommand;
  /** Local SSH executable and its control-plane-only arguments. */
  readonly ssh?: RunHostCommand;
  /** Time-box for the edge credential attachment. Defaults to 65 minutes. */
  readonly credentialGrantMinutes?: CredentialGrantMinutes;
  readonly interruptGrace?: Parameters<typeof Effect.timeoutOption>[1];
}

export interface VmState {
  readonly home: HomePath;
  readonly sshDest: SshDestination;
}

export interface PreparedState {
  readonly cache: string;
  readonly integration: IntegrationName;
  readonly vm: VmState;
}

export type PreparedStates = Ref.Ref<Map<AttemptId, PreparedState>>;
