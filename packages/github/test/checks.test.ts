import { readFileSync } from "node:fs";
import { assert, it } from "@effect/vitest";
import { CommitSha, RepositoryName } from "@usine/core/repository";
import { ItemNumber } from "@usine/core/item";
import { DateTime, Effect, Layer, Redacted, type Schema } from "effect";
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
const json = (value: Schema.Json) =>
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

const failedCheckRun = {
  name: "ci",
  conclusion: "failure",
  details_url: "https://github.com/basaltbytes/usine/actions/runs/1/job/2",
  output: { summary: "Check summary", text: null },
};
const failedCheck = { total_count: 1, check_runs: [failedCheckRun] };
// PR #827, Actions job 125150736388: the log retains the assertion and subsequent cleanup.
const recordedJob = readFileSync(
  new URL("./fixtures/ci-failure/job.json", import.meta.url),
  "utf8",
);
const recordedLog = readFileSync(new URL("./fixtures/ci-failure/job.log", import.meta.url), "utf8");

it.effect("keeps the recorded failing assertion and step name without post-job cleanup", () =>
  Effect.gen(function* () {
    const evidence = yield* (yield* GitHubChecks).failures(repository, head);
    assert.deepStrictEqual(evidence.jobs, ["ci"]);
    assert.include(evidence.excerpt, "Run pnpm test");
    assert.include(evidence.excerpt, "expected -4391 to be greater than or equal to 0");
    assert.include(evidence.excerpt, "conversation.browser.test.tsx:866:24");
    assert.include(evidence.excerpt, "Process completed with exit code 1");
    assert.isAtMost(evidence.excerpt.length, 12000);
    assert.notInclude(evidence.excerpt, "Post job cleanup");
    assert.notInclude(evidence.excerpt, "Pruning is unnecessary");
    assert.notInclude(evidence.excerpt, "git config");
    assert.notInclude(evidence.excerpt, "Cleaning up orphan processes");
  }).pipe(
    Effect.provide(
      withClient((url) =>
        url.includes("/logs")
          ? new Response(recordedLog)
          : url.includes("/actions/jobs/")
            ? new Response(recordedJob)
            : json(failedCheck),
      ),
    ),
  ),
);

it.effect("keeps failure-marker context and tails from each failed step within the limit", () =>
  Effect.gen(function* () {
    const evidence = yield* (yield* GitHubChecks).failures(repository, head);
    assert.deepStrictEqual(evidence.jobs, ["ci-0", "ci-1", "ci-2", "ci-3"]);
    for (const text of [
      "Typecheck",
      "error TS2322",
      "Lint",
      "Error: invalid import",
      "Tests",
      "✗ rejects invalid input",
      "expected 2 to equal 1",
      "last line",
    ])
      assert.include(evidence.excerpt, text);
    assert.notInclude(evidence.excerpt, "successful upload");
    assert.notInclude(evidence.excerpt, "successful setup");
    assert.isAtMost(evidence.excerpt.length, 12000);
  }).pipe(
    Effect.provide(
      withClient((url) => {
        const failures = [
          "error TS2322: incompatible types",
          "Error: invalid import",
          "✗ rejects invalid input\nexpected 2 to equal 1",
        ];
        if (url.includes("/logs"))
          return new Response(
            [
              "2026-11-02T07:33:00.1000000Z successful setup",
              ...failures.flatMap((failure, index) => [
                `2026-11-02T07:33:${10 + index * 10}.1000000Z preceding context ${"setup ".repeat(1000)}`,
                `2026-11-02T07:33:${10 + index * 10}.2000000Z ${failure}`,
                ...Array.from(
                  { length: 100 },
                  () => `2026-11-02T07:33:${10 + index * 10}.3000000Z ${"noise ".repeat(30)}`,
                ),
                `2026-11-02T07:33:${15 + index * 10}.1000000Z last line`,
              ]),
              "2026-11-02T07:33:40.1000000Z successful upload",
            ].join("\n"),
          );
        if (url.includes("/actions/jobs/"))
          return json({
            steps: ["Typecheck", "Lint", "Tests"].map((name, index) => ({
              name,
              conclusion: "failure",
              started_at: `2026-11-02T07:33:${10 + index * 10}Z`,
              completed_at: `2026-11-02T07:33:${15 + index * 10}Z`,
            })),
          });
        return json({
          total_count: 4,
          check_runs: Array.from({ length: 4 }, (_, index) => ({
            ...failedCheckRun,
            name: `ci-${index}`,
            details_url: `https://github.com/basaltbytes/usine/actions/runs/1/job/${index + 2}`,
          })),
        });
      }),
    ),
  ),
);

for (const firstStart of ["00", "01"]) {
  for (const action of ["shell", "script", "script after success"]) {
    it.effect(
      `keeps ${action} failures separate when their timestamp ranges overlap (${firstStart})`,
      () =>
        Effect.gen(function* () {
          const evidence = yield* (yield* GitHubChecks).failures(repository, head);
          const [first, second] = evidence.excerpt.split("\n\nSecond check\n");
          assert.isDefined(second);
          assert.include(first, "Error: first check failed");
          assert.notInclude(first, "Error: second check failed");
          assert.include(second, "Error: second check failed");
          assert.include(second, "expected second result");
          if (action === "shell") assert.include(second, "Process completed with exit code 2");
          assert.notInclude(evidence.excerpt, "successful intervening script");
          assert.notInclude(second, "Error: first check failed");
          assert.notInclude(evidence.excerpt, "Post job cleanup");
        }).pipe(
          Effect.provide(
            withClient((url) => {
              if (url.includes("/logs"))
                return new Response(
                  [
                    `2026-11-02T10:00:${firstStart}.1000000Z ##[group]Run ${action === "shell" ? "first-check" : "actions/github-script@v8"}`,
                    `2026-11-02T10:00:${firstStart}.1100000Z ##[endgroup]`,
                    "2026-11-02T10:00:01.1000000Z Error: first check failed",
                    ...(action === "shell"
                      ? [
                          "2026-11-02T10:00:01.2000000Z ##[error]Process completed with exit code 1.",
                        ]
                      : []),
                    ...(action === "script after success"
                      ? [
                          "2026-11-02T10:00:01.2500000Z ##[group]Run actions/github-script@v8",
                          "2026-11-02T10:00:01.2600000Z ##[endgroup]",
                          "2026-11-02T10:00:01.2700000Z successful intervening script",
                        ]
                      : []),
                    `2026-11-02T10:00:01.3000000Z ##[group]Run ${action === "shell" ? "second-check" : "actions/github-script@v8"}`,
                    "2026-11-02T10:00:01.3100000Z ##[endgroup]",
                    "2026-11-02T10:00:01.4000000Z ##[error]Error: second check failed",
                    "expected second result",
                    ...(action === "shell"
                      ? [
                          "2026-11-02T10:00:01.5000000Z ##[error]Process completed with exit code 2.",
                        ]
                      : []),
                    "2026-11-02T10:00:01.6000000Z Post job cleanup.",
                  ].join("\n"),
                );
              if (url.includes("/actions/jobs/"))
                return json({
                  steps: [
                    {
                      name: "First check",
                      conclusion: "failure",
                      started_at: `2026-11-02T10:00:${firstStart}Z`,
                      completed_at: "2026-11-02T10:00:01Z",
                    },
                    ...(action === "script after success"
                      ? [
                          {
                            name: "Successful script",
                            conclusion: "success",
                            started_at: "2026-11-02T10:00:01Z",
                            completed_at: "2026-11-02T10:00:01Z",
                          },
                        ]
                      : []),
                    {
                      name: "Second check",
                      conclusion: "failure",
                      started_at: "2026-11-02T10:00:01Z",
                      completed_at: "2026-11-02T10:00:01Z",
                    },
                  ],
                });
              return json(failedCheck);
            }),
          ),
        ),
    );
  }
}

for (const action of ["shell", "script"]) {
  it.effect(
    `keeps embedded ${action} failures in a composite action before same-second cleanup`,
    () =>
      Effect.gen(function* () {
        const evidence = yield* (yield* GitHubChecks).failures(repository, head);
        assert.include(evidence.excerpt, "Composite checks");
        assert.include(evidence.excerpt, "##[error]Error: required file is missing");
        assert.include(evidence.excerpt, "expected required-file to exist");
        assert.include(evidence.excerpt, "final composite diagnostics");
        if (action === "shell")
          assert.include(evidence.excerpt, "Process completed with exit code 1");
        assert.notInclude(evidence.excerpt, "Post job cleanup");
        assert.notInclude(evidence.excerpt, "git config");
      }).pipe(
        Effect.provide(
          withClient((url) => {
            if (url.includes("/logs"))
              return new Response(
                [
                  "2026-11-02T10:00:01.1000000Z ##[group]Run ./.github/actions/check",
                  "2026-11-02T10:00:01.1100000Z ##[endgroup]",
                  "2026-11-02T10:00:01.1200000Z ##[group]Run echo setup",
                  "2026-11-02T10:00:01.1300000Z ##[endgroup]",
                  "2026-11-02T10:00:01.1400000Z setup",
                  `2026-11-02T10:00:01.2000000Z ##[group]Run ${action === "shell" ? "test -f required-file" : "actions/github-script@v8"}`,
                  "2026-11-02T10:00:01.2100000Z ##[endgroup]",
                  "2026-11-02T10:00:01.3000000Z ##[error]Error: required file is missing",
                  "expected required-file to exist",
                  ...(action === "shell"
                    ? ["2026-11-02T10:00:01.4000000Z ##[error]Process completed with exit code 1."]
                    : []),
                  "2026-11-02T10:00:01.4100000Z ##[group]Run echo diagnostics",
                  "2026-11-02T10:00:01.4200000Z ##[endgroup]",
                  "2026-11-02T10:00:01.4300000Z final composite diagnostics",
                  "2026-11-02T10:00:01.5000000Z Post job cleanup.",
                  "2026-11-02T10:00:01.6000000Z git config --local --unset-all http.https://github.com/.extraheader",
                ].join("\n"),
              );
            if (url.includes("/actions/jobs/"))
              return json({
                steps: [
                  {
                    name: "Composite checks",
                    conclusion: "failure",
                    started_at: "2026-11-02T10:00:01Z",
                    completed_at: "2026-11-02T10:00:01Z",
                  },
                  {
                    name: "Post Run actions/checkout@v7",
                    conclusion: "success",
                    started_at: "2026-11-02T10:00:01Z",
                    completed_at: "2026-11-02T10:00:01Z",
                  },
                ],
              });
            return json(failedCheck);
          }),
        ),
      ),
  );
}

it.effect("uses check output when Actions step metadata is unavailable", () =>
  Effect.gen(function* () {
    const evidence = yield* (yield* GitHubChecks).failures(repository, head);
    assert.include(evidence.excerpt, "Check summary");
  }).pipe(
    Effect.provide(
      withClient((url) =>
        url.includes("/actions/jobs/")
          ? new Response("forbidden", { status: 403 })
          : json(failedCheck),
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

for (const endpoint of ["metadata", "logs"]) {
  it.effect(`propagates rate limits from Actions ${endpoint} for the polling backoff`, () =>
    Effect.gen(function* () {
      const error = yield* (yield* GitHubChecks).failures(repository, head).pipe(Effect.flip);
      assert.strictEqual(error._tag, "GitHubRateLimitError");
    }).pipe(
      Effect.provide(
        withClient((url) => {
          if (url.includes("/actions/jobs/")) {
            if (endpoint === "metadata" || url.includes("/logs"))
              return new Response("rate limited", {
                status: 429,
                headers: { "retry-after": "60" },
              });
            return new Response(recordedJob);
          }
          return json(failedCheck);
        }),
      ),
    ),
  );
}
