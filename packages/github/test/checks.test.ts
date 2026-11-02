import { readFileSync } from "node:fs";
import { assert, it } from "@effect/vitest";
import { CommitSha, RepositoryName } from "@usine/core/repository";
import { ItemNumber } from "@usine/core/item";
import { DateTime, Effect, Layer, Redacted, type Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { strToU8, zipSync } from "fflate/browser";
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

for (const endpoint of ["metadata", "logs"]) {
  it.effect(`propagates rate limits from Actions ${endpoint} for the polling backoff`, () =>
    Effect.gen(function* () {
      const error = yield* (yield* GitHubChecks).failures(repository, head).pipe(Effect.flip);
      assert.strictEqual(error._tag, "GitHubRateLimitError");
    }).pipe(
      Effect.provide(
        withClient((url) => {
          if (url.includes("/actions/")) {
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
