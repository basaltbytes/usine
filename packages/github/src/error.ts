import { Match, Option, Schema } from "effect";
import { InstallationDiscoveryError } from "./installation.ts";
import { AppPermissionError } from "./access.ts";

/** The GitHub request that failed, used by API, rate-limit, and response errors. */
export const GitHubOperation = Schema.Literals([
  "create-repository-label",
  "discover-installation",
  "fetch-base-ref-head",
  "fetch-item-labels",
  "fetch-issue-snapshot",
  "fetch-item-timeline",
  "fetch-pull-request-snapshot",
  "find-missing-issues",
  "list-installation-repositories",
  "list-repository-labels",
  "mint-installation-token",
  "mint-worker-token",
  "poll-repository-changes",
  "read-bot-account",
  "update-item-labels",
]);
export type GitHubOperation = typeof GitHubOperation.Type;

/** A failed GitHub request, with the HTTP status if a response was received. */
export class GitHubApiError extends Schema.TaggedError<GitHubApiError>(
  "@usine/github/GitHubApiError",
)("GitHubApiError", {
  operation: GitHubOperation,
  status: Schema.Option(Schema.Int),
  message: Schema.NonEmptyString,
}) {}

/** The error when GitHub defers the request until `retryAt`. */
export class GitHubRateLimitError extends Schema.TaggedError<GitHubRateLimitError>(
  "@usine/github/GitHubRateLimitError",
)("GitHubRateLimitError", {
  operation: GitHubOperation,
  retryAt: Schema.DateTimeUtc,
  message: Schema.NonEmptyString,
}) {}

/** The error when a GitHub response can't be decoded or lacks required content. */
export class InvalidGitHubResponseError extends Schema.TaggedError<InvalidGitHubResponseError>(
  "@usine/github/InvalidGitHubResponseError",
)("InvalidGitHubResponseError", {
  operation: GitHubOperation,
  message: Schema.NonEmptyString,
  /** The decode path, missing field, or GraphQL errors. */
  detail: Schema.NonEmptyString,
}) {}

/**
 * The error when the repository has no Item with this number because it was deleted,
 * transferred, or is no longer readable by the App. The repository itself responded.
 */
export class GitHubItemNotFoundError extends Schema.TaggedError<GitHubItemNotFoundError>(
  "@usine/github/GitHubItemNotFoundError",
)("GitHubItemNotFoundError", {
  operation: GitHubOperation,
  item: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  message: Schema.NonEmptyString,
}) {}

/** The errors from installation discovery or an authenticated GitHub request. */
export const GitHubAppError = Schema.Union([
  InstallationDiscoveryError,
  AppPermissionError,
  GitHubApiError,
  GitHubRateLimitError,
  InvalidGitHubResponseError,
]);
export type GitHubAppError = typeof GitHubAppError.Type;

/**
 * Returns whether GitHub gave a definite response that a retry won't change: no usable
 * installation, a missing permission, or a 4xx status other than 408 and 429 (for example, 422
 * for an ungranted permission or 403 for a suspended installation). Send failures, server
 * errors, rate limits, and responses that break GitHub's API contract aren't refusals.
 */
export const isRefusal = (error: GitHubAppError): boolean =>
  Match.valueTags(error, {
    InstallationDiscoveryError: () => true,
    AppPermissionError: () => true,
    GitHubApiError: ({ status }) =>
      Option.exists(status, (code) => code >= 400 && code < 500 && code !== 408 && code !== 429),
    GitHubRateLimitError: () => false,
    InvalidGitHubResponseError: () => false,
  });
