import { retryTransient } from "@usine/core/retry";
import { type Brand, Duration, Effect, Match, Option, Schema } from "effect";
import { type GitHubApiError, type GitHubAppError, InvalidGitHubResponseError } from "./error.ts";

export class GraphqlServerError extends Schema.TaggedError<
  GraphqlServerError,
  Brand.Brand<"@usine/github/retry/GraphqlServerError">
>("@usine/github/GraphqlServerError")("GraphqlServerError", {
  failure: InvalidGitHubResponseError,
}) {}

export const isTransientStatus = (status: number): boolean =>
  status === 502 || status === 503 || status === 504;

type RequestFailure = GitHubAppError | GraphqlServerError;

const isTransientFailure = (error: RequestFailure): error is GraphqlServerError | GitHubApiError =>
  error._tag === "GraphqlServerError" ||
  (error._tag === "GitHubApiError" && Option.exists(error.status, isTransientStatus));

const transientFailureLogFields = (error: GraphqlServerError | GitHubApiError) =>
  Match.valueTags(error, {
    GraphqlServerError: ({ failure }) => ({ operation: failure.operation }),
    GitHubApiError: ({ operation, status }) => ({
      operation,
      status: Option.getOrUndefined(status),
    }),
  });

export const retryTransientRequest = <A, E extends RequestFailure, R>(
  request: Effect.Effect<A, E, R>,
) =>
  request.pipe(
    retryTransient(isTransientFailure, ({ error, retry, delay }) =>
      isTransientFailure(error)
        ? Effect.logWarning("Transient GitHub request failed; retrying", {
            ...transientFailureLogFields(error),
            errorTag: error._tag,
            retry,
            delayMs: Duration.toMillis(delay),
          })
        : Effect.void,
    ),
  );
