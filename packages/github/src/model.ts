import { Repository } from "@usine/core";
import { Context, Schema } from "effect";

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export const AppId = PositiveInt.pipe(Schema.brand("GitHubAppId"));
export type AppId = typeof AppId.Type;

export const InstallationId = PositiveInt.pipe(Schema.brand("GitHubInstallationId"));
export type InstallationId = typeof InstallationId.Type;

export const RepositoryId = PositiveInt.pipe(Schema.brand("GitHubRepositoryId"));
export type RepositoryId = typeof RepositoryId.Type;

export const PrivateKey = Schema.NonEmptyString.check(
  Schema.isPattern(
    /^-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+-----END (?:RSA )?PRIVATE KEY-----\s*$/u,
    { message: "Expected a PEM-encoded RSA private key" },
  ),
).pipe(Schema.brand("GitHubAppPrivateKey"));
export type PrivateKey = typeof PrivateKey.Type;

/** A PEM string parsed straight into a `Redacted` that can never be encoded back out. */
export const RedactedPrivateKey = Schema.RedactedFromValue(PrivateKey, { disallowEncode: true });

export const GitHubOperation = Schema.Literals([
  "discover-installation",
  "fetch-issue-snapshot",
  "fetch-pull-request-snapshot",
  "list-installation-repositories",
  "mint-installation-token",
  "mint-worker-token",
  "poll-repository-changes",
]);
export type GitHubOperation = typeof GitHubOperation.Type;

/** Credentials held by the orchestrator and never passed to a worker. */
export class AppCredentials extends Schema.Class<AppCredentials>("@usine/github/AppCredentials")({
  appId: AppId,
  privateKey: RedactedPrivateKey,
}) {}

/** Service boundary that keeps credential sourcing separate from App use. */
export class GitHubCredentials extends Context.Service<GitHubCredentials, AppCredentials>()(
  "@usine/github/GitHubCredentials",
) {}

export const REQUIRED_REPOSITORY_PERMISSIONS = {
  checks: "read",
  contents: "write",
  issues: "write",
  metadata: "read",
  pull_requests: "write",
} as const;

export type RequiredRepositoryPermission = keyof typeof REQUIRED_REPOSITORY_PERMISSIONS;

const grants = (actual: string | undefined, required: "read" | "write"): boolean =>
  actual === required || (required === "read" && actual === "write");

/** Pure deriver: the required permissions an installation's grant does not satisfy. */
export const missingPermissions = (
  granted: Readonly<Record<string, string>>,
): ReadonlyArray<string> =>
  Object.entries(REQUIRED_REPOSITORY_PERMISSIONS).flatMap(([permission, required]) =>
    grants(granted[permission], required) ? [] : [`${permission}:${required}`],
  );

export class Installation extends Schema.Class<Installation>("@usine/github/Installation")({
  id: InstallationId,
  accountLogin: Schema.NonEmptyString,
}) {}

export class InstallationWide extends Schema.TaggedClass<InstallationWide>(
  "@usine/github/TokenScope/InstallationWide",
)("InstallationWide", {}) {}

export class SingleRepository extends Schema.TaggedClass<SingleRepository>(
  "@usine/github/TokenScope/SingleRepository",
)("SingleRepository", {
  repository: Repository.Name,
  repositoryId: RepositoryId,
}) {}

export const TokenScope = Schema.Union([InstallationWide, SingleRepository]);
export type TokenScope = typeof TokenScope.Type;

export class InstallationToken extends Schema.Class<InstallationToken>(
  "@usine/github/InstallationToken",
)({
  value: Schema.Redacted(Schema.NonEmptyString, { disallowJsonEncode: true }),
  expiresAt: Schema.DateTimeUtc,
  scope: TokenScope,
}) {}

export class CoveredProject extends Schema.TaggedClass<CoveredProject>(
  "@usine/github/ProjectAccess/CoveredProject",
)("CoveredProject", {
  installationId: InstallationId,
  repository: Repository.Name,
  repositoryId: RepositoryId,
}) {}

/** Typed, project-local registry drift. It never fails covered siblings. */
export class ProjectNotInstalledError extends Schema.TaggedError<ProjectNotInstalledError>(
  "@usine/github/ProjectNotInstalledError",
)("ProjectNotInstalledError", {
  repository: Repository.Name,
  message: Schema.NonEmptyString,
}) {}

export const ProjectAccess = Schema.Union([CoveredProject, ProjectNotInstalledError]);
export type ProjectAccess = typeof ProjectAccess.Type;

export interface InstalledRepository {
  readonly id: RepositoryId;
  readonly name: Repository.Name;
}

/** Pure registry⊆installation derivation: one result, and one error, per project. */
export const deriveProjectAccess = (
  installation: Installation,
  registry: ReadonlyArray<Repository.Name>,
  installed: ReadonlyArray<InstalledRepository>,
): ReadonlyArray<ProjectAccess> => {
  const byName = new Map(installed.map((repo) => [repo.name.toLowerCase(), repo]));
  return registry.map((repository) => {
    const match = byName.get(repository.toLowerCase());
    return match === undefined
      ? new ProjectNotInstalledError({
          repository,
          message: `The GitHub App installation does not cover ${repository}`,
        })
      : new CoveredProject({
          installationId: installation.id,
          repository,
          repositoryId: match.id,
        });
  });
};

/** The private key cannot sign: raised once, when the App layer is built. */
export class AppAuthenticationError extends Schema.TaggedError<AppAuthenticationError>(
  "@usine/github/AppAuthenticationError",
)("AppAuthenticationError", {
  message: Schema.NonEmptyString,
}) {}

export const InstallationDiscoveryReason = Schema.Literals(["missing", "multiple", "suspended"]);
export type InstallationDiscoveryReason = typeof InstallationDiscoveryReason.Type;

export class InstallationDiscoveryError extends Schema.TaggedError<InstallationDiscoveryError>(
  "@usine/github/InstallationDiscoveryError",
)("InstallationDiscoveryError", {
  reason: InstallationDiscoveryReason,
  message: Schema.NonEmptyString,
}) {}

export class AppPermissionError extends Schema.TaggedError<AppPermissionError>(
  "@usine/github/AppPermissionError",
)("AppPermissionError", {
  missing: Schema.Array(Schema.NonEmptyString).check(Schema.isNonEmpty()),
  message: Schema.NonEmptyString,
}) {}

export class GitHubApiError extends Schema.TaggedError<GitHubApiError>(
  "@usine/github/GitHubApiError",
)("GitHubApiError", {
  operation: GitHubOperation,
  status: Schema.Option(Schema.Int),
  message: Schema.NonEmptyString,
}) {}

export class GitHubRateLimitError extends Schema.TaggedError<GitHubRateLimitError>(
  "@usine/github/GitHubRateLimitError",
)("GitHubRateLimitError", {
  operation: GitHubOperation,
  retryAt: Schema.DateTimeUtc,
  message: Schema.NonEmptyString,
}) {}

export class InvalidGitHubResponseError extends Schema.TaggedError<InvalidGitHubResponseError>(
  "@usine/github/InvalidGitHubResponseError",
)("InvalidGitHubResponseError", {
  operation: GitHubOperation,
  message: Schema.NonEmptyString,
}) {}

/** Everything one GitHub App call can fail with. */
export const GitHubAppError = Schema.Union([
  InstallationDiscoveryError,
  AppPermissionError,
  GitHubApiError,
  GitHubRateLimitError,
  InvalidGitHubResponseError,
]);
export type GitHubAppError = typeof GitHubAppError.Type;
