import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { type HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
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

/** GraphQL rate limiting sometimes omits reset headers. Wait at least this long then. */
const GRAPHQL_RATE_LIMIT_FALLBACK_MS = 60_000;

/** The GraphQL transport envelope. `errors` arrives on HTTP 200 and must be read. */
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
 * Sends one GraphQL query under `token` and decodes its `data` with `dataSchema`.
 * GitHub reports failures on HTTP 200: rate limiting becomes `GitHubRateLimitError`,
 * a NOT_FOUND error leaves its null field for `dataSchema` to decode, and any other
 * error fails with GitHub's messages.
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
        message: "GitHub GraphQL asked the poller to wait before retrying",
      });
    }
    // GitHub reports a missing Item as a NOT_FOUND error beside a null
    // field, which `dataSchema` decodes as absent for the caller to judge.
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
