import { Attempt, Repository } from "@usine/core";
import { Schema, type Effect, type Ref } from "effect";
import type { RunHostCommand } from "../index.ts";

/** The name of one exe.dev edge-injected integration. */
export const IntegrationName = Schema.NonEmptyString.pipe(Schema.brand("ExeDevIntegrationName"));
export type IntegrationName = typeof IntegrationName.Type;

/** One standing exe.dev GitHub integration; only its VM attachment is per Attempt. */
export class GitHubIntegration extends Schema.Class<GitHubIntegration>(
  "@usine/executor/ExeDevGitHubIntegration",
)({
  repository: Repository.Name,
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
  readonly home: string;
  readonly sshDest: string;
}

export interface PreparedState {
  readonly cache: string;
  readonly integration: IntegrationName;
  readonly vm: VmState;
}

export type PreparedStates = Ref.Ref<Map<Attempt.AttemptId, PreparedState>>;
