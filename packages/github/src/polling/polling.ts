import { LabelTimeline, readLabelEvents } from "./label-events.ts";
import { canonicalContent } from "./content.ts";
import { ItemNumber } from "@usine/core/item";
import { CommitSha, RepositoryName, splitRepositoryName } from "@usine/core/repository";
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
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { GitHubApp } from "../github-app.ts";
import { queryGraphql } from "../graphql.ts";
import {
  API_ROOT,
  authorized,
  invalidResponse,
  nextPageUrl,
  pollIntervalMillis,
  rateLimitResetMillis,
  retryAfterMillis,
  statusError,
  transportError,
} from "../http.ts";
import { GitHubItemNotFoundError, type GitHubAppError, type GitHubOperation } from "../error.ts";
import {
  BaseRefHead,
  type BaseRefName,
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
const RestGitRef = Schema.Struct({ object: Schema.Struct({ sha: CommitSha }) });
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
    Schema.Struct({
      issue: Schema.OptionFromNullOr(
        Schema.Struct({ ...IssuePayload.fields, timelineItems: LabelTimeline }),
      ),
    }),
  ),
});
const PullRequestData = Schema.Struct({
  repository: Schema.OptionFromNullOr(
    Schema.Struct({
      pullRequest: Schema.OptionFromNullOr(
        Schema.Struct({ ...PullRequestPayload.fields, timelineItems: LabelTimeline }),
      ),
    }),
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

const baseRefUrl = (repository: RepositoryName, baseRefName: BaseRefName): string => {
  const { name, owner } = splitRepositoryName(repository);
  const ref = baseRefName.split("/").map(encodeURIComponent).join("/");
  return `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/ref/heads/${ref}`;
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

/** The service that finds changed GitHub items and fetches their snapshots for loop selection. */
export class GitHubPolling extends Context.Service<
  GitHubPolling,
  {
    /**
     * Returns issue and pull request updates in `repository` since `cursor`, with a five-second
     * watermark overlap. Reads at most ten REST pages; `backlog` reports remaining pages.
     * Persist the returned cursor after processing detected items and respect its poll and
     * backoff deadlines (ADR 0007).
     */
    readonly changes: (
      repository: RepositoryName,
      cursor: PollCursor,
    ) => Effect.Effect<ChangeDetection, GitHubAppError>;
    /**
     * Returns the complete label catalog for `repository`, or confirms that `entityTag` is
     * unchanged. Pass `None` without a cached catalog. Fails with `InvalidGitHubResponseError`
     * if 100 pages do not complete the catalog; never returns a partial catalog.
     */
    readonly labels: (
      repository: RepositoryName,
      entityTag: Option.Option<EntityTag>,
    ) => Effect.Effect<RepositoryLabelCatalog | RepositoryLabelsNotModified, GitHubAppError>;
    /**
     * Returns the head commit of branch `baseRefName`. Sends the ETag of `known`, a head read
     * earlier for the same repository and branch, and returns `known` if GitHub answers 304,
     * which costs no rate limit. Fails with a 404 `GitHubApiError` if the branch doesn't exist.
     */
    readonly baseRefHead: (
      repository: RepositoryName,
      baseRefName: BaseRefName,
      known: Option.Option<BaseRefHead>,
    ) => Effect.Effect<BaseRefHead, GitHubAppError>;
    /**
     * Fetches the issue or pull request identified by `item` in `repository`; its update time
     * does not limit the fetch. Returns the selection and prompt payload with a timestamp-free
     * content hash. Fails with `GitHubItemNotFoundError` if the repository responds but has no
     * such item. Includes current labels and their latest available addition events, searching
     * at most ten timeline pages; missing label history has no map entry.
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
  /**
   * Provides REST change detection and GraphQL snapshots with the App's shared token.
   * Uses the supplied HTTP client for requests and crypto service for SHA-256 content hashes.
   */
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
            `the GitHub label list has more than ${MAX_LABEL_PAGES} pages`,
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

      const baseRefHead = Effect.fn("GitHubPolling.baseRefHead")(function* (
        repository: RepositoryName,
        baseRefName: BaseRefName,
        known: Option.Option<BaseRefHead>,
      ) {
        yield* Effect.annotateCurrentSpan({ repository, baseRefName });
        const token = yield* app.installationToken();
        let request = HttpClientRequest.get(baseRefUrl(repository, baseRefName)).pipe(
          authorized(token.value),
        );
        const knownEntityTag = Option.flatMap(known, ({ entityTag }) => entityTag);
        if (Option.isSome(knownEntityTag)) {
          request = HttpClientRequest.setHeader(request, "if-none-match", knownEntityTag.value);
        }
        const response = yield* execute("fetch-base-ref-head", request);
        const now = yield* Clock.currentTimeMillis;
        if (response.status === 304 && Option.isSome(known)) return known.value;
        if (response.status !== 200) {
          return yield* statusError("fetch-base-ref-head", response, now);
        }
        const decoded = yield* HttpClientResponse.schemaBodyJson(RestGitRef)(response).pipe(
          Effect.mapError((error) => invalidResponse("fetch-base-ref-head", error.message)),
        );
        const entityTag = Schema.decodeUnknownOption(EntityTag)(response.headers.etag);
        if (Option.isNone(entityTag)) {
          yield* Effect.logWarning(
            "GitHub omitted the base branch ETag; next read is unconditional",
            {
              repository,
              baseRefName,
            },
          );
        }
        return new BaseRefHead({ baseRefName, sha: decoded.object.sha, entityTag });
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
                `repository "${repository}" is null: deleted, renamed, or no longer accessible`,
              );
            const itemGone = (operation: GitHubOperation, kind: string) =>
              new GitHubItemNotFoundError({
                operation,
                item: item.number,
                message: `GitHub ${kind} ${repository}#${item.number} was not found. It was deleted or transferred, or the GitHub App can no longer read it.`,
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
              const { timelineItems, ...itemPayload } = payload.value;
              const labels = yield* completeLabels(itemPayload);
              const completePayload = {
                ...itemPayload,
                labels,
                labelEvents: yield* readLabelEvents(
                  { http, app },
                  repository,
                  item.number,
                  labels.nodes,
                  timelineItems,
                ),
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
            const { timelineItems, ...itemPayload } = payload.value;
            const labels = yield* completeLabels(itemPayload);
            const completePayload = {
              ...itemPayload,
              labels,
              labelEvents: yield* readLabelEvents(
                { http, app },
                repository,
                item.number,
                labels.nodes,
                timelineItems,
              ),
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
                  `repository "${repository}" is null: deleted, renamed, or no longer accessible`,
                );
              }
              const issues = data.repository.value;
              return chunk.filter((_, index) => issues[`i${index}`] === null);
            }),
        );
        return missing.flat();
      });

      return { changes, labels, baseRefHead, snapshot, missingIssues };
    }),
  );
}

export {
  EntityTag,
  BaseRefName,
  BaseRefHead,
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
