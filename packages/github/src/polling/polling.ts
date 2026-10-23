import { canonicalContent } from "./content.ts";
import { ItemNumber } from "@usine/core/item";
import { RepositoryName, splitRepositoryName } from "@usine/core/repository";
import {
  Array as Arr,
  Clock,
  Context,
  Crypto,
  DateTime,
  Effect,
  Layer,
  Option,
  Schema,
} from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { GitHubApp } from "../github-app.ts";
import { queryGraphql } from "../graphql.ts";
import {
  API_ROOT,
  authorized,
  invalidResponse,
  pollIntervalMillis,
  rateLimitResetMillis,
  retryAfterMillis,
  statusError,
  transportError,
} from "../http.ts";
import { GitHubItemNotFoundError, type GitHubAppError, type GitHubOperation } from "../error.ts";
import {
  ChangedIssue,
  ChangedPullRequest,
  EntityTag,
  PollCursor,
  RepositoryChanges,
  RepositoryNotModified,
  type ChangeDetection,
  type ChangedItem,
} from "./detection.ts";
import {
  ContentHash,
  IssuePayload,
  IssueSnapshot,
  PullRequestPayload,
  PullRequestSnapshot,
  type PayloadSnapshot,
} from "./payload.ts";
import {
  RepositoryLabel,
  RepositoryLabelCatalog,
  RepositoryLabelColor,
  RepositoryLabelsNotModified,
  RepositoryLabelName,
} from "./labels.ts";
import { ISSUE_PAYLOAD_QUERY, PULL_REQUEST_PAYLOAD_QUERY, issuesPresentQuery } from "./queries.ts";

const WATERMARK_OVERLAP_MS = 5_000;
const RATE_LIMIT_PRESSURE_THRESHOLD = 100;
/** The maximum REST pages per cycle; the watermark resumes the rest next cycle. */
const MAX_CHANGE_PAGES = 10;
/** The maximum label pages per repository. */
const MAX_LABEL_PAGES = 100;
/** The number of issue numbers per `missingIssues` GraphQL request. */
const ISSUES_PER_PRESENCE_CHECK = 50;

const RestChangedItem = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  updatedAt: Schema.DateTimeUtcFromString,
  pullRequest: Schema.optionalKey(Schema.Unknown),
}).pipe(Schema.encodeKeys({ updatedAt: "updated_at", pullRequest: "pull_request" }));
const RestChangedItems = Schema.Array(RestChangedItem);
const RestRepositoryLabels = Schema.Array(
  Schema.Struct({
    name: RepositoryLabelName,
    color: RepositoryLabelColor,
    description: Schema.NullOr(Schema.String),
  }),
);

const catalogLabel = ({
  name,
  color,
  description,
}: (typeof RestRepositoryLabels.Type)[number]): RepositoryLabel =>
  new RepositoryLabel({ name, color, description: Option.fromNullishOr(description) });

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
const IssuePresence = Schema.NullOr(Schema.Struct({ number: Schema.Int }));
/** The response schema for `issuesPresentQuery(count)`; every alias from `i0` to `i<count - 1>` must be present. */
const issuesPresentData = (count: number) =>
  Schema.Struct({
    repository: Schema.OptionFromNullOr(
      Schema.Struct(
        Object.fromEntries(
          Array.from({ length: count }, (_, index) => [`i${index}`, IssuePresence] as const),
        ),
      ),
    ),
  });

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

const requestBackoff = (headers: Headers, now: number) =>
  latestDateTime([
    retryAfterMillis(headers["retry-after"], now),
    rateLimitResetMillis(headers, RATE_LIMIT_PRESSURE_THRESHOLD),
  ]);

const nextPollAt = (headers: Headers, now: number) =>
  latestDateTime([
    pollIntervalMillis(headers, now),
    retryAfterMillis(headers["retry-after"], now),
    rateLimitResetMillis(headers, RATE_LIMIT_PRESSURE_THRESHOLD),
  ]);

/** Returns the `rel="next"` URL from a Link header, if GitHub has more pages. */
const nextPageUrl = (link: string | undefined): Option.Option<string> => {
  if (link === undefined) return Option.none();
  const match = /<(?<url>[^>]+)>;\s*rel="next"/u.exec(link);
  return Option.fromNullishOr(match?.groups?.["url"]);
};

const sinceParameter = (watermark: DateTime.Utc): string => {
  const epoch = DateTime.toEpochMillis(watermark) - WATERMARK_OVERLAP_MS;
  return `${new Date(epoch - (epoch % 1_000)).toISOString().slice(0, 19)}Z`;
};

const changesUrl = (repository: RepositoryName, cursor: PollCursor): string => {
  const { name, owner } = splitRepositoryName(repository);
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

const labelsUrl = (repository: RepositoryName): string => {
  const { name, owner } = splitRepositoryName(repository);
  const url = new URL(
    `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/labels`,
  );
  url.searchParams.set("per_page", "100");
  return url.toString();
};

const itemLabelsUrl = (repository: RepositoryName, item: number): string => {
  const { name, owner } = splitRepositoryName(repository);
  const url = new URL(
    `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${item}/labels`,
  );
  url.searchParams.set("per_page", "100");
  return url.toString();
};

const newerWatermark = (cursor: PollCursor, items: ReadonlyArray<ChangedItem>) => {
  const epochs = items.map(({ updatedAt }) => DateTime.toEpochMillis(updatedAt));
  if (Option.isSome(cursor.watermark)) {
    epochs.push(DateTime.toEpochMillis(cursor.watermark.value));
  }
  return epochs.length === 0 ? Option.none<DateTime.Utc>() : dateTimeAt(Math.max(...epochs));
};

/** The service that finds changed GitHub Items and fetches their snapshots for Loop selection. */
export class GitHubPolling extends Context.Service<
  GitHubPolling,
  {
    /** Returns issue and PR updates since the saved cursor. Persist the returned cursor after processing the detected Items. */
    readonly changes: (
      repository: RepositoryName,
      cursor: PollCursor,
    ) => Effect.Effect<ChangeDetection, GitHubAppError>;
    /** Returns the repository's label catalog, or confirms that the catalog with `entityTag` is unchanged. */
    readonly labels: (
      repository: RepositoryName,
      entityTag: Option.Option<EntityTag>,
    ) => Effect.Effect<RepositoryLabelCatalog | RepositoryLabelsNotModified, GitHubAppError>;
    /**
     * Returns an Item's selection and prompt payload with its content hash. Fails with
     * `GitHubItemNotFoundError` if the repository responds but has no such Item.
     */
    readonly snapshot: (
      repository: RepositoryName,
      item: ChangedItem,
    ) => Effect.Effect<PayloadSnapshot, GitHubAppError | GitHubItemNotFoundError>;
    /**
     * Returns the issue numbers in `numbers` that the repository no longer has (deleted,
     * transferred, or not readable by the App). Sends sequential GraphQL requests of 50 numbers,
     * and none for an empty list. Fails with `InvalidGitHubResponseError` if the repository is
     * null.
     */
    readonly missingIssues: (
      repository: RepositoryName,
      numbers: ReadonlyArray<ItemNumber>,
    ) => Effect.Effect<ReadonlyArray<ItemNumber>, GitHubAppError>;
  }
>()("@usine/github/GitHubPolling") {
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

      const labelsPage = Effect.fn("GitHubPolling.labelsPage")(function* (
        operation: GitHubOperation,
        url: string,
      ) {
        const token = yield* app.installationToken();
        const request = HttpClientRequest.get(url).pipe(authorized(token.value));
        const response = yield* execute(operation, request);
        const now = yield* Clock.currentTimeMillis;
        if (response.status !== 200) {
          return yield* statusError(operation, response, now);
        }
        const decoded = yield* HttpClientResponse.schemaBodyJson(RestRepositoryLabels)(
          response,
        ).pipe(Effect.mapError((error) => invalidResponse(operation, error.message)));
        return {
          labels: decoded.map(catalogLabel),
          next: nextPageUrl(response.headers.link),
        };
      });

      /** Fetches the label pages after the first page, up to the label page cap. */
      const remainingLabelPages = Effect.fn("GitHubPolling.remainingLabelPages")(function* (
        operation: GitHubOperation,
        firstPage: {
          readonly labels: ReadonlyArray<RepositoryLabel>;
          readonly next: Option.Option<string>;
        },
      ) {
        const catalog = [...firstPage.labels];
        let next = firstPage.next;
        let pages = 1;
        while (Option.isSome(next) && pages < MAX_LABEL_PAGES) {
          const page = yield* labelsPage(operation, next.value);
          catalog.push(...page.labels);
          next = page.next;
          pages += 1;
        }
        if (Option.isSome(next)) {
          return yield* invalidResponse(
            operation,
            `GitHub label list exceeded ${MAX_LABEL_PAGES} pages`,
          );
        }
        return catalog.sort((left, right) => left.name.localeCompare(right.name));
      });

      const allLabels = Effect.fn("GitHubPolling.allLabels")(function* (
        operation: GitHubOperation,
        initialUrl: string,
      ) {
        return yield* remainingLabelPages(operation, yield* labelsPage(operation, initialUrl));
      });

      const labels = Effect.fn("GitHubPolling.labels")(function* (
        repository: RepositoryName,
        entityTag: Option.Option<EntityTag>,
      ) {
        yield* Effect.annotateCurrentSpan({ repository });
        const token = yield* app.installationToken();
        let request = HttpClientRequest.get(labelsUrl(repository)).pipe(authorized(token.value));
        if (Option.isSome(entityTag)) {
          request = HttpClientRequest.setHeader(request, "if-none-match", entityTag.value);
        }
        const response = yield* execute("list-repository-labels", request);
        const now = yield* Clock.currentTimeMillis;
        if (response.status === 304) return new RepositoryLabelsNotModified();
        if (response.status !== 200) {
          return yield* statusError("list-repository-labels", response, now);
        }
        const firstPage = yield* HttpClientResponse.schemaBodyJson(RestRepositoryLabels)(
          response,
        ).pipe(
          Effect.mapError((error) => invalidResponse("list-repository-labels", error.message)),
        );
        const catalog = yield* remainingLabelPages("list-repository-labels", {
          labels: firstPage.map(catalogLabel),
          next: nextPageUrl(response.headers.link),
        });
        const catalogEntityTag = Schema.decodeUnknownOption(EntityTag)(response.headers.etag);
        if (Option.isNone(catalogEntityTag)) {
          yield* Effect.logWarning(
            "GitHub omitted the label catalog ETag; next poll is unconditional",
            {
              repository,
            },
          );
        }
        return new RepositoryLabelCatalog({ entityTag: catalogEntityTag, labels: catalog });
      });

      const changes = Effect.fn("GitHubPolling.changes")(function* (
        repository: RepositoryName,
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
          return new RepositoryNotModified({
            cursor,
            nextPollAt: recommended,
            backoffUntil: requestBackoff(response.headers, now),
          });
        }
        if (response.status !== 200) {
          return yield* statusError("poll-repository-changes", response, now);
        }

        const decoded = yield* HttpClientResponse.schemaBodyJson(RestChangedItems)(response).pipe(
          Effect.mapError((error) => invalidResponse("poll-repository-changes", error.message)),
        );
        const items = toChangedItems(decoded);
        // The ETag is only for efficiency: a page without one costs unconditional requests next cycle.
        // Only the first page's tag matches the canonical URL requested next cycle.
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
          backoffUntil: requestBackoff(response.headers, now),
        });
      });

      const graphql = Effect.fn("GitHubPolling.graphql")(function* <
        S extends Schema.Codec<unknown, unknown, never, unknown>,
      >(
        operation: GitHubOperation,
        repository: RepositoryName,
        number: number,
        query: string,
        dataSchema: S,
      ) {
        const token = yield* app.installationToken();
        const { name, owner } = splitRepositoryName(repository);
        return yield* queryGraphql(
          http,
          token,
          operation,
          query,
          { owner, name, number },
          dataSchema,
        );
      });

      const snapshot = Effect.fn("GitHubPolling.snapshot")(
        (
          repository: RepositoryName,
          item: ChangedItem,
        ): Effect.Effect<PayloadSnapshot, GitHubAppError | GitHubItemNotFoundError> =>
          Effect.gen(function* () {
            const repositoryGone = (operation: GitHubOperation) =>
              invalidResponse(
                operation,
                `repository ${repository} came back null: deleted, renamed, or access lost`,
              );
            const itemGone = (operation: GitHubOperation, kind: string) =>
              new GitHubItemNotFoundError({
                operation,
                item: item.number,
                message: `GitHub has no ${kind} ${item.number} in ${repository}: deleted, transferred, or access lost`,
              });
            const completeLabels = Effect.fn("GitHubPolling.completeItemLabels")(function* (
              payload: IssuePayload | PullRequestPayload,
            ) {
              if (payload.labels.nodes.length >= payload.labels.totalCount) return payload.labels;
              yield* Effect.logDebug(
                "Completing truncated Item label connection for Board matching",
                {
                  repository,
                  item: item.number,
                  listedLabels: payload.labels.nodes.length,
                  totalLabels: payload.labels.totalCount,
                },
              );
              const names = yield* allLabels(
                "fetch-item-labels",
                itemLabelsUrl(repository, item.number),
              );
              return { totalCount: names.length, nodes: names.map(({ name }) => ({ name })) };
            });
            if (item._tag === "ChangedIssue") {
              const data = yield* graphql(
                "fetch-issue-snapshot",
                repository,
                item.number,
                ISSUE_PAYLOAD_QUERY,
                IssueData,
              );
              if (Option.isNone(data.repository))
                return yield* repositoryGone("fetch-issue-snapshot");
              const payload = data.repository.value.issue;
              if (Option.isNone(payload)) return yield* itemGone("fetch-issue-snapshot", "issue");
              const completePayload = {
                ...payload.value,
                labels: yield* completeLabels(payload.value),
              };
              return new IssueSnapshot({
                payload: completePayload,
                contentHash: yield* contentHash(completePayload),
              });
            }

            const data = yield* graphql(
              "fetch-pull-request-snapshot",
              repository,
              item.number,
              PULL_REQUEST_PAYLOAD_QUERY,
              PullRequestData,
            );
            if (Option.isNone(data.repository))
              return yield* repositoryGone("fetch-pull-request-snapshot");
            const payload = data.repository.value.pullRequest;
            if (Option.isNone(payload))
              return yield* itemGone("fetch-pull-request-snapshot", "pull request");
            const completePayload = {
              ...payload.value,
              labels: yield* completeLabels(payload.value),
            };
            return new PullRequestSnapshot({
              payload: completePayload,
              contentHash: yield* contentHash(completePayload),
            });
          }),
      );

      const missingIssues = Effect.fn("GitHubPolling.missingIssues")(function* (
        repository: RepositoryName,
        numbers: ReadonlyArray<ItemNumber>,
      ) {
        yield* Effect.annotateCurrentSpan({ repository, issues: numbers.length });
        const { name, owner } = splitRepositoryName(repository);
        const missing = yield* Effect.forEach(
          Arr.chunksOf(numbers, ISSUES_PER_PRESENCE_CHECK),
          (chunk) =>
            Effect.gen(function* () {
              const token = yield* app.installationToken();
              const data = yield* queryGraphql(
                http,
                token,
                "find-missing-issues",
                issuesPresentQuery(chunk.length),
                {
                  owner,
                  name,
                  ...Object.fromEntries(chunk.map((number, index) => [`n${index}`, number])),
                },
                issuesPresentData(chunk.length),
              );
              if (Option.isNone(data.repository)) {
                return yield* invalidResponse(
                  "find-missing-issues",
                  `repository ${repository} came back null: deleted, renamed, or access lost`,
                );
              }
              const issues = data.repository.value;
              return chunk.filter((_, index) => issues[`i${index}`] === null);
            }),
        );
        return missing.flat();
      });

      return { changes, labels, snapshot, missingIssues };
    }),
  );
}

export {
  EntityTag,
  PollCursor,
  ChangedIssue,
  ChangedPullRequest,
  ChangedItem,
  RepositoryNotModified,
  RepositoryChanges,
  ChangeDetection,
} from "./detection.ts";
export {
  RepositoryLabelName,
  RepositoryLabelColor,
  RepositoryLabel,
  RepositoryLabelCatalog,
  RepositoryLabelsNotModified,
  RepositoryLabelDetection,
} from "./labels.ts";
export { GitHubItemNotFoundError } from "../error.ts";
export {
  ContentHash,
  IssuePayload,
  PullRequestPayload,
  IssueSnapshot,
  PullRequestSnapshot,
  PayloadSnapshot,
} from "./payload.ts";

const makeContentHash = (crypto: Crypto.Crypto) =>
  Effect.fn("GitHubPolling.contentHash")(function* (payload: Schema.Json) {
    const encoded = new TextEncoder().encode(JSON.stringify(canonicalContent(payload)));
    // An in-memory SHA-256 digest fails only on a broken platform, so a failure is a defect.
    const digest = yield* crypto.digest("SHA-256", encoded).pipe(Effect.orDie);
    return ContentHash.make(
      Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
  });
