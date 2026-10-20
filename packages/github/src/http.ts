import { DateTime, Effect, Option, Redacted, Schema } from "effect";
import { HttpClientRequest, type HttpClientResponse } from "effect/unstable/http";
import type { HttpClientError } from "effect/unstable/http/HttpClientError";
import {
  GitHubApiError,
  GitHubRateLimitError,
  InvalidGitHubResponseError,
  type GitHubOperation,
} from "./error.ts";

export const API_ROOT = "https://api.github.com";
const API_VERSION = "2026-03-10";

export const authorized = (credential: Redacted.Redacted<string>) =>
  HttpClientRequest.setHeaders({
    accept: "application/vnd.github+json",
    authorization: `Bearer ${Redacted.value(credential)}`,
    "user-agent": "usine",
    "x-github-api-version": API_VERSION,
  });

export const transportError = (operation: GitHubOperation, error: HttpClientError) =>
  new GitHubApiError({
    operation,
    status: error.response === undefined ? Option.none() : Option.some(error.response.status),
    message:
      error.response === undefined
        ? "The request to GitHub could not be sent"
        : `GitHub rejected the request with status ${error.response.status}`,
  });

const ErrorBody = Schema.Struct({ message: Schema.NonEmptyString });
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);

/**
 * `failure` with the reason GitHub's error response gives in its `message`
 * field appended, such as `The permissions requested are not granted to this
 * installation.`; `failure` unchanged when the body has no such field.
 */
export const withGitHubReason = (
  failure: GitHubApiError,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<GitHubApiError> =>
  response.json.pipe(
    Effect.map((body) =>
      Option.match(decodeErrorBody(body), {
        onNone: () => failure,
        onSome: ({ message }) =>
          new GitHubApiError({
            operation: failure.operation,
            status: failure.status,
            message: `${failure.message}: ${message}`,
          }),
      }),
    ),
    Effect.catch((error) =>
      Effect.logDebug("GitHub's error response has no JSON body to read a reason from", {
        operation: failure.operation,
        message: error.message,
      }).pipe(Effect.as(failure)),
    ),
  );

export const invalidResponse = (operation: GitHubOperation, detail: string) =>
  new InvalidGitHubResponseError({
    operation,
    message: "GitHub returned a response that does not match its API contract",
    detail,
  });

type Headers = HttpClientResponse.HttpClientResponse["headers"];

const parseInteger = (value: string | undefined): Option.Option<number> => {
  if (value === undefined || !/^\d+$/u.test(value)) return Option.none();
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Option.some(parsed) : Option.none();
};

export const retryAfterMillis = (value: string | undefined, now: number): Option.Option<number> => {
  const seconds = parseInteger(value);
  if (Option.isSome(seconds)) return Option.some(now + seconds.value * 1_000);
  if (value === undefined) return Option.none();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Option.some(parsed) : Option.none();
};

export const rateLimitResetMillis = (
  headers: Headers,
  threshold: number,
): Option.Option<number> => {
  const remaining = parseInteger(headers["x-ratelimit-remaining"]);
  const reset = parseInteger(headers["x-ratelimit-reset"]);
  return Option.isSome(remaining) && remaining.value <= threshold && Option.isSome(reset)
    ? Option.some(reset.value * 1_000)
    : Option.none();
};

export const pollIntervalMillis = (headers: Headers, now: number): Option.Option<number> =>
  Option.map(parseInteger(headers["x-poll-interval"]), (seconds) => now + seconds * 1_000);

const latestEpoch = (candidates: ReadonlyArray<Option.Option<number>>): Option.Option<number> => {
  const epochs = candidates.flatMap((candidate) =>
    Option.match(candidate, { onNone: () => [], onSome: (value) => [value] }),
  );
  return epochs.length === 0 ? Option.none() : Option.some(Math.max(...epochs));
};

/** The epoch when GitHub allows the next request, from `retry-after` and an exhausted primary rate-limit budget. */
export const rateLimitRetryEpoch = (headers: Headers, now: number): Option.Option<number> =>
  latestEpoch([retryAfterMillis(headers["retry-after"], now), rateLimitResetMillis(headers, 0)]);

/** Turns a non-2xx GitHub response into a typed error. A rate-limit status with a known retry time becomes a wait, not a failure. */
export const statusError = (
  operation: GitHubOperation,
  response: HttpClientResponse.HttpClientResponse,
  now: number,
): GitHubApiError | GitHubRateLimitError => {
  const retryAt = Option.flatMap(rateLimitRetryEpoch(response.headers, now), DateTime.make);
  return (response.status === 403 || response.status === 429) && Option.isSome(retryAt)
    ? new GitHubRateLimitError({
        operation,
        retryAt: retryAt.value,
        message: "GitHub asked the poller to wait before retrying",
      })
    : new GitHubApiError({
        operation,
        status: Option.some(response.status),
        message: `GitHub rejected the request with status ${response.status}`,
      });
};
