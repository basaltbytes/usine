import { assert, it } from "@effect/vitest";
import { CommitSha, RepositoryName } from "@usine/core/repository";
import { ItemNumber } from "@usine/core/item";
import { DateTime, Effect, Layer, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { GitHubApp } from "../src/github-app.ts";
import { GitHubChecks } from "../src/checks.ts";
import {
  AppSlug,
  Installation,
  InstallationId,
  InstallationToken,
  InstallationWide,
} from "../src/installation.ts";

const repository = RepositoryName.make("basaltbytes/usine");
const token = new InstallationToken({
  value: Redacted.make("item-writer-token"),
  expiresAt: DateTime.makeUnsafe("2026-09-01T22:00:00Z"),
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
  repositories: () => Effect.die("unused installation repositories"),
  installationToken: () => Effect.succeed(token),
  botAccount: () => Effect.die("unused"),
  projectAccess: () => Effect.die("unused"),
  installationUrl: () => Effect.die("unused installation URL"),
  configureWebhook: () => Effect.die("unused webhook configuration"),
  deliveries: () => Effect.die("unused webhook deliveries"),
  workerToken: () => Effect.die("unused"),
});

const head = CommitSha.make("a".repeat(40));
const withClient = (respond: (url: string) => Response) =>
  GitHubChecks.layer.pipe(
    Layer.provide(appLayer),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, respond(request.url))),
        ),
      ),
    ),
  );
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
it.effect("reads the live PR head and keeps absent checks pending", () =>
  Effect.gen(function* () {
    const snapshot = yield* (yield* GitHubChecks).snapshot(repository, ItemNumber.make(815));
    assert.strictEqual(snapshot.head, head);
    assert.strictEqual(snapshot.state, "pending");
  }).pipe(
    Effect.provide(
      withClient(() =>
        json({
          data: { repository: { pullRequest: { headRefOid: head, statusCheckRollup: null } } },
        }),
      ),
    ),
  ),
);

it.effect("includes failed job names and bounds the end of Actions logs", () =>
  Effect.gen(function* () {
    const evidence = yield* (yield* GitHubChecks).failures(repository, head);
    assert.deepStrictEqual(evidence.jobs, ["typecheck"]);
    assert.include(evidence.excerpt, "final failure");
    assert.isAtMost(evidence.excerpt.length, 12000);
    assert.notInclude(evidence.excerpt, "start of log");
  }).pipe(
    Effect.provide(
      withClient((url) =>
        url.includes("/logs")
          ? new Response(`start of log${"x".repeat(15000)}final failure`)
          : json({
              total_count: 1,
              check_runs: [
                {
                  name: "typecheck",
                  conclusion: "failure",
                  details_url: "https://github.com/basaltbytes/usine/actions/runs/1/job/2",
                  output: { summary: null, text: null },
                },
              ],
            }),
      ),
    ),
  ),
);

it.effect("reports legacy status contexts when no check run failed", () =>
  Effect.gen(function* () {
    const evidence = yield* (yield* GitHubChecks).failures(repository, head);
    assert.deepStrictEqual(evidence.jobs, ["external-ci"]);
    assert.include(evidence.excerpt, "Build failed");
  }).pipe(
    Effect.provide(
      withClient((url) =>
        url.includes("check-runs")
          ? json({ total_count: 0, check_runs: [] })
          : json({
              statuses: [{ context: "external-ci", state: "failure", description: "Build failed" }],
            }),
      ),
    ),
  ),
);

it.effect("propagates rate limits from Actions logs for the polling backoff", () =>
  Effect.gen(function* () {
    const error = yield* (yield* GitHubChecks).failures(repository, head).pipe(Effect.flip);
    assert.strictEqual(error._tag, "GitHubRateLimitError");
  }).pipe(
    Effect.provide(
      withClient((url) =>
        url.includes("/logs")
          ? new Response("rate limited", { status: 429, headers: { "retry-after": "60" } })
          : json({
              total_count: 1,
              check_runs: [
                {
                  name: "ci",
                  conclusion: "failure",
                  details_url: "https://github.com/basaltbytes/usine/actions/runs/1/job/2",
                  output: { summary: null, text: null },
                },
              ],
            }),
      ),
    ),
  ),
);
