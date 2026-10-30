import { LoopPermissions } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { Schema } from "effect";

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** The ID of an installation of the instance's GitHub App. */
export const InstallationId = PositiveInt.pipe(Schema.brand("GitHubInstallationId"));
export type InstallationId = typeof InstallationId.Type;

/** GitHub's numeric repository ID, used to restrict installation tokens. */
export const RepositoryId = PositiveInt.pipe(Schema.brand("GitHubRepositoryId"));
export type RepositoryId = typeof RepositoryId.Type;

/**
 * The App's URL name. GitHub's GraphQL API reports the App's own changes with a `Bot` actor
 * whose login is this slug; the REST login adds `[bot]`.
 */
export const AppSlug = Schema.NonEmptyString.pipe(Schema.brand("GitHubAppSlug"));
export type AppSlug = typeof AppSlug.Type;

/** The App installation, its owner account, and the App's slug. */
export class Installation extends Schema.Class<Installation>("@usine/github/Installation")({
  /** The installation ID used when minting installation tokens. */
  id: InstallationId,
  /** The GitHub user or organization account that owns the installation. */
  accountLogin: Schema.NonEmptyString,
  /** The App URL slug; append `[bot]` to obtain its REST bot login. */
  appSlug: AppSlug,
}) {}

/** A token scope that covers every repository of the installation. */
export class InstallationWide extends Schema.TaggedClass<InstallationWide>(
  "@usine/github/TokenScope/InstallationWide",
)("InstallationWide", {}) {}

/** A token scope restricted to one attempt's repository, at the loop's permission level (`WORKER_TOKEN_PERMISSIONS`). */
export class SingleRepository extends Schema.TaggedClass<SingleRepository>(
  "@usine/github/TokenScope/SingleRepository",
)("SingleRepository", {
  /** The owner/name of the attempt repository. */
  repository: RepositoryName,
  /** The numeric ID that GitHub must confirm as the token's only repository. */
  repositoryId: RepositoryId,
  /** The loop permission level used to select `WORKER_TOKEN_PERMISSIONS` (ADR 0011). */
  permissions: LoopPermissions,
}) {}

/** The repository scope requested when minting an installation token. */
export const TokenScope = Schema.Union([InstallationWide, SingleRepository]);
export type TokenScope = typeof TokenScope.Type;

/** A redacted installation token with its expiry and repository scope. */
export class InstallationToken extends Schema.Class<InstallationToken>(
  "@usine/github/InstallationToken",
)({
  /** The bearer token, redacted in diagnostics and excluded from JSON encoding. */
  value: Schema.Redacted(Schema.NonEmptyString, { disallowJsonEncode: true }),
  /** The UTC lease expiry, capped at one hour after minting even when GitHub reports clock skew. */
  expiresAt: Schema.DateTimeUtc,
  /** The repository scope requested when minting this token. */
  scope: TokenScope,
}) {}

/** The reason installation discovery couldn't select one usable installation. */
export const InstallationDiscoveryReason = Schema.Literals(["missing", "multiple", "suspended"]);
export type InstallationDiscoveryReason = typeof InstallationDiscoveryReason.Type;

/** The error when the App has no single active installation. */
export class InstallationDiscoveryError extends Schema.TaggedError<InstallationDiscoveryError>(
  "@usine/github/InstallationDiscoveryError",
)("InstallationDiscoveryError", {
  /** Whether the App has no installation, multiple installations, or a suspended installation. */
  reason: InstallationDiscoveryReason,
  /** An operator-facing explanation of the installation change required. */
  message: Schema.NonEmptyString,
}) {}
