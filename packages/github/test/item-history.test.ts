import { assert, describe, it } from "@effect/vitest";
import { ItemNumber } from "@usine/core/item";
import { BotLogin } from "@usine/core/worker";
import { RepositoryName } from "@usine/core/repository";
import { DateTime, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { GitHubApp } from "../src/github-app.ts";
import { InstallationToken, InstallationWide } from "../src/installation.ts";
import { GitHubItemHistory } from "../src/item-history.ts";

const repository = RepositoryName.make("basaltbytes/usine");
const appLayer = Layer.succeed(GitHubApp)({
  installation: () => Effect.die("the caller selects the actor"),
  repositories: () => Effect.die("unused installation repositories"),
  installationToken: () =>
    Effect.succeed(
      new InstallationToken({
        value: Redacted.make("history-token"),
        expiresAt: DateTime.makeUnsafe("2026-10-16T22:00:00Z"),
        scope: new InstallationWide(),
      }),
    ),
  botAccount: () => Effect.die("not used by history tests"),
  projectAccess: () => Effect.die("not used by history tests"),
  installationUrl: () => Effect.die("unused installation URL"),
  configureWebhook: () => Effect.die("unused webhook configuration"),
  deliveries: () => Effect.die("unused webhook deliveries"),
  workerToken: () => Effect.die("not used by history tests"),
});

const historyLayer = (client: HttpClient.HttpClient) =>
  GitHubItemHistory.layer.pipe(
    Layer.provide(appLayer),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
  );

const TimelineRequest = Schema.Struct({
  variables: Schema.Struct({
    number: Schema.Int,
    since: Schema.String,
    after: Schema.NullOr(Schema.String),
  }),
});

const variablesOf = (request: HttpClientRequest.HttpClientRequest) => {
  if (request.body._tag !== "Uint8Array") return assert.fail("missing JSON body");
  return Schema.decodeUnknownSync(TimelineRequest)(
    JSON.parse(new TextDecoder().decode(request.body.body)),
  ).variables;
};

const respond = (request: HttpClientRequest.HttpClientRequest, body: Schema.Json) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
  );

const label = (name: string, color: string) => ({ name, color, description: null });
const page = (nodes: ReadonlyArray<Schema.Json>, endCursor: string | null) => ({
  data: {
    repository: {
      issueOrPullRequest: {
        timelineItems: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes },
      },
    },
  },
});

describe("GitHubItemHistory", () => {
  it.effect.each(["usine-phildl", "exe-dev-github-integration"])(
    "returns only %s's changes across pages, excluding other bots and users",
    (login) => {
      const app = { __typename: "Bot", login };
      const requests: Array<HttpClientRequest.HttpClientRequest> = [];
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request);
          const { after } = variablesOf(request);
          if (after === null)
            return respond(
              request,
              page(
                [
                  {
                    __typename: "LabeledEvent",
                    createdAt: "2026-10-15T19:28:13Z",
                    actor: { __typename: "User", login },
                    label: label("ready-for-agent", "1f883d"),
                  },
                  {
                    __typename: "UnlabeledEvent",
                    createdAt: "2026-10-15T19:31:31Z",
                    actor: app,
                    label: label("ready-for-agent", "1f883d"),
                  },
                  {
                    __typename: "LabeledEvent",
                    createdAt: "2026-10-15T19:31:31Z",
                    actor: app,
                    label: {
                      name: "Agent-In-Progress",
                      color: "FBCA04",
                      description: "An usine development run is working this issue",
                    },
                  },
                  {
                    __typename: "IssueComment",
                    createdAt: "2026-10-15T19:40:00Z",
                    url: "https://github.com/basaltbytes/usine/issues/247#issuecomment-1",
                    author: { __typename: "Bot", login: "balade-dev" },
                  },
                ],
                "cursor-1",
              ),
            );
          return respond(
            request,
            page(
              [
                {
                  __typename: "IssueComment",
                  createdAt: "2026-10-15T19:55:08Z",
                  url: "https://github.com/basaltbytes/usine/issues/247#issuecomment-6201011438",
                  author: app,
                },
                {
                  __typename: "PullRequestReview",
                  createdAt: "2026-10-15T19:55:09Z",
                  submittedAt: null,
                  url: "https://github.com/basaltbytes/usine/pull/247#pullrequestreview-1",
                  state: "PENDING",
                  author: app,
                },
                {
                  __typename: "PullRequestReview",
                  createdAt: "2026-10-15T19:55:09Z",
                  submittedAt: "2026-10-15T19:55:10Z",
                  url: "https://github.com/basaltbytes/usine/pull/247#pullrequestreview-2",
                  state: "CHANGES_REQUESTED",
                  author: app,
                },
                {
                  __typename: "LabeledEvent",
                  createdAt: "2026-10-15T19:56:00Z",
                  actor: null,
                  label: label("ghost", "ededed"),
                },
              ],
              null,
            ),
          );
        }),
      );

      return Effect.gen(function* () {
        const history = yield* GitHubItemHistory;
        const changes = yield* history.appChanges(
          repository,
          ItemNumber.make(247),
          DateTime.makeUnsafe("2026-10-15T19:30:39Z"),
          BotLogin.make(`${login}[bot]`),
        );
        assert.deepStrictEqual(
          changes.map((change) => [change._tag, DateTime.formatIso(change.at)]),
          [
            ["LabelRemoved", "2026-10-15T19:31:31.000Z"],
            ["LabelAdded", "2026-10-15T19:31:31.000Z"],
            ["Commented", "2026-10-15T19:55:08.000Z"],
            ["Reviewed", "2026-10-15T19:55:10.000Z"],
          ],
        );
        const added = changes[1];
        assert(added?._tag === "LabelAdded");
        assert.strictEqual(added.label.name, "Agent-In-Progress");
        assert.strictEqual(added.label.color, "FBCA04");
        assert.deepStrictEqual(
          added.label.description,
          Option.some("An usine development run is working this issue"),
        );
        assert.deepStrictEqual(requests.map(variablesOf), [
          { number: 247, since: "2026-10-15T19:30:39.000Z", after: null },
          { number: 247, since: "2026-10-15T19:30:39.000Z", after: "cursor-1" },
        ]);
      }).pipe(Effect.provide(historyLayer(client)));
    },
  );

  it.effect("reports an Item the repository no longer has as not found", () => {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        respond(request, {
          data: { repository: { issueOrPullRequest: null } },
          errors: [{ type: "NOT_FOUND", message: "Could not resolve to an issue or pull request" }],
        }),
      ),
    );
    return Effect.gen(function* () {
      const history = yield* GitHubItemHistory;
      const failure = yield* history
        .appChanges(
          repository,
          ItemNumber.make(999),
          DateTime.makeUnsafe("2026-10-15T19:30:39Z"),
          BotLogin.make("usine-phildl[bot]"),
        )
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "GitHubItemNotFoundError");
    }).pipe(Effect.provide(historyLayer(client)));
  });
});
