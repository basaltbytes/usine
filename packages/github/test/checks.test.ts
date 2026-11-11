import { jsonKey } from "@usine/core/json-key";
// This Node boundary needs synchronous filesystem operations that FileSystem does not expose.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFileSync } from "node:fs";
import { assert, it } from "@effect/vitest";
import { CommitSha, RepositoryName } from "@usine/core/repository";
import { ItemNumber } from "@usine/core/item";
import { DateTime, Effect, Fiber, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { strToU8, zipSync } from "fflate/browser";
import { GitHubApp } from "../src/github-app.ts";
import { GitHubChecks, PendingCheck } from "../src/checks.ts";
import {
  AppSlug,
  Installation,
  InstallationId,
  InstallationToken,
  InstallationWide,
} from "../src/installation.ts";

const repository = RepositoryName.make("basaltbytes/usine");
const token = InstallationToken.make({
  value: Redacted.make("item-writer-token"),
  expiresAt: DateTime.makeUnsafe("2026-09-01T22:00:00Z"),
  scope: InstallationWide.make(),
});

const appLayer = Layer.succeed(GitHubApp)({
  installation: Effect.succeed(
    Installation.make({
      id: InstallationId.make(77),
      accountLogin: "basaltbytes",
      appSlug: AppSlug.make("usine-basaltbytes"),
    }),
  ),
  repositories: Effect.die("unused installation repositories"),
  installationToken: Effect.succeed(token),
  botAccount: Effect.die("unused"),
  projectAccess: () => Effect.die("unused"),
  installationUrl: Effect.die("unused installation URL"),
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
  new Response(jsonKey(value), {
    headers: { "content-type": "application/json" },
  });
it.effect.each([
  { mergeable: "CONFLICTING", rollup: null, expected: "conflict" },
  { mergeable: "UNKNOWN", rollup: null, expected: "pending" },
  { mergeable: "MERGEABLE", rollup: null, expected: "pending" },
  { mergeable: "CONFLICTING", rollup: "PENDING", expected: "pending" },
  { mergeable: "CONFLICTING", rollup: "SUCCESS", expected: "success" },
  { mergeable: "MERGEABLE", rollup: "SUCCESS", expected: "success" },
  { mergeable: "MERGEABLE", rollup: "FAILURE", expected: "failure" },
  { mergeable: "MERGEABLE", rollup: "ERROR", expected: "failure" },
])("reads $mergeable with check rollup $rollup as $expected", ({ mergeable, rollup, expected }) =>
  Effect.gen(function* () {
    const snapshot = yield* (yield* GitHubChecks).snapshot(repository, ItemNumber.make(815));
    assert.strictEqual(snapshot.head, head);
    assert.strictEqual(snapshot.state, expected);
  }).pipe(
    Effect.provide(
      withClient(() =>
        json({
          data: {
            repository: {
              pullRequest: {
                headRefOid: head,
                headRef: { target: { oid: head } },
                mergeable,
                statusCheckRollup: rollup === null ? null : { state: rollup },
              },
            },
          },
        }),
      ),
    ),
  ),
);

it.effect.each(["SUCCESS", "FAILURE", null])(
  "waits for a lagging pull request head with old rollup %s before accepting its checks",
  (rollup) =>
    Effect.gen(function* () {
      const snapshot = yield* (yield* GitHubChecks).snapshot(repository, ItemNumber.make(815));
      assert.strictEqual(snapshot.head, head);
      assert.strictEqual(snapshot.state, "pending");
    }).pipe(
      Effect.provide(
        withClient(() =>
          json({
            data: {
              repository: {
                pullRequest: {
                  headRefOid: "b".repeat(40),
                  headRef: { target: { oid: head } },
                  mergeable: "CONFLICTING",
                  statusCheckRollup: rollup === null ? null : { state: rollup },
                },
              },
            },
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

it.effect.each(["available", "missing", "forbidden"] as const)(
  "reports running and queued checks at timeout with %s duration history",
  (history) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-05T20:25:00Z")));
      const details = yield* (yield* GitHubChecks).pendingDetails(repository, head);
      assert.deepStrictEqual(details, [
        PendingCheck.make({
          name: "test (web)",
          status: "in_progress",
          startedAt: Option.some(DateTime.makeUnsafe("2026-11-05T19:54:00Z")),
          elapsedMilliseconds: Option.some(31 * 60000),
          previousDurationMilliseconds:
            history === "available" ? Option.some(6 * 60000) : Option.none(),
        }),
        PendingCheck.make({
          name: "test (server)",
          status: "queued",
          startedAt: Option.none(),
          elapsedMilliseconds: Option.none(),
          previousDurationMilliseconds: Option.none(),
        }),
      ]);
    }).pipe(
      Effect.provide(
        withClient((url) => {
          if (url.includes("/check-runs?"))
            return json({
              total_count: 3,
              check_runs: [
                {
                  name: "test (web)",
                  status: "in_progress",
                  started_at: "2026-11-05T19:54:00Z",
                  details_url: failedCheckRun.details_url,
                },
                { name: "test (server)", status: "queued", started_at: null, details_url: null },
                {
                  name: "static",
                  status: "completed",
                  started_at: "2026-11-05T19:54:00Z",
                  details_url: null,
                },
              ],
            });
          if (history === "forbidden") return new Response("", { status: 403 });
          if (url.endsWith("/actions/runs/1")) return json({ workflow_id: 7 });
          if (url.includes("/actions/workflows/7/runs?"))
            return json({ workflow_runs: history === "missing" ? [] : [{ id: 8 }] });
          assert.include(url, "/actions/runs/8/jobs?");
          return json({
            total_count: 2,
            jobs: [
              {
                name: "test (engine)",
                conclusion: "success",
                started_at: "2026-11-04T19:54:00Z",
                completed_at: "2026-11-04T19:55:00Z",
              },
              {
                name: "test (web)",
                conclusion: "success",
                started_at: "2026-11-04T19:54:00Z",
                completed_at: "2026-11-04T20:00:00Z",
              },
            ],
          });
        }),
      ),
    ),
);

it.effect("reports missing checks without claiming that a job is running", () =>
  Effect.gen(function* () {
    const details = yield* (yield* GitHubChecks).pendingDetails(repository, head);
    assert.deepStrictEqual(details, []);
  }).pipe(
    Effect.provide(
      withClient((url) => {
        assert.include(url, `/commits/${head}/check-runs?`);
        return json({ total_count: 0, check_runs: [] });
      }),
    ),
  ),
);
// PR #827, Actions job 125150736388: the log retains the assertion and subsequent cleanup.
const recordedJob = readFileSync(
  new URL("./fixtures/ci-failure/job.json", import.meta.url),
  "utf8",
);
const recordedArchive = readFileSync(new URL("./fixtures/ci-failure/logs.zip", import.meta.url));

const archiveResponse = (files: Record<string, string>) =>
  new Response(
    new Uint8Array(
      zipSync(
        Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])),
      ),
    ),
  );

const metadata = (steps: ReadonlyArray<{ name: string; conclusion: string }>, name = "ci") => ({
  name,
  run_id: 1,
  run_attempt: 2,
  steps: steps.map((step, index) => ({
    ...step,
    number: index + 1,
    started_at: "2026-11-02T10:00:01Z",
    completed_at: "2026-11-02T10:00:01Z",
  })),
});

for (const stepName of ["Run pnpm test", "Tests"]) {
  it.effect(`keeps the recorded assertion with step name ${stepName} without cleanup`, () =>
    Effect.gen(function* () {
      const evidence = yield* (yield* GitHubChecks).failures(repository, head);
      assert.deepStrictEqual(evidence.jobs, ["ci"]);
      assert.include(evidence.excerpt, `ci\n${stepName}\n`);
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
        withClient((url) => {
          if (url.includes("/logs")) {
            assert.include(url, "/actions/runs/41406855561/attempts/1/logs");
            return new Response(new Uint8Array(recordedArchive));
          }
          return url.includes("/actions/jobs/")
            ? new Response(
                stepName === "Run pnpm test"
                  ? recordedJob
                  : recordedJob.replace('"name": "Run pnpm test"', '"name": "Tests"'),
              )
            : json({
                total_count: 1,
                check_runs: [{ ...failedCheckRun, output: { text: null, summary: null } }],
              });
        }),
      ),
    ),
  );
}

for (const unavailable of ["not ready", "missing step", "corrupt archive"]) {
  it.effect(
    `keeps the failed matrix step while sibling jobs run and the archive is ${unavailable}`,
    () =>
      Effect.gen(function* () {
        const evidence = yield* (yield* GitHubChecks).failures(repository, head);
        assert.deepStrictEqual(evidence.jobs, ["test (server)"]);
        assert.include(evidence.excerpt, "Tests\n");
        assert.include(evidence.excerpt, "expected 2 to equal 1");
        assert.notInclude(evidence.excerpt, "successful setup");
        assert.notInclude(evidence.excerpt, "Post job cleanup");
      }).pipe(
        Effect.provide(
          withClient((url) => {
            if (url.includes("/attempts/")) {
              if (unavailable === "not ready") return new Response("not ready", { status: 404 });
              if (unavailable === "missing step") return archiveResponse({});
              return new Response("invalid ZIP");
            }
            if (url.endsWith("/actions/jobs/2/logs"))
              return new Response(
                [
                  "2026-11-02T10:00:00.0000000Z ##[group]Setup",
                  "2026-11-02T10:00:00.1000000Z successful setup",
                  "2026-11-02T10:00:01.0000000Z ##[group]Tests",
                  "2026-11-02T10:00:01.1000000Z FAIL expected 2 to equal 1",
                  "2026-11-02T10:00:02.0000000Z Post job cleanup.",
                ].join("\n"),
              );
            if (url.endsWith("/actions/jobs/2"))
              return json({
                name: "test (server)",
                run_id: 1,
                run_attempt: 2,
                steps: [
                  {
                    name: "Setup",
                    conclusion: "success",
                    number: 1,
                    started_at: "2026-11-02T10:00:00Z",
                    completed_at: "2026-11-02T10:00:00Z",
                  },
                  {
                    name: "Tests",
                    conclusion: "failure",
                    number: 2,
                    started_at: "2026-11-02T10:00:01Z",
                    completed_at: "2026-11-02T10:00:01Z",
                  },
                  {
                    name: "Post checkout",
                    conclusion: "success",
                    number: 3,
                    started_at: "2026-11-02T10:00:02Z",
                    completed_at: "2026-11-02T10:00:02Z",
                  },
                ],
              });
            return json({
              total_count: 2,
              check_runs: [
                { ...failedCheckRun, name: "test (server)" },
                { ...failedCheckRun, name: "test (web)", conclusion: null },
              ],
            });
          }),
        ),
      ),
  );
}

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
          return archiveResponse({
            ...Object.fromEntries(
              failures.map((failure, index) => [
                `ci/${index + 1}_Check.txt`,
                [
                  `2026-11-02T07:33:10.1000000Z preceding context ${"setup ".repeat(1000)}`,
                  `2026-11-02T07:33:10.2000000Z ${failure}`,
                  ...Array.from(
                    { length: 100 },
                    () => `2026-11-02T07:33:10.3000000Z ${"noise ".repeat(30)}`,
                  ),
                  "2026-11-02T07:33:15.1000000Z last line",
                ].join("\n"),
              ]),
            ),
            "ci/4_Upload.txt": "successful upload",
            "ci/5_Setup.txt": "successful setup",
          });
        if (url.includes("/actions/jobs/"))
          return json(
            metadata(
              ["Typecheck", "Lint", "Tests"].map((name) => ({ name, conclusion: "failure" })),
            ),
          );
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

for (const layout of ["numbered", "combined", "combined custom names"]) {
  for (const action of [
    "shell",
    "script",
    "script after success",
    "repeated script",
    "mixed repeated script",
  ]) {
    const firstCommand = action.includes("repeated script") ? "same-check" : "first-check";
    const secondCommand = action.includes("repeated script") ? "same-check" : "second-check";
    const firstName =
      layout !== "combined" && action !== "mixed repeated script"
        ? "First check"
        : `Run ${firstCommand}`;
    const secondName = layout !== "combined" ? "Second check" : `Run ${secondCommand}`;
    it.effect(
      `keeps ${action} failures separate in ${layout} logs within one timestamp second`,
      () =>
        Effect.gen(function* () {
          const evidence = yield* (yield* GitHubChecks).failures(repository, head);
          const [first, second] = evidence.excerpt.split(`\n\n${secondName}\n`);
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
              if (url.includes("/logs")) {
                const files = {
                  "ci/1_First.txt": [
                    `2026-11-02T10:00:01.1000000Z ##[group]Run ${firstCommand}`,
                    "2026-11-02T10:00:01.1100000Z ##[endgroup]",
                    "2026-11-02T10:00:01.2000000Z Error: first check failed",
                    ...(action === "shell"
                      ? [
                          "2026-11-02T10:00:01.2100000Z ##[error]Process completed with exit code 1.",
                        ]
                      : []),
                  ].join("\n"),
                  "ci/2_Success.txt":
                    action === "script after success"
                      ? [
                          "2026-11-02T10:00:01.2400000Z ##[group]Run successful-script",
                          "2026-11-02T10:00:01.2500000Z successful intervening script",
                        ].join("\n")
                      : "",
                  "ci/3_Second.txt": [
                    `2026-11-02T10:00:01.3000000Z ##[group]Run ${secondCommand}`,
                    "2026-11-02T10:00:01.3100000Z ##[endgroup]",
                    "2026-11-02T10:00:01.4000000Z ##[error]Error: second check failed",
                    "expected second result",
                    ...(action === "shell"
                      ? [
                          "2026-11-02T10:00:01.5000000Z ##[error]Process completed with exit code 2.",
                        ]
                      : []),
                  ].join("\n"),
                  "ci/4_Post.txt": "2026-11-02T10:00:01.6000000Z Post job cleanup.",
                };
                return archiveResponse(
                  layout === "numbered"
                    ? files
                    : {
                        "0_ci.txt": Object.values(files).join("\n"),
                        "0_other.txt": "unrelated failure",
                      },
                );
              }
              if (url.includes("/actions/jobs/"))
                return json({
                  ...metadata([
                    { name: firstName, conclusion: "failure" },
                    {
                      name:
                        layout === "combined custom names"
                          ? "Successful script"
                          : "Run successful-script",
                      conclusion: action === "script after success" ? "success" : "skipped",
                    },
                    { name: secondName, conclusion: "failure" },
                    { name: "Post Run actions/checkout@v7", conclusion: "success" },
                  ]),
                });
              return json(failedCheck);
            }),
          ),
        ),
    );
  }

  for (const action of ["shell", "script"]) {
    for (const followup of ["Post Run actions/checkout@v7", "Diagnostics"]) {
      const compositeName =
        layout !== "combined" ? "Composite checks" : "Run ./.github/actions/check";
      it.effect(
        `keeps embedded ${action} failures in ${layout} logs before same-second ${followup}`,
        () =>
          Effect.gen(function* () {
            const evidence = yield* (yield* GitHubChecks).failures(repository, head);
            assert.include(evidence.excerpt, compositeName);
            assert.include(evidence.excerpt, "##[error]Error: required file is missing");
            assert.include(evidence.excerpt, "expected required-file to exist");
            assert.include(evidence.excerpt, "final composite diagnostics");
            if (action === "shell")
              assert.include(evidence.excerpt, "Process completed with exit code 1");
            assert.notInclude(evidence.excerpt, "successful follow-up diagnostics");
            assert.notInclude(evidence.excerpt, "Post job cleanup");
            assert.notInclude(evidence.excerpt, "git config");
          }).pipe(
            Effect.provide(
              withClient((url) => {
                if (url.includes("/logs")) {
                  const files = {
                    "ci/1_Composite.txt": [
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
                        ? [
                            "2026-11-02T10:00:01.4000000Z ##[error]Process completed with exit code 1.",
                          ]
                        : []),
                      "2026-11-02T10:00:01.4100000Z ##[group]Run echo diagnostics",
                      "2026-11-02T10:00:01.4200000Z ##[endgroup]",
                      "2026-11-02T10:00:01.4300000Z final composite diagnostics",
                    ].join("\n"),
                    "ci/2_Diagnostics.txt": [
                      `2026-11-02T10:00:01.4400000Z ${followup.startsWith("Post ") ? "Post job cleanup." : "##[group]Run echo diagnostics"}`,
                      "2026-11-02T10:00:01.4500000Z successful follow-up diagnostics",
                    ].join("\n"),
                    "ci/3_Post.txt": [
                      "2026-11-02T10:00:01.5000000Z Post job cleanup.",
                      "2026-11-02T10:00:01.6000000Z git config --local --unset-all http.https://github.com/.extraheader",
                    ].join("\n"),
                  };
                  return archiveResponse(
                    layout === "numbered" ? files : { "0_ci.txt": Object.values(files).join("\n") },
                  );
                }
                if (url.includes("/actions/jobs/"))
                  return json(
                    metadata([
                      { name: compositeName, conclusion: "failure" },
                      {
                        name: followup === "Diagnostics" ? "Run echo diagnostics" : followup,
                        conclusion: "success",
                      },
                      { name: "Post Run actions/checkout@v7", conclusion: "success" },
                    ]),
                  );
                return json(failedCheck);
              }),
            ),
          ),
      );
    }
  }
}

for (const ambiguous of [false, true]) {
  it.effect(
    `handles custom follow-up names with ${ambiguous ? "ambiguous" : "unique"} combined boundaries`,
    () =>
      Effect.gen(function* () {
        const evidence = yield* (yield* GitHubChecks).failures(repository, head);
        assert.include(evidence.excerpt, ambiguous ? "Check summary" : "##[error]failed check");
        assert.notInclude(evidence.excerpt, "successful follow-up");
      }).pipe(
        Effect.provide(
          withClient((url) => {
            if (url.includes("/logs"))
              return archiveResponse({
                "0_ci.txt": [
                  "2026-11-02T10:00:01.1000000Z ##[group]Run check",
                  "2026-11-02T10:00:01.2000000Z ##[error]failed check",
                  ...(ambiguous
                    ? ["2026-11-02T10:00:01.2500000Z ##[group]Run embedded diagnostics"]
                    : []),
                  "2026-11-02T10:00:01.3000000Z ##[group]Run echo diagnostics",
                  "2026-11-02T10:00:01.4000000Z successful follow-up",
                ].join("\n"),
              });
            if (url.includes("/actions/jobs/"))
              return json(
                metadata([
                  { name: "Run check", conclusion: "failure" },
                  { name: "Custom diagnostics name", conclusion: "success" },
                ]),
              );
            return json(failedCheck);
          }),
        ),
      ),
  );
}

for (const logs of ["corrupt", "missing", "partial"]) {
  it.effect(`uses check output when the step archive is ${logs}`, () =>
    Effect.gen(function* () {
      const evidence = yield* (yield* GitHubChecks).failures(repository, head);
      assert.include(evidence.excerpt, "Check summary");
    }).pipe(
      Effect.provide(
        withClient((url) => {
          if (url.includes("/logs"))
            return logs === "corrupt"
              ? new Response("invalid ZIP")
              : archiveResponse(logs === "missing" ? {} : { "ci/1_First.txt": "first failure" });
          if (url.includes("/actions/jobs/"))
            return json(
              metadata([
                { name: "First", conclusion: "failure" },
                { name: "Second", conclusion: "failure" },
              ]),
            );
          return json(failedCheck);
        }),
      ),
    ),
  );
}

it.effect("matches numbered step files in sanitized job folders and excludes other jobs", () =>
  Effect.gen(function* () {
    const evidence = yield* (yield* GitHubChecks).failures(repository, head);
    assert.include(evidence.excerpt, "expected own result");
    assert.notInclude(evidence.excerpt, "unrelated failure");
  }).pipe(
    Effect.provide(
      withClient((url) => {
        if (url.includes("/logs"))
          return archiveResponse({
            [`${"check  matrix".repeat(10).slice(0, 90)}/1_Any filename.txt`]:
              "expected own result",
            "other-job/1_Check.txt": "unrelated failure",
          });
        if (url.includes("/actions/jobs/"))
          return json(
            metadata([{ name: "Check", conclusion: "failure" }], "check / matrix:".repeat(10)),
          );
        return json(failedCheck);
      }),
    ),
  ),
);

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

for (const endpoint of ["metadata", "logs", "completed job logs"]) {
  it.effect(`propagates rate limits from Actions ${endpoint} for the polling backoff`, () =>
    Effect.gen(function* () {
      const error = yield* (yield* GitHubChecks).failures(repository, head).pipe(Effect.flip);
      assert.strictEqual(error._tag, "GitHubRateLimitError");
    }).pipe(
      Effect.provide(
        withClient((url) => {
          if (url.includes("/actions/")) {
            if (endpoint === "completed job logs" && url.includes("/attempts/"))
              return new Response("not ready", { status: 404 });
            if ((endpoint === "metadata" && url.includes("/jobs/")) || url.includes("/logs"))
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

for (const endpoint of ["check-runs", "status", "actions/jobs/", "logs"]) {
  for (const status of [502, 503, 504]) {
    it.effect(`recovers CI evidence after ${endpoint} returns HTTP ${status}`, () => {
      let attempts = 0;
      return Effect.gen(function* () {
        const checks = yield* GitHubChecks;
        const pending = yield* checks.failures(repository, head).pipe(Effect.forkChild);
        yield* TestClock.adjust("10 seconds");
        const evidence = yield* Fiber.join(pending);
        assert.strictEqual(attempts, 2);
        assert.deepStrictEqual(evidence.jobs, [endpoint === "status" ? "external-ci" : "ci"]);
        assert.include(
          evidence.excerpt,
          endpoint === "status"
            ? "Build failed"
            : "expected -4391 to be greater than or equal to 0",
        );
      }).pipe(
        Effect.provide(
          withClient((url) => {
            if (url.includes(endpoint) && ++attempts === 1) return new Response(null, { status });
            if (url.includes("check-runs"))
              return json(endpoint === "status" ? { total_count: 0, check_runs: [] } : failedCheck);
            if (url.includes("/status"))
              return json({
                statuses: [
                  { context: "external-ci", state: "failure", description: "Build failed" },
                ],
              });
            if (url.includes("/actions/jobs/")) return new Response(recordedJob);
            return new Response(new Uint8Array(recordedArchive));
          }),
        ),
      );
    });
  }
}

for (const status of [403, 429, 503]) {
  it.effect(`bounds retries and preserves the CI error for HTTP ${status}`, () => {
    let attempts = 0;
    return Effect.gen(function* () {
      const checks = yield* GitHubChecks;
      const pending = yield* checks.failures(repository, head).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      const error = yield* Fiber.join(pending);
      assert.strictEqual(attempts, status === 503 ? 3 : 1);
      assert.strictEqual(error._tag, status === 429 ? "GitHubRateLimitError" : "GitHubApiError");
      if (error._tag === "GitHubApiError" || error._tag === "GitHubRateLimitError")
        assert.strictEqual(error.operation, "read-ci-checks");
      if (error._tag === "GitHubApiError")
        assert.deepStrictEqual(error.status, Option.some(status));
    }).pipe(
      Effect.provide(
        withClient(() => {
          attempts++;
          return new Response(null, {
            status,
            headers: status === 429 ? { "retry-after": "60" } : {},
          });
        }),
      ),
    );
  });
}

const workflowRun = (
  id: number,
  fields: {
    name: string;
    workflow: number;
    number: number;
    conclusion: string | null;
    event?: string;
  },
) => ({
  id,
  name: fields.name,
  workflow_id: fields.workflow,
  event: fields.event ?? "pull_request",
  run_number: fields.number,
  status: fields.conclusion === null ? "in_progress" : "completed",
  conclusion: fields.conclusion,
  html_url: `https://github.com/${repository}/actions/runs/${id}`,
});

const runJob = (conclusion: string | null) => ({
  name: `job-${conclusion ?? "running"}`,
  conclusion,
  started_at: "2026-11-04T18:20:00Z",
  completed_at: conclusion === null ? null : "2026-11-04T18:21:52Z",
});

it.effect("reports the latest failed workflow runs on a head whose jobs never failed", () => {
  const requested: Array<string> = [];
  return Effect.gen(function* () {
    const { incomplete: runs, running } = yield* (yield* GitHubChecks).workflowRuns(
      repository,
      head,
    );
    assert.deepStrictEqual(running, []);
    assert.deepStrictEqual(
      runs.map(({ id, workflow, conclusion }) => ({ id, workflow, conclusion })),
      [
        { id: 42672750451, workflow: "CI", conclusion: "failure" },
        { id: 42672750206, workflow: "Worker image", conclusion: "cancelled" },
      ],
    );
    assert.strictEqual(runs[0]?.url, `https://github.com/${repository}/actions/runs/42672750451`);
    assert.include(requested[0] ?? "", `/actions/runs?head_sha=${head}&per_page=100&page=1`);
    assert.notInclude(requested.join("\n"), "/runs/30/jobs");
    assert.notInclude(requested.join("\n"), "/runs/40/jobs");
    assert.notInclude(requested.join("\n"), "/runs/60/jobs");
  }).pipe(
    Effect.provide(
      withClient((url) => {
        requested.push(url);
        if (url.includes("/actions/runs?"))
          return json({
            total_count: 6,
            workflow_runs: [
              workflowRun(60, {
                name: "CI",
                workflow: 1,
                number: 10,
                conclusion: "success",
                event: "push",
              }),
              workflowRun(42672750451, {
                name: "CI",
                workflow: 1,
                number: 9,
                conclusion: "failure",
              }),
              workflowRun(30, { name: "CI", workflow: 1, number: 8, conclusion: "cancelled" }),
              workflowRun(42672750206, {
                name: "Worker image",
                workflow: 2,
                number: 4,
                conclusion: "cancelled",
              }),
              workflowRun(40, { name: "Docs", workflow: 3, number: 2, conclusion: "success" }),
              workflowRun(50, { name: "Lint", workflow: 4, number: 7, conclusion: "failure" }),
            ],
          });
        if (url.includes("/runs/50/jobs"))
          return json({ total_count: 2, jobs: [runJob("success"), runJob("failure")] });
        return json({ total_count: 2, jobs: [runJob("success"), runJob("skipped")] });
      }),
    ),
  );
});

it.effect("reports a latest workflow run that has not concluded after its jobs finished", () => {
  const requested: Array<string> = [];
  return Effect.gen(function* () {
    const { incomplete, running } = yield* (yield* GitHubChecks).workflowRuns(repository, head);
    assert.deepStrictEqual(incomplete, []);
    assert.deepStrictEqual(
      running.map(({ id, workflow, status, url }) => ({ id, workflow, status, url })),
      [
        {
          id: 42672750451,
          workflow: "CI",
          status: "in_progress",
          url: `https://github.com/${repository}/actions/runs/42672750451`,
        },
      ],
    );
    assert.notInclude(requested.join("\n"), "/jobs");
  }).pipe(
    Effect.provide(
      withClient((url) => {
        requested.push(url);
        return json({
          total_count: 2,
          workflow_runs: [
            workflowRun(42672750451, { name: "CI", workflow: 1, number: 9, conclusion: null }),
            workflowRun(40, { name: "Docs", workflow: 3, number: 2, conclusion: "success" }),
          ],
        });
      }),
    ),
  );
});
