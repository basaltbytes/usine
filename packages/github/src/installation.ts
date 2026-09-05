import { RepositoryName } from "@usine/core/repository";
import { Schema } from "effect";

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** The numeric identity of an installation of the factory's GitHub App. */
export const InstallationId = PositiveInt.pipe(Schema.brand("GitHubInstallationId"));
export type InstallationId = typeof InstallationId.Type;

/** GitHub's numeric repository identity, used to restrict installation tokens. */
export const RepositoryId = PositiveInt.pipe(Schema.brand("GitHubRepositoryId"));
export type RepositoryId = typeof RepositoryId.Type;

/** The discovered App installation and the account that owns it. */
export class Installation extends Schema.Class<Installation>("@usine/github/Installation")({
  id: InstallationId,
  accountLogin: Schema.NonEmptyString,
}) {}

/** Token access to every repository covered by the installation. */
export class InstallationWide extends Schema.TaggedClass<InstallationWide>(
  "@usine/github/TokenScope/InstallationWide",
)("InstallationWide", {}) {}

/** Token access restricted to the repository assigned to one Attempt. */
export class SingleRepository extends Schema.TaggedClass<SingleRepository>(
  "@usine/github/TokenScope/SingleRepository",
)("SingleRepository", {
  repository: RepositoryName,
  repositoryId: RepositoryId,
}) {}

/** The repository coverage requested when minting an installation token. */
export const TokenScope = Schema.Union([InstallationWide, SingleRepository]);
export type TokenScope = typeof TokenScope.Type;

/** A redacted installation credential with its expiry and permitted repository scope. */
export class InstallationToken extends Schema.Class<InstallationToken>(
  "@usine/github/InstallationToken",
)({
  value: Schema.Redacted(Schema.NonEmptyString, { disallowJsonEncode: true }),
  expiresAt: Schema.DateTimeUtc,
  scope: TokenScope,
}) {}

/** Why App installation discovery could not select one usable installation. */
export const InstallationDiscoveryReason = Schema.Literals(["missing", "multiple", "suspended"]);
export type InstallationDiscoveryReason = typeof InstallationDiscoveryReason.Type;

/** The App has no unambiguous active installation to use for repository access. */
export class InstallationDiscoveryError extends Schema.TaggedError<InstallationDiscoveryError>(
  "@usine/github/InstallationDiscoveryError",
)("InstallationDiscoveryError", {
  reason: InstallationDiscoveryReason,
  message: Schema.NonEmptyString,
}) {}
