import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Repository } from "@usine/core";
import { DateTime, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  ChangedIssue,
  ChangedPullRequest,
  GitHubApp,
  GitHubPolling,
  Installation,
  InstallationId,
  InstallationToken,
  InstallationWide,
  PollCursor,
} from "../src/index.ts";

const repository = Repository.Name.make("basaltbytes/usine");
const token = new InstallationToken({
  value: Redacted.make("polling-token"),
  expiresAt: DateTime.makeUnsafe("2026-08-30T22:00:00Z"),
  scope: new InstallationWide(),
});

const appLayer = Layer.succeed(GitHubApp)({
  installation: () =>
    Effect.succeed(new Installation({ id: InstallationId.make(77), accountLogin: "basaltbytes" })),
  installationToken: () => Effect.succeed(token),
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
      // The cursor is efficiency-only (ADR 0007): a page without an ETag must
      // degrade to unconditional polling, never fail the cycle.
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
      // The first page's ETag stays on the cursor: it matches the canonical
      // URL the next cycle re-requests conditionally.
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
          ? response(request, [{ name: "ready" }], {
              headers: {
                link: '<https://api.github.com/repositories/1/labels?page=2>; rel="next"',
              },
            })
          : response(request, [{ name: "bug" }]),
      );
    });

    return Effect.gen(function* () {
      const polling = yield* GitHubPolling;
      assert.deepStrictEqual((yield* polling.labels(repository)).map(String), ["bug", "ready"]);
      assert.strictEqual(requests.length, 2);
      assert.strictEqual(
        requests[0]?.url,
        "https://api.github.com/repos/basaltbytes/usine/labels?per_page=100",
      );
      assert.strictEqual(requests[1]?.url, "https://api.github.com/repositories/1/labels?page=2");
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
      // A null connection is the same information as an empty one: the domain
      // payload stays non-null and both shapes hash to the same Event identity.
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
