import { Repository } from "@usine/core";
import { Clock, Context, Crypto, DateTime, Effect, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { GitHubApp } from "../github-app.ts";
import {
  API_ROOT,
  authorized,
  invalidResponse,
  pollIntervalMillis,
  rateLimitResetMillis,
  rateLimitRetryEpoch,
  retryAfterMillis,
  statusError,
  transportError,
} from "../http.ts";
import { GitHubRateLimitError, type GitHubAppError, type GitHubOperation } from "../model.ts";
import {
  ChangedIssue,
  ChangedPullRequest,
  ContentHash,
  EntityTag,
  IssuePayload,
  IssueSnapshot,
  PollCursor,
  PullRequestPayload,
  PullRequestSnapshot,
  RepositoryChanges,
  RepositoryNotModified,
  TIMESTAMP_FIELDS,
  type ChangeDetection,
  type ChangedItem,
  type PayloadSnapshot,
} from "./model.ts";
import { ISSUE_PAYLOAD_QUERY, PULL_REQUEST_PAYLOAD_QUERY } from "./queries.ts";

const WATERMARK_OVERLAP_MS = 5_000;
const RATE_LIMIT_PRESSURE_THRESHOLD = 100;
/** Bounds one cycle's REST walk; the watermark resumes the remainder next cycle. */
const MAX_CHANGE_PAGES = 10;
/** GraphQL rate limiting sometimes omits reset headers; wait at least this long. */
const GRAPHQL_RATE_LIMIT_FALLBACK_MS = 60_000;

const RestChangedItem = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  updatedAt: Schema.DateTimeUtcFromString,
  pullRequest: Schema.optionalKey(Schema.Unknown),
}).pipe(Schema.encodeKeys({ updatedAt: "updated_at", pullRequest: "pull_request" }));
const RestChangedItems = Schema.Array(RestChangedItem);

/** The GraphQL transport envelope; `errors` arrives on HTTP 200 and must be read. */
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

const IssueData = Schema.Struct({
  repository: Schema.OptionFromNullOr(
    Schema.Struct({ issue: Schema.OptionFromNullOr(IssuePayload) }),
  ),
});
const PullRequestData = Schema.Struct({
  repository: Schema.OptionFromNullOr(
    Schema.Struct({ pullRequest: Schema.OptionFromNullOr(PullRequestPayload) }),
  ),
});

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

type Headers = HttpClientResponse.HttpClientResponse["headers"];

const dateTimeAt = (epochMillis: number) => DateTime.make(epochMillis);

const toChangedItems = (decoded: typeof RestChangedItems.Type): Array<ChangedItem> =>
  decoded.map((item) =>
    item.pullRequest === undefined
      ? new ChangedIssue({ number: item.number, updatedAt: item.updatedAt })
      : new ChangedPullRequest({ number: item.number, updatedAt: item.updatedAt }),
  );

const latestDateTime = (candidates: ReadonlyArray<Option.Option<number>>) => {
  const epochs = candidates.flatMap((candidate) =>
    Option.match(candidate, { onNone: () => [], onSome: (value) => [value] }),
  );
  if (epochs.length === 0) return Option.none<DateTime.Utc>();
  return dateTimeAt(Math.max(...epochs));
};

const nextPollAt = (headers: Headers, now: number) =>
  latestDateTime([
    pollIntervalMillis(headers, now),
    retryAfterMillis(headers["retry-after"], now),
    rateLimitResetMillis(headers, RATE_LIMIT_PRESSURE_THRESHOLD),
  ]);

/** `<https://...>; rel="next"` from a Link header, when GitHub has more pages. */
const nextPageUrl = (link: string | undefined): Option.Option<string> => {
  if (link === undefined) return Option.none();
  const match = /<(?<url>[^>]+)>;\s*rel="next"/u.exec(link);
  return Option.fromNullishOr(match?.groups?.["url"]);
};

const sinceParameter = (watermark: DateTime.Utc): string => {
  const epoch = DateTime.toEpochMillis(watermark) - WATERMARK_OVERLAP_MS;
  return `${new Date(epoch - (epoch % 1_000)).toISOString().slice(0, 19)}Z`;
};

const changesUrl = (repository: Repository.Name, cursor: PollCursor): string => {
  const { name, owner } = Repository.parts(repository);
  const url = new URL(
    `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues`,
  );
  url.searchParams.set("state", "all");
  url.searchParams.set("sort", "updated");
  url.searchParams.set("direction", "asc");
  url.searchParams.set("per_page", "100");
  if (Option.isSome(cursor.watermark)) {
    url.searchParams.set("since", sinceParameter(cursor.watermark.value));
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
    // An in-memory SHA-256 digest cannot fail for expected reasons: a failure
    // here is a violated platform invariant, not a domain failure.
    const digest = yield* crypto.digest("SHA-256", encoded).pipe(Effect.orDie);
    return ContentHash.make(
      Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
  });

/** GitHub change detection and snapshot fetching behind one external seam. */
export class GitHubPolling extends Context.Service<
  GitHubPolling,
  {
    readonly changes: (
      repository: Repository.Name,
      cursor: PollCursor,
    ) => Effect.Effect<ChangeDetection, GitHubAppError>;
    readonly snapshot: (
      repository: Repository.Name,
      item: ChangedItem,
    ) => Effect.Effect<PayloadSnapshot, GitHubAppError>;
  }
>()("@usine/github/GitHubPolling") {
  /** Live GitHub polling adapter over an installation token and Effect HTTP. */
  static readonly layer: Layer.Layer<
    GitHubPolling,
    never,
    Crypto.Crypto | GitHubApp | HttpClient.HttpClient
  > = Layer.effect(
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

      const changesPage = Effect.fn("GitHubPolling.changesPage")(function* (url: string) {
        const token = yield* app.installationToken();
        const request = HttpClientRequest.get(url).pipe(authorized(token.value));
        const response = yield* execute("poll-repository-changes", request);
        const now = yield* Clock.currentTimeMillis;
        if (response.status !== 200) {
          return yield* statusError("poll-repository-changes", response, now);
        }
        const decoded = yield* HttpClientResponse.schemaBodyJson(RestChangedItems)(response).pipe(
          Effect.mapError((error) => invalidResponse("poll-repository-changes", error.message)),
        );
        return {
          items: toChangedItems(decoded),
          next: nextPageUrl(response.headers.link),
        } as const;
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
          Effect.mapError((error) => invalidResponse("poll-repository-changes", error.message)),
        );
        const items = toChangedItems(decoded);
        // The ETag is efficiency-only: a page without one costs conditional
        // requests next cycle, never correctness. Only the first page's tag
        // matches the canonical URL the next cycle re-requests.
        const entityTag = Schema.decodeUnknownOption(EntityTag)(response.headers.etag);
        if (Option.isNone(entityTag)) {
          yield* Effect.logWarning("GitHub omitted the changes ETag; next poll is unconditional", {
            repository,
          });
        }

        const allItems = [...items];
        let next = nextPageUrl(response.headers.link);
        let pages = 1;
        while (Option.isSome(next) && pages < MAX_CHANGE_PAGES) {
          const page = yield* changesPage(next.value);
          allItems.push(...page.items);
          next = page.next;
          pages += 1;
        }
        const backlog = Option.isSome(next);
        if (backlog) {
          yield* Effect.logInfo("GitHub changes walk hit the page cap; backlog remains", {
            repository,
            pages,
            items: allItems.length,
          });
        }
        return new RepositoryChanges({
          cursor: new PollCursor({ entityTag, watermark: newerWatermark(cursor, allItems) }),
          items: allItems,
          backlog,
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
        dataSchema: S,
      ) {
        const token = yield* app.installationToken();
        const { name, owner } = Repository.parts(repository);
        const request = HttpClientRequest.post(`${API_ROOT}/graphql`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ query, variables: { owner, name, number } }),
          authorized(token.value),
        );
        const response = yield* execute(operation, request);
        const now = yield* Clock.currentTimeMillis;
        if (response.status !== 200) return yield* statusError(operation, response, now);
        const envelope = yield* HttpClientResponse.schemaBodyJson(GraphqlEnvelope)(response).pipe(
          Effect.mapError((error) => invalidResponse(operation, error.message)),
        );
        // GraphQL reports failures on HTTP 200: rate limiting becomes a typed
        // wait; anything else keeps its messages for diagnosis.
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
          return yield* invalidResponse(
            operation,
            `GraphQL errors: ${envelope.errors.map((error) => error.message).join("; ")}`,
          );
        }
        return yield* Schema.decodeUnknownEffect(dataSchema)(envelope.data).pipe(
          Effect.mapError((error) => invalidResponse(operation, error.message)),
        );
      });

      const snapshot = Effect.fn("GitHubPolling.snapshot")(
        (
          repository: Repository.Name,
          item: ChangedItem,
        ): Effect.Effect<PayloadSnapshot, GitHubAppError> =>
          Effect.gen(function* () {
            if (item._tag === "ChangedIssue") {
              const data = yield* graphql(
                "fetch-issue-snapshot",
                repository,
                item.number,
                ISSUE_PAYLOAD_QUERY,
                IssueData,
              );
              const payload = Option.flatMap(data.repository, ({ issue }) => issue);
              if (Option.isNone(payload)) {
                return yield* invalidResponse(
                  "fetch-issue-snapshot",
                  `issue ${item.number} came back null — deleted, transferred, or access lost`,
                );
              }
              return new IssueSnapshot({
                payload: payload.value,
                contentHash: yield* contentHash(payload.value),
              });
            }

            const data = yield* graphql(
              "fetch-pull-request-snapshot",
              repository,
              item.number,
              PULL_REQUEST_PAYLOAD_QUERY,
              PullRequestData,
            );
            const payload = Option.flatMap(data.repository, ({ pullRequest }) => pullRequest);
            if (Option.isNone(payload)) {
              return yield* invalidResponse(
                "fetch-pull-request-snapshot",
                `pull request ${item.number} came back null — deleted or access lost`,
              );
            }
            return new PullRequestSnapshot({
              payload: payload.value,
              contentHash: yield* contentHash(payload.value),
            });
          }),
      );

      return { changes, snapshot };
    }),
  );
}
