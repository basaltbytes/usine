import { Match, Option, Schema } from "effect";
import { InstallationDiscoveryError } from "./installation.ts";
import { AppPermissionError } from "./access.ts";

/** The GitHub request that failed, shared by API, rate-limit, and response errors. */
export const GitHubOperation = Schema.Literals([
  "create-repository-label",
  "discover-installation",
  "fetch-item-labels",
  "fetch-issue-snapshot",
  "fetch-item-timeline",
  "fetch-pull-request-snapshot",
  "list-installation-repositories",
  "list-repository-labels",
  "mint-installation-token",
  "mint-worker-token",
  "poll-repository-changes",
  "update-item-labels",
]);
export type GitHubOperation = typeof GitHubOperation.Type;

/** A failed GitHub request, with an HTTP status when a response was received. */
export class GitHubApiError extends Schema.TaggedError<GitHubApiError>(
  "@usine/github/GitHubApiError",
)("GitHubApiError", {
  operation: GitHubOperation,
  status: Schema.Option(Schema.Int),
  message: Schema.NonEmptyString,
}) {}

/** GitHub deferred the request until retryAt; callers can schedule a later attempt. */
export class GitHubRateLimitError extends Schema.TaggedError<GitHubRateLimitError>(
  "@usine/github/GitHubRateLimitError",
)("GitHubRateLimitError", {
  operation: GitHubOperation,
  retryAt: Schema.DateTimeUtc,
  message: Schema.NonEmptyString,
}) {}

/** GitHub returned a response that cannot be decoded or is missing required content. */
export class InvalidGitHubResponseError extends Schema.TaggedError<InvalidGitHubResponseError>(
  "@usine/github/InvalidGitHubResponseError",
)("InvalidGitHubResponseError", {
  operation: GitHubOperation,
  message: Schema.NonEmptyString,
  /** What made the response invalid: the decode path, the missing field, or the GraphQL errors. */
  detail: Schema.NonEmptyString,
}) {}

/**
 * GitHub has no Item with this number in the repository: it was deleted or
 * transferred, or the App can no longer read it. The repository itself answered.
 */
export class GitHubItemNotFoundError extends Schema.TaggedError<GitHubItemNotFoundError>(
  "@usine/github/GitHubItemNotFoundError",
)("GitHubItemNotFoundError", {
  operation: GitHubOperation,
  item: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  message: Schema.NonEmptyString,
}) {}

/** Failures from discovering installation access or making an authenticated GitHub request. */
export const GitHubAppError = Schema.Union([
  InstallationDiscoveryError,
  AppPermissionError,
  GitHubApiError,
  GitHubRateLimitError,
  InvalidGitHubResponseError,
]);
export type GitHubAppError = typeof GitHubAppError.Type;

/**
 * Whether GitHub gave a definite answer that sending the request again does
 * not change: the App has no usable installation, the installation lacks a
 * required permission, or GitHub answered with a 4xx status other than 408
 * and 429, such as 422 for a permission the installation does not grant or
 * 403 for a suspended installation. A request that could not be sent, a
 * server error, a rate limit, and a response that breaks GitHub's API
 * contract are not refusals.
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
