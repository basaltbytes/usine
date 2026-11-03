import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { RepositoryName } from "@usine/core/repository";
import { Clock, DateTime, Effect, Fiber, Layer, Logger, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { GitHubApp } from "../src/github-app.ts";
import { queryGraphql } from "../src/graphql.ts";
import { InstallationToken, InstallationWide } from "../src/installation.ts";
import { PollCursor } from "../src/polling/detection.ts";
import { GitHubPolling } from "../src/polling/polling.ts";

const token = new InstallationToken({
  value: Redacted.make("test-token"),
  expiresAt: DateTime.makeUnsafe("2026-11-03T22:00:00Z"),
  scope: new InstallationWide(),
});
const unused = () => Effect.die("unused GitHub App operation");
const app = Layer.succeed(GitHubApp)({
  installation: unused,
  repositories: unused,
  installationToken: () => Effect.succeed(token),
  botAccount: unused,
  projectAccess: unused,
  installationUrl: unused,
  configureWebhook: unused,
  deliveries: unused,
  workerToken: unused,
});
const repository = RepositoryName.make("basaltbytes/usine");
const graphql = (client: HttpClient.HttpClient) =>
  queryGraphql(client, token, "fetch-pull-request-snapshot", "query { ok }", {}, Schema.Boolean);

for (const mode of ["rest", "graphql"] as const) {
  describe(`${mode} transient requests`, () => {
    for (const status of [502, 503, 504]) {
      it.effect(`recovers from one ${status} with one warning and a short delay`, () => {
        let requests = 0;
        const warnings: Array<ReadonlyArray<unknown>> = [];
        const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
          if (logLevel === "Warn" && Array.isArray(message)) warnings.push(message);
        });
        const client = HttpClient.make((request) =>
          Effect.sync(() => {
            requests++;
            return HttpClientResponse.fromWeb(
              request,
              new Response(
                requests === 1 ? null : JSON.stringify(mode === "rest" ? [] : { data: true }),
                { status: requests === 1 ? status : 200, headers: { etag: '"ok"' } },
              ),
            );
          }),
        );
        const polling = GitHubPolling.layer.pipe(
          Layer.provide(app),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
          Layer.provide(NodeServices.layer),
        );
        return Effect.gen(function* () {
          const request =
            mode === "rest"
              ? (yield* GitHubPolling).changes(repository, PollCursor.empty).pipe(Effect.asVoid)
              : graphql(client).pipe(Effect.asVoid);
          const started = yield* Clock.currentTimeMillis;
          const fiber = yield* request.pipe(
            Effect.andThen(Clock.currentTimeMillis),
            Effect.forkChild,
          );
          yield* TestClock.adjust("10 seconds");
          const finished = yield* Fiber.join(fiber);
          assert.strictEqual(requests, 2);
          assert.lengthOf(warnings, 1);
          assert.deepInclude(warnings[0]?.[1], {
            operation: mode === "rest" ? "poll-repository-changes" : "fetch-pull-request-snapshot",
            status,
            retry: 1,
          });
          assert.isAtLeast(finished - started, 800);
          assert.isAtMost(finished - started, 1200);
        }).pipe(Effect.provide(polling), Effect.provide(Logger.layer([logger])));
      });
    }
  });
}

for (const serverError of [
  {
    message:
      "Something went wrong while executing your query. Please include ABC when reporting this issue.",
  },
  { type: "INTERNAL", message: "Internal server error" },
]) {
  it.effect("caps GraphQL server retries and preserves the response diagnostic", () => {
    let requests = 0;
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        requests++;
        return HttpClientResponse.fromWeb(request, Response.json({ errors: [serverError] }));
      }),
    );
    return Effect.gen(function* () {
      const fiber = yield* graphql(client).pipe(Effect.result, Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      const result = yield* Fiber.join(fiber);
      assert.strictEqual(requests, 3);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag !== "Failure") return;
      assert.strictEqual(result.failure._tag, "InvalidGitHubResponseError");
      if (result.failure._tag !== "InvalidGitHubResponseError") return;
      assert.include(result.failure.detail, serverError.message);
    });
  });
}

for (const status of [401, 403, 404, 422, 429, 500]) {
  it.effect(`does not retry HTTP ${status}`, () => {
    let requests = 0;
    const warnings: Array<unknown> = [];
    const logger = Logger.make<unknown, void>(({ message }) => warnings.push(message));
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        requests++;
        return HttpClientResponse.fromWeb(request, new Response(null, { status }));
      }),
    );
    return graphql(client).pipe(
      Effect.result,
      Effect.map((result) => {
        assert.strictEqual(requests, 1);
        assert.strictEqual(result._tag, "Failure");
        assert.deepStrictEqual(warnings, []);
      }),
      Effect.provide(Logger.layer([logger])),
    );
  });
}

it.effect("does not retry GraphQL permission errors", () => {
  let requests = 0;
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests++;
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }],
        }),
      );
    }),
  );
  return graphql(client).pipe(
    Effect.result,
    Effect.map((result) => {
      assert.strictEqual(requests, 1);
      assert.strictEqual(result._tag, "Failure");
    }),
  );
});

it.effect("returns the last HTTP failure after exactly two retries", () => {
  let requests = 0;
  const warnings: Array<unknown> = [];
  const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push(message);
  });
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests++;
      return HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }));
    }),
  );
  return Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const pending = yield* graphql(client).pipe(
      Effect.result,
      Effect.flatMap((result) =>
        Clock.currentTimeMillis.pipe(Effect.map((finished) => ({ result, finished }))),
      ),
      Effect.forkChild,
    );
    yield* TestClock.adjust("10 seconds");
    const { result, finished } = yield* Fiber.join(pending);
    assert.strictEqual(requests, 3);
    assert.lengthOf(warnings, 2);
    assert.isAtLeast(finished - started, 3200);
    assert.isAtMost(finished - started, 4800);
    assert.strictEqual(result._tag, "Failure");
    if (result._tag !== "Failure") return;
    assert.strictEqual(result.failure._tag, "GitHubApiError");
    if (result.failure._tag !== "GitHubApiError") return;
    assert.deepStrictEqual(result.failure.status, Option.some(503));
  }).pipe(Effect.provide(Logger.layer([logger])));
});
