import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { ItemNumber } from "@usine/core/item";
import { RepositoryName } from "@usine/core/repository";
import { Clock, DateTime, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { GitHubApp } from "../src/github-app.ts";
import {
  AppSlug,
  Installation,
  InstallationId,
  InstallationToken,
  InstallationWide,
} from "../src/installation.ts";
import { ChangedIssue, ChangedPullRequest, PollCursor } from "../src/polling/detection.ts";
import { RepositoryLabelCatalog, RepositoryLabelsNotModified } from "../src/polling/labels.ts";
import { GitHubPolling } from "../src/polling/polling.ts";

const repository = RepositoryName.make("basaltbytes/usine");
const token = new InstallationToken({
  value: Redacted.make("polling-token"),
  expiresAt: DateTime.makeUnsafe("2026-08-30T22:00:00Z"),
  scope: new InstallationWide(),
});

const appLayer = Layer.succeed(GitHubApp)({
  installation: () =>
    Effect.succeed(
      new Installation({
        id: InstallationId.make(77),
        accountLogin: "basaltbytes",
        appSlug: AppSlug.make("usine-basaltbytes"),
      }),
    ),
  installationToken: () => Effect.succeed(token),
  botAccount: () => Effect.die("not used by polling tests"),
  projectAccess: () => Effect.die("not used by polling tests"),
  workerToken: () => Effect.die("not used by polling tests"),
});

const pollingLayer = (client: HttpClient.HttpClient) =>
  GitHubPolling.layer.pipe(
    Layer.provide(appLayer),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provide(NodeServices.layer),
  );

const response = (
  request: HttpClientRequest.HttpClientRequest,
  body: Schema.Json | null,
  options: { readonly status?: number; readonly headers?: HeadersInit } = {},
) =>
  HttpClientResponse.fromWeb(
    request,
    (() => {
      const headers = new Headers(options.headers);
      if (body !== null) headers.set("content-type", "application/json");
      return new Response(body === null ? null : JSON.stringify(body), {
        status: options.status ?? 200,
        headers,
      });
    })(),
  );

const GraphqlRequest = Schema.Struct({
  query: Schema.String,
  variables: Schema.Struct({ owner: Schema.String, name: Schema.String, number: Schema.Int }),
});

const requestBody = (request: HttpClientRequest.HttpClientRequest): typeof GraphqlRequest.Type => {
  assert.strictEqual(request.body._tag, "Uint8Array");
  if (request.body._tag !== "Uint8Array") return assert.fail("missing JSON body");
  return Schema.decodeUnknownSync(GraphqlRequest)(
    JSON.parse(new TextDecoder().decode(request.body.body)),
  );
};

const issuePayload = (timestamps: {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly commentCreatedAt: string;
}) => ({
  number: 28,
  title: "Polling triggers",
  body: "Build the trigger path.",
  url: "https://github.com/basaltbytes/usine/issues/28",
  state: "OPEN",
  stateReason: null,
  createdAt: timestamps.createdAt,
  updatedAt: timestamps.updatedAt,
  closedAt: null,
  author: { login: "PhilDL" },
  issueType: null,
  milestone: null,
  labels: { totalCount: 1, nodes: [{ name: "ready" }] },
  assignees: { totalCount: 0, nodes: [] },
  comments: {
    totalCount: 1,
    nodes: [
      {
        author: { login: "PhilDL" },
        body: "Ship it.",
        createdAt: timestamps.commentCreatedAt,
      },
    ],
  },
  closedByPullRequestsReferences: { totalCount: 0, nodes: [] },
});

const pullRequestPayload = {
  number: 51,
  title: "Implement polling",
  body: "Ready for review.",
  url: "https://github.com/basaltbytes/usine/pull/51",
  state: "OPEN",
  isDraft: false,
  merged: false,
  createdAt: "2026-08-30T18:00:00Z",
  updatedAt: "2026-08-30T19:00:00Z",
  mergedAt: null,
  author: { login: "usine-bot" },
  baseRefName: "main",
  headRefName: "feature/issue-28-polling-triggers",
  headRefOid: "abc123",
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  reviewDecision: "REVIEW_REQUIRED",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  statusCheckRollup: { state: "PENDING" },
  labels: { totalCount: 0, nodes: [] },
  reviewRequests: {
    totalCount: 2,
    // A deleted user or mannequin arrives as a null requestedReviewer.
    nodes: [{ requestedReviewer: { login: "PhilDL" } }, { requestedReviewer: null }],
  },
  reviews: {
    totalCount: 1,
    nodes: [
      {
        author: { login: "reviewer" },
        state: "COMMENTED",
        body: "One note.",
        submittedAt: "2026-08-30T19:05:00Z",
        commit: { oid: "abc123" },
      },
    ],
  },
  reviewThreads: {
    totalCount: 1,
    nodes: [
      {
        isResolved: false,
        isOutdated: false,
        path: "src/index.ts",
        comments: {
          totalCount: 1,
          nodes: [{ author: { login: "reviewer" }, body: "Please fix." }],
        },
      },
    ],
  },
  comments: { totalCount: 0, nodes: [] },
  closingIssuesReferences: { totalCount: 1, nodes: [{ number: 28, state: "OPEN" }] },
};

describe("GitHubPolling", () => {
  for (const status of [200, 304]) {
    it.effect(`separates normal poll cadence from request backoff on HTTP ${status}`, () => {
      let requestCount = 0;
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          requestCount += 1;
          return response(request, status === 304 ? null : [], {
            status,
            headers:
              requestCount === 1
                ? { "x-poll-interval": "60" }
                : { "x-poll-interval": "60", "retry-after": "90" },
          });
        }),
      );
      return Effect.gen(function* () {
        const polling = yield* GitHubPolling;
        const now = yield* Clock.currentTimeMillis;
        const normal = yield* polling.changes(repository, PollCursor.empty);
        assert.deepStrictEqual(normal.nextPollAt, Option.some(DateTime.makeUnsafe(now + 60_000)));
        assert.deepStrictEqual(normal.backoffUntil, Option.none());
        const limited = yield* polling.changes(repository, PollCursor.empty);
        assert.deepStrictEqual(limited.nextPollAt, Option.some(DateTime.makeUnsafe(now + 90_000)));
        assert.deepStrictEqual(limited.backoffUntil, limited.nextPollAt);
      }).pipe(Effect.provide(pollingLayer(client)));
    });
  }

  it.live(
    "detects issues and PRs with one conditional REST request and an overlapping cursor",
    () => {
      const requests: Array<HttpClientRequest.HttpClientRequest> = [];
      const reset = Math.floor((Date.now() + 120_000) / 1_000);
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request);
          return requests.length === 1
            ? response(
                request,
                [
                  { number: 28, updated_at: "2026-08-30T20:00:01Z" },
                  {
                    number: 51,
                    updated_at: "2026-08-30T20:00:02Z",
                    pull_request: { url: "https://api.github.test/pulls/51" },
                  },
                ],
                {
                  headers: {
                    etag: 'W/"state-1"',
                    "x-ratelimit-remaining": "50",
                    "x-ratelimit-reset": String(reset),
                  },
                },
              )
            : response(request, null, { status: 304 });
        }),
      );

      return Effect.gen(function* () {
        const polling = yield* GitHubPolling;
        const first = yield* polling.changes(repository, PollCursor.empty);
        assert.strictEqual(first._tag, "RepositoryChanges");
        if (first._tag !== "RepositoryChanges") return;
        assert(first.items[0] instanceof ChangedIssue);
        assert(first.items[1] instanceof ChangedPullRequest);
        assert(Option.isSome(first.cursor.entityTag));
        assert.strictEqual(first.cursor.entityTag.value, 'W/"state-1"');
        assert(Option.isSome(first.cursor.watermark));
        assert.strictEqual(
          DateTime.formatIso(first.cursor.watermark.value),
          "2026-08-30T20:00:02.000Z",
        );
        assert(Option.isSome(first.nextPollAt));
        assert.deepStrictEqual(first.backoffUntil, first.nextPollAt);

        const second = yield* polling.changes(repository, first.cursor);
        assert.strictEqual(second._tag, "RepositoryNotModified");

        assert.strictEqual(requests.length, 2);
        const firstUrl = new URL(requests[0]?.url ?? "");
        assert.strictEqual(firstUrl.searchParams.get("state"), "all");
        assert.strictEqual(firstUrl.searchParams.get("sort"), "updated");
        assert.strictEqual(firstUrl.searchParams.get("direction"), "asc");
        assert.strictEqual(firstUrl.searchParams.get("per_page"), "100");
        assert.strictEqual(firstUrl.searchParams.has("since"), false);
        const secondRequest = requests[1];
        assert(secondRequest !== undefined);
        assert.strictEqual(secondRequest.headers["if-none-match"], 'W/"state-1"');
        assert.strictEqual(
          new URL(secondRequest.url).searchParams.get("since"),
          "2026-08-30T19:59:57Z",
        );
        assert.strictEqual(secondRequest.headers.authorization, "Bearer polling-token");
      }).pipe(Effect.provide(pollingLayer(client)));
    },
  );

  it.effect("keeps polling when GitHub omits the efficiency-only ETag", () => {
    const client = HttpClient.make((request) => Effect.succeed(response(request, [])));

    return Effect.gen(function* () {
      const polling = yield* GitHubPolling;
      // The cursor is only for efficiency (ADR 0007); a page without an ETag falls back to unconditional polling and never fails the cycle.
      const detected = yield* polling.changes(repository, PollCursor.empty);
      assert.strictEqual(detected._tag, "RepositoryChanges");
      if (detected._tag !== "RepositoryChanges") return;
      assert(Option.isNone(detected.cursor.entityTag));
    }).pipe(Effect.provide(pollingLayer(client)));
  });

  it.effect("walks paginated change pages within one cycle", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request);
        return requests.length === 1
          ? response(request, [{ number: 28, updated_at: "2026-08-30T20:00:01Z" }], {
              headers: {
                etag: 'W/"page-1"',
                link: '<https://api.github.com/repositories/1/issues?page=2>; rel="next"',
              },
            })
          : response(request, [{ number: 29, updated_at: "2026-08-30T20:00:02Z" }]);
      }),
    );

    return Effect.gen(function* () {
      const polling = yield* GitHubPolling;
      const detected = yield* polling.changes(repository, PollCursor.empty);
      assert.strictEqual(detected._tag, "RepositoryChanges");
      if (detected._tag !== "RepositoryChanges") return;
      assert.strictEqual(detected.items.length, 2);
      assert.strictEqual(detected.backlog, false);
      // The first page's ETag stays on the cursor because it matches the canonical URL the next cycle re-requests.
      assert(Option.isSome(detected.cursor.entityTag));
      assert.strictEqual(detected.cursor.entityTag.value, 'W/"page-1"');
      assert(Option.isSome(detected.cursor.watermark));
      assert.strictEqual(
        DateTime.formatIso(detected.cursor.watermark.value),
        "2026-08-30T20:00:02.000Z",
      );
      assert.strictEqual(requests.length, 2);
      assert.strictEqual(requests[1]?.url, "https://api.github.com/repositories/1/issues?page=2");
    }).pipe(Effect.provide(pollingLayer(client)));
  });

  it.effect("walks the complete repository label catalog for Board lane proposals", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const client = HttpClient.make((request) => {
      requests.push(request);
      return Effect.succeed(
        requests.length === 1
          ? response(request, [{ name: "ready", color: "0E8A16", description: "Ready to start" }], {
              headers: {
                etag: 'W/"labels-1"',
                link: '<https://api.github.com/repositories/1/labels?page=2>; rel="next"',
              },
            })
          : requests.length === 2
            ? response(request, [{ name: "bug", color: "d73a4a", description: null }])
            : response(request, null, { status: 304 }),
      );
    });

    return Effect.gen(function* () {
      const polling = yield* GitHubPolling;
      const catalog = yield* polling.labels(repository, Option.none());
      assert(catalog instanceof RepositoryLabelCatalog);
      if (!(catalog instanceof RepositoryLabelCatalog)) return;
      assert(Option.isSome(catalog.entityTag));
      if (Option.isNone(catalog.entityTag)) return;
      assert.deepStrictEqual(
        catalog.labels.map(({ name, color, description }) => [
          name,
          color,
          Option.getOrNull(description),
        ]),
        [
          ["bug", "d73a4a", null],
          ["ready", "0E8A16", "Ready to start"],
        ],
      );
      assert.strictEqual(requests.length, 2);
      assert.strictEqual(
        requests[0]?.url,
        "https://api.github.com/repos/basaltbytes/usine/labels?per_page=100",
      );
      assert.strictEqual(requests[1]?.url, "https://api.github.com/repositories/1/labels?page=2");
      const unchanged = yield* polling.labels(repository, catalog.entityTag);
      assert(unchanged instanceof RepositoryLabelsNotModified);
      assert.strictEqual(requests.length, 3);
      assert.strictEqual(requests[2]?.headers["if-none-match"], catalog.entityTag.value);
    }).pipe(Effect.provide(pollingLayer(client)));
  });

  it.effect("completes truncated Item labels before Board lane matching", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const labels = Array.from({ length: 51 }, (_, index) => `label-${index + 1}`);
    const finalLabel = labels.at(-1) ?? assert.fail("missing label fixture");
    const partialPayload = {
      ...issuePayload({
        createdAt: "2026-08-30T10:00:00Z",
        updatedAt: "2026-08-30T20:00:00Z",
        commentCreatedAt: "2026-08-30T12:00:00Z",
      }),
      labels: { totalCount: labels.length, nodes: labels.slice(0, 50).map((name) => ({ name })) },
    };
    const client = HttpClient.make((request) => {
      requests.push(request);
      if (request.url.endsWith("/graphql")) {
        return Effect.succeed(
          response(request, { data: { repository: { issue: partialPayload } } }),
        );
      }
      return Effect.succeed(
        requests.length === 2
          ? response(
              request,
              labels.slice(0, 50).map((name) => ({ name, color: "ededed", description: null })),
              {
                headers: {
                  link: '<https://api.github.com/repositories/1/issues/28/labels?page=2>; rel="next"',
                },
              },
            )
          : response(request, [{ name: finalLabel, color: "ededed", description: null }]),
      );
    });

    return Effect.gen(function* () {
      const polling = yield* GitHubPolling;
      const snapshot = yield* polling.snapshot(
        repository,
        new ChangedIssue({ number: 28, updatedAt: DateTime.makeUnsafe("2026-08-30T20:00:00Z") }),
      );
      assert.strictEqual(snapshot._tag, "IssueSnapshot");
      if (snapshot._tag !== "IssueSnapshot") return;
      assert.strictEqual(snapshot.payload.labels.totalCount, labels.length);
      assert.deepStrictEqual(
        snapshot.payload.labels.nodes.map(({ name }) => name),
        [...labels].sort((left, right) => left.localeCompare(right)),
      );
      assert.strictEqual(requests.length, 3);
      assert.strictEqual(
        requests[1]?.url,
        "https://api.github.com/repos/basaltbytes/usine/issues/28/labels?per_page=100",
      );
      assert.strictEqual(
        requests[2]?.url,
        "https://api.github.com/repositories/1/issues/28/labels?page=2",
      );
    }).pipe(Effect.provide(pollingLayer(client)));
  });

  it.effect("classifies GraphQL rate limiting reported on HTTP 200", () => {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        response(request, {
          data: null,
          errors: [{ type: "RATE_LIMITED", message: "API rate limit exhausted" }],
        }),
      ),
    );

    return Effect.gen(function* () {
      const polling = yield* GitHubPolling;
      const failure = yield* polling
        .snapshot(
          repository,
          new ChangedIssue({ number: 28, updatedAt: DateTime.makeUnsafe("2026-08-30T20:00:00Z") }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "GitHubRateLimitError");
    }).pipe(Effect.provide(pollingLayer(client)));
  });

  it.effect("carries GraphQL error messages instead of discarding them", () => {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        response(request, {
          data: null,
          errors: [{ message: "Something went wrong while executing your query." }],
        }),
      ),
    );

    return Effect.gen(function* () {
      const polling = yield* GitHubPolling;
      const failure = yield* polling
        .snapshot(
          repository,
          new ChangedIssue({ number: 28, updatedAt: DateTime.makeUnsafe("2026-08-30T20:00:00Z") }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "InvalidGitHubResponseError");
      if (failure._tag === "InvalidGitHubResponseError") {
        assert.match(failure.detail, /Something went wrong/u);
      }
    }).pipe(Effect.provide(pollingLayer(client)));
  });

  it.effect("reports a pull request the repository no longer has as not found", () => {
    const answers = [
      {
        data: { repository: { pullRequest: null } },
        errors: [
          {
            type: "NOT_FOUND",
            message: "Could not resolve to a PullRequest with the number of 51.",
          },
        ],
      },
      { data: { repository: { pullRequest: null } } },
      { data: { repository: null } },
    ];
    const client = HttpClient.make((request) =>
      Effect.sync(() => response(request, answers.shift() ?? null)),
    );

    return Effect.gen(function* () {
      const polling = yield* GitHubPolling;
      const fetch = polling
        .snapshot(
          repository,
          new ChangedPullRequest({
            number: 51,
            updatedAt: DateTime.makeUnsafe("2026-08-30T19:00:00Z"),
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual((yield* fetch)._tag, "GitHubItemNotFoundError");
      assert.strictEqual((yield* fetch)._tag, "GitHubItemNotFoundError");
      // A null repository says nothing about the Item.
      assert.strictEqual((yield* fetch)._tag, "InvalidGitHubResponseError");
    }).pipe(Effect.provide(pollingLayer(client)));
  });

  it.effect("asks about 60 issues in two requests and returns the ones that come back null", () => {
    const PresenceRequest = Schema.Struct({
      query: Schema.String,
      variables: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Int])),
    });
    const gone = new Set([7, 55]);
    const asked: Array<ReadonlyArray<number>> = [];
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        assert.strictEqual(request.body._tag, "Uint8Array");
        if (request.body._tag !== "Uint8Array") return assert.fail("missing JSON body");
        const { query, variables } = Schema.decodeUnknownSync(PresenceRequest)(
          JSON.parse(new TextDecoder().decode(request.body.body)),
        );
        const numbers = Object.entries(variables).flatMap(([name, value]) =>
          /^n\d+$/u.test(name) ? [Schema.decodeUnknownSync(Schema.Int)(value)] : [],
        );
        asked.push(numbers);
        assert.include(query, `i${numbers.length - 1}: issue(number: $n${numbers.length - 1})`);
        return response(request, {
          data: {
            repository: Object.fromEntries(
              numbers.map((number, index) => [`i${index}`, gone.has(number) ? null : { number }]),
            ),
          },
          errors: numbers
            .filter((number) => gone.has(number))
            .map((number) => ({
              type: "NOT_FOUND",
              message: `Could not resolve to an Issue with the number of ${number}.`,
            })),
        });
      }),
    );

    return Effect.gen(function* () {
      const polling = yield* GitHubPolling;
      const numbers = Array.from({ length: 60 }, (_, index) => ItemNumber.make(index + 1));
      assert.deepStrictEqual(yield* polling.missingIssues(repository, numbers), [
        ItemNumber.make(7),
        ItemNumber.make(55),
      ]);
      assert.deepStrictEqual(
        asked.map((chunk) => chunk.length),
        [50, 10],
      );
      assert.deepStrictEqual(asked.flat(), numbers);
      assert.deepStrictEqual(yield* polling.missingIssues(repository, []), []);
      assert.strictEqual(asked.length, 2);
    }).pipe(Effect.provide(pollingLayer(client)));
  });

  it.effect("hashes canonical issue content without any timestamp fields", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const firstVersion = issuePayload({
      createdAt: "2026-08-30T10:00:00Z",
      updatedAt: "2026-08-30T20:00:00Z",
      commentCreatedAt: "2026-08-30T12:00:00Z",
    });
    const secondVersion = issuePayload({
      createdAt: "2026-08-01T10:00:00Z",
      updatedAt: "2026-08-31T20:00:00Z",
      commentCreatedAt: "2026-08-29T12:00:00Z",
    });
    const contentChange = { ...secondVersion, title: "Polling triggers, revised" };
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request);
        return response(request, {
          data: {
            repository: {
              issue:
                requests.length === 1
                  ? firstVersion
                  : requests.length === 2
                    ? secondVersion
                    : contentChange,
            },
          },
        });
      }),
    );

    return Effect.gen(function* () {
      const polling = yield* GitHubPolling;
      const changed = new ChangedIssue({
        number: 28,
        updatedAt: DateTime.makeUnsafe("2026-08-30T20:00:00Z"),
      });
      const first = yield* polling.snapshot(repository, changed);
      const second = yield* polling.snapshot(repository, changed);
      const changedContent = yield* polling.snapshot(repository, changed);
      assert.strictEqual(first._tag, "IssueSnapshot");
      assert.strictEqual(second._tag, "IssueSnapshot");
      assert.strictEqual(first.contentHash, second.contentHash);
      assert.notStrictEqual(first.contentHash, changedContent.contentHash);

      const body = requestBody(requests[0] ?? assert.fail("missing GraphQL request"));
      assert.strictEqual(body.variables.owner, "basaltbytes");
      assert.strictEqual(body.variables.name, "usine");
      assert.strictEqual(body.variables.number, 28);
      assert.match(String(body.query), /comments\(last: 20\)/u);
      assert.match(String(body.query), /includeClosedPrs: true/u);
    }).pipe(Effect.provide(pollingLayer(client)));
  });

  it.effect("fetches the complete pull-request slice selected by a changed PR", () => {
    let captured: HttpClientRequest.HttpClientRequest | undefined;
    const client = HttpClient.make((request) => {
      captured = request;
      return Effect.succeed(
        response(request, { data: { repository: { pullRequest: pullRequestPayload } } }),
      );
    });

    return Effect.gen(function* () {
      const polling = yield* GitHubPolling;
      const snapshot = yield* polling.snapshot(
        repository,
        new ChangedPullRequest({
          number: 51,
          updatedAt: DateTime.makeUnsafe("2026-08-30T19:00:00Z"),
        }),
      );
      assert.strictEqual(snapshot._tag, "PullRequestSnapshot");
      if (snapshot._tag !== "PullRequestSnapshot") return;
      assert.strictEqual(snapshot.payload.reviewThreads.nodes[0]?.path, "src/index.ts");
      assert.strictEqual(snapshot.payload.headRefOid, "abc123");

      assert(captured !== undefined);
      const body = requestBody(captured);
      assert.match(String(body.query), /reviewThreads\(first: 50\)/u);
      assert.match(String(body.query), /reviews\(last: 20\)/u);
      assert.match(String(body.query), /statusCheckRollup \{ state \}/u);
    }).pipe(Effect.provide(pollingLayer(client)));
  });

  it.effect("normalizes GitHub's nullable connections to empty connections", () => {
    const base = {
      ...pullRequestPayload,
      reviewThreads: { totalCount: 0, nodes: [] },
      comments: { totalCount: 0, nodes: [] },
    };
    const nullConnections = {
      ...base,
      labels: null,
      reviewRequests: null,
      reviews: null,
      closingIssuesReferences: null,
    };
    const emptyConnections = {
      ...base,
      labels: { totalCount: 0, nodes: [] },
      reviewRequests: { totalCount: 0, nodes: [] },
      reviews: { totalCount: 0, nodes: [] },
      closingIssuesReferences: { totalCount: 0, nodes: [] },
    };
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request);
        return response(request, {
          data: {
            repository: {
              pullRequest: requests.length === 1 ? nullConnections : emptyConnections,
            },
          },
        });
      }),
    );

    return Effect.gen(function* () {
      const polling = yield* GitHubPolling;
      const changed = new ChangedPullRequest({
        number: 51,
        updatedAt: DateTime.makeUnsafe("2026-08-30T19:00:00Z"),
      });
      const fromNulls = yield* polling.snapshot(repository, changed);
      const fromEmpties = yield* polling.snapshot(repository, changed);
      assert.strictEqual(fromNulls._tag, "PullRequestSnapshot");
      if (fromNulls._tag !== "PullRequestSnapshot") return;
      // A null connection is equivalent to an empty one; the payload stays non-null and both hash to the same Event identity.
      assert.deepStrictEqual(fromNulls.payload.labels, { totalCount: 0, nodes: [] });
      assert.deepStrictEqual(fromNulls.payload.reviews, { totalCount: 0, nodes: [] });
      assert.strictEqual(fromNulls.contentHash, fromEmpties.contentHash);
    }).pipe(Effect.provide(pollingLayer(client)));
  });

  it.live("turns GitHub retry guidance into a typed rate-limit deadline", () => {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        response(
          request,
          { message: "slow down" },
          { status: 429, headers: { "retry-after": "60" } },
        ),
      ),
    );

    return Effect.gen(function* () {
      const polling = yield* GitHubPolling;
      const before = Date.now();
      const failure = yield* polling.changes(repository, PollCursor.empty).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "GitHubRateLimitError");
      if (failure._tag === "GitHubRateLimitError") {
        assert(DateTime.toEpochMillis(failure.retryAt) >= before + 59_000);
      }
    }).pipe(Effect.provide(pollingLayer(client)));
  });
});
