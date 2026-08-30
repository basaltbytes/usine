import { Repository } from "@usine/core";
import { Clock, Crypto, DateTime, Effect, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { GitHubApp } from "../github-app.ts";
import { API_ROOT, authorized, transportError } from "../http.ts";
import {
  GitHubApiError,
  type GitHubAppError,
  GitHubRateLimitError,
  InvalidGitHubResponseError,
  type GitHubOperation,
} from "../model.ts";
import {
  ChangedIssue,
  ChangedPullRequest,
  ContentHash,
  EntityTag,
  GitHubPolling,
  IssuePayload,
  IssueSnapshot,
  PayloadHashError,
  PollCursor,
  PullRequestPayload,
  PullRequestSnapshot,
  RepositoryChanges,
  RepositoryNotModified,
  type ChangedItem,
  type PayloadSnapshot,
} from "./model.ts";
import { ISSUE_PAYLOAD_QUERY, PULL_REQUEST_PAYLOAD_QUERY } from "./queries.ts";

const WATERMARK_OVERLAP_MS = 5_000;
const RATE_LIMIT_PRESSURE_THRESHOLD = 100;

const RestChangedItem = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  updatedAt: Schema.DateTimeUtcFromString,
  pullRequest: Schema.optionalKey(Schema.Unknown),
}).pipe(Schema.encodeKeys({ updatedAt: "updated_at", pullRequest: "pull_request" }));
const RestChangedItems = Schema.Array(RestChangedItem);

const IssueGraphqlResponse = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(Schema.Struct({ issue: Schema.NullOr(IssuePayload) })),
  }),
});
const PullRequestGraphqlResponse = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(Schema.Struct({ pullRequest: Schema.NullOr(PullRequestPayload) })),
  }),
});

const TIMESTAMP_FIELDS: ReadonlySet<string> = new Set([
  "closedAt",
  "createdAt",
  "mergedAt",
  "submittedAt",
  "updatedAt",
]);

const canonicalContent = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) return value.map(canonicalContent);
  if (Schema.is(Schema.JsonObject)(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !TIMESTAMP_FIELDS.has(key))
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonicalContent(child)]),
    );
  }
  return value;
};

const parseInteger = (value: string | undefined): Option.Option<number> => {
  if (value === undefined || !/^\d+$/u.test(value)) return Option.none();
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Option.some(parsed) : Option.none();
};

const dateTimeAt = (epochMillis: number) => DateTime.make(epochMillis);

const retryAfterMillis = (value: string | undefined, now: number): Option.Option<number> => {
  const seconds = parseInteger(value);
  if (Option.isSome(seconds)) return Option.some(now + seconds.value * 1_000);
  if (value === undefined) return Option.none();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Option.some(parsed) : Option.none();
};

const rateLimitResetMillis = (
  headers: HttpClientResponse.HttpClientResponse["headers"],
  threshold: number,
): Option.Option<number> => {
  const remaining = parseInteger(headers["x-ratelimit-remaining"]);
  const reset = parseInteger(headers["x-ratelimit-reset"]);
  return Option.isSome(remaining) && remaining.value <= threshold && Option.isSome(reset)
    ? Option.some(reset.value * 1_000)
    : Option.none();
};

const latestDateTime = (candidates: ReadonlyArray<Option.Option<number>>) => {
  const epochs = candidates.flatMap((candidate) =>
    Option.match(candidate, { onNone: () => [], onSome: (value) => [value] }),
  );
  if (epochs.length === 0) return Option.none<DateTime.Utc>();
  return dateTimeAt(Math.max(...epochs));
};

const nextPollAt = (headers: HttpClientResponse.HttpClientResponse["headers"], now: number) =>
  latestDateTime([
    Option.map(parseInteger(headers["x-poll-interval"]), (seconds) => now + seconds * 1_000),
    retryAfterMillis(headers["retry-after"], now),
    rateLimitResetMillis(headers, RATE_LIMIT_PRESSURE_THRESHOLD),
  ]);

const rateLimitRetryAt = (headers: HttpClientResponse.HttpClientResponse["headers"], now: number) =>
  latestDateTime([retryAfterMillis(headers["retry-after"], now), rateLimitResetMillis(headers, 0)]);

const statusError = (
  operation: GitHubOperation,
  response: HttpClientResponse.HttpClientResponse,
  now: number,
) => {
  const retryAt = rateLimitRetryAt(response.headers, now);
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

const invalidResponse = (operation: GitHubOperation) =>
  new InvalidGitHubResponseError({
    operation,
    message: "GitHub returned a response that does not match its API contract",
  });

const repositoryParts = (repository: Repository.Name) => {
  const separator = repository.indexOf("/");
  return {
    owner: repository.slice(0, separator),
    name: repository.slice(separator + 1),
  };
};

const changesUrl = (repository: Repository.Name, cursor: PollCursor): string => {
  const { name, owner } = repositoryParts(repository);
  const url = new URL(
    `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues`,
  );
  url.searchParams.set("state", "all");
  url.searchParams.set("sort", "updated");
  url.searchParams.set("direction", "asc");
  url.searchParams.set("per_page", "100");
  if (Option.isSome(cursor.watermark)) {
    const since = DateTime.toEpochMillis(cursor.watermark.value) - WATERMARK_OVERLAP_MS;
    url.searchParams.set("since", new Date(since).toISOString().replace(".000Z", "Z"));
  }
  return url.toString();
};

const newerWatermark = (cursor: PollCursor, items: ReadonlyArray<ChangedItem>) => {
  const epochs = items.map(({ updatedAt }) => DateTime.toEpochMillis(updatedAt));
  if (Option.isSome(cursor.watermark)) {
    epochs.push(DateTime.toEpochMillis(cursor.watermark.value));
  }
  return epochs.length === 0 ? Option.none<DateTime.Utc>() : dateTimeAt(Math.max(...epochs));
};

const makeContentHash = (crypto: Crypto.Crypto) =>
  Effect.fn("GitHubPolling.contentHash")(function* (payload: Schema.Json) {
    const encoded = new TextEncoder().encode(JSON.stringify(canonicalContent(payload)));
    const digest = yield* crypto.digest("SHA-256", encoded).pipe(
      Effect.mapError(
        (cause) =>
          new PayloadHashError({
            message: "The GitHub payload snapshot could not be hashed",
            cause,
          }),
      ),
    );
    return ContentHash.make(
      Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
  });

/** Live GitHub polling adapter over an installation token and Effect HTTP. */
export const GitHubPollingLayer = Layer.effect(
  GitHubPolling,
  Effect.gen(function* () {
    const app = yield* GitHubApp;
    const crypto = yield* Crypto.Crypto;
    const http = yield* HttpClient.HttpClient;
    const contentHash = makeContentHash(crypto);

    const execute = Effect.fn("GitHubPolling.execute")(function* (
      operation: GitHubOperation,
      request: HttpClientRequest.HttpClientRequest,
    ) {
      return yield* http
        .execute(request)
        .pipe(Effect.mapError((error) => transportError(operation, error)));
    });

    const changes = Effect.fn("GitHubPolling.changes")(function* (
      repository: Repository.Name,
      cursor: PollCursor,
    ) {
      const token = yield* app.installationToken();
      let request = HttpClientRequest.get(changesUrl(repository, cursor)).pipe(
        authorized(token.value),
      );
      if (Option.isSome(cursor.entityTag)) {
        request = HttpClientRequest.setHeader(request, "if-none-match", cursor.entityTag.value);
      }
      const response = yield* execute("poll-repository-changes", request);
      const now = yield* Clock.currentTimeMillis;
      const recommended = nextPollAt(response.headers, now);
      if (response.status === 304) {
        return new RepositoryNotModified({ cursor, nextPollAt: recommended });
      }
      if (response.status !== 200) {
        return yield* statusError("poll-repository-changes", response, now);
      }

      const decoded = yield* HttpClientResponse.schemaBodyJson(RestChangedItems)(response).pipe(
        Effect.mapError(() => invalidResponse("poll-repository-changes")),
      );
      const items = decoded.map((item) =>
        item.pullRequest === undefined
          ? new ChangedIssue({ number: item.number, updatedAt: item.updatedAt })
          : new ChangedPullRequest({ number: item.number, updatedAt: item.updatedAt }),
      );
      const entityTag = Schema.decodeUnknownOption(EntityTag)(response.headers.etag);
      if (Option.isNone(entityTag)) {
        return yield* invalidResponse("poll-repository-changes");
      }
      return new RepositoryChanges({
        cursor: new PollCursor({ entityTag, watermark: newerWatermark(cursor, items) }),
        items,
        nextPollAt: recommended,
      });
    });

    const graphql = Effect.fn("GitHubPolling.graphql")(function* <
      S extends Schema.Codec<unknown, unknown, never, unknown>,
    >(
      operation: GitHubOperation,
      repository: Repository.Name,
      number: number,
      query: string,
      schema: S,
    ) {
      const token = yield* app.installationToken();
      const { name, owner } = repositoryParts(repository);
      const request = HttpClientRequest.post(`${API_ROOT}/graphql`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ query, variables: { owner, name, number } }),
        authorized(token.value),
      );
      const response = yield* execute(operation, request);
      const now = yield* Clock.currentTimeMillis;
      if (response.status !== 200) return yield* statusError(operation, response, now);
      return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
        Effect.mapError(() => invalidResponse(operation)),
      );
    });

    const snapshot = Effect.fn("GitHubPolling.snapshot")(
      (
        repository: Repository.Name,
        item: ChangedItem,
      ): Effect.Effect<PayloadSnapshot, GitHubAppError | PayloadHashError> =>
        Effect.gen(function* () {
          if (item._tag === "ChangedIssue") {
            const response = yield* graphql(
              "fetch-issue-snapshot",
              repository,
              item.number,
              ISSUE_PAYLOAD_QUERY,
              IssueGraphqlResponse,
            );
            const payload = response.data.repository?.issue;
            if (payload === undefined || payload === null) {
              return yield* invalidResponse("fetch-issue-snapshot");
            }
            return new IssueSnapshot({ payload, contentHash: yield* contentHash(payload) });
          }

          const response = yield* graphql(
            "fetch-pull-request-snapshot",
            repository,
            item.number,
            PULL_REQUEST_PAYLOAD_QUERY,
            PullRequestGraphqlResponse,
          );
          const payload = response.data.repository?.pullRequest;
          if (payload === undefined || payload === null) {
            return yield* invalidResponse("fetch-pull-request-snapshot");
          }
          return new PullRequestSnapshot({ payload, contentHash: yield* contentHash(payload) });
        }),
    );

    return { changes, snapshot };
  }),
);
