import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { type HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { GitHubRateLimitError, type GitHubOperation } from "./error.ts";
import {
  API_ROOT,
  authorized,
  invalidResponse,
  rateLimitRetryEpoch,
  statusError,
  transportError,
} from "./http.ts";
import type { InstallationToken } from "./installation.ts";

/** The wait for a GraphQL rate limit without reset headers, in milliseconds. */
const GRAPHQL_RATE_LIMIT_FALLBACK_MS = 60_000;

/** The GraphQL response envelope. `errors` can arrive with HTTP 200. */
const GraphqlEnvelope = Schema.Struct({
  data: Schema.optionalKey(Schema.Unknown),
  errors: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        message: Schema.String,
        type: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});

/**
 * Sends one GraphQL query with `token` and decodes `data` with `dataSchema`. Fails with
 * `GitHubRateLimitError` on rate limiting, and with GitHub's messages on other errors. A
 * NOT_FOUND error leaves its null field for `dataSchema` to decode.
 */
export const queryGraphql = Effect.fn("GitHub.queryGraphql")(function* <
  S extends Schema.Codec<unknown, unknown, never, unknown>,
>(
  http: HttpClient.HttpClient,
  token: InstallationToken,
  operation: GitHubOperation,
  query: string,
  variables: Readonly<Record<string, Schema.Json>>,
  dataSchema: S,
) {
  const request = HttpClientRequest.post(`${API_ROOT}/graphql`).pipe(
    HttpClientRequest.bodyJsonUnsafe({ query, variables }),
    authorized(token.value),
  );
  const response = yield* http
    .execute(request)
    .pipe(Effect.mapError((error) => transportError(operation, error)));
  const now = yield* Clock.currentTimeMillis;
  if (response.status !== 200) return yield* statusError(operation, response, now);
  const envelope = yield* HttpClientResponse.schemaBodyJson(GraphqlEnvelope)(response).pipe(
    Effect.mapError((error) => invalidResponse(operation, error.message)),
  );
  if (envelope.errors !== undefined && envelope.errors.length > 0) {
    const rateLimited = envelope.errors.some((error) => error.type === "RATE_LIMITED");
    if (rateLimited) {
      const retryAt = Option.getOrElse(
        rateLimitRetryEpoch(response.headers, now),
        () => now + GRAPHQL_RATE_LIMIT_FALLBACK_MS,
      );
      return yield* new GitHubRateLimitError({
        operation,
        retryAt: DateTime.makeUnsafe(retryAt),
        message: "GitHub GraphQL API rate limit exceeded",
      });
    }
    // GitHub reports a missing Item as a NOT_FOUND error with a null field, which `dataSchema`
    // decodes as absent.
    if (!envelope.errors.every((error) => error.type === "NOT_FOUND")) {
      return yield* invalidResponse(
        operation,
        `GraphQL errors: ${envelope.errors.map((error) => error.message).join("; ")}`,
      );
    }
  }
  return yield* Schema.decodeUnknownEffect(dataSchema)(envelope.data).pipe(
    Effect.mapError((error) => invalidResponse(operation, error.message)),
  );
});
