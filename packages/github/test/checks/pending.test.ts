import { assert, it } from "@effect/vitest";
import { DateTime, Deferred, Effect, Fiber, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { GitHubChecks, PendingCheck, PendingCheckReport } from "../../src/checks.ts";
import { appLayer, head, json, repository, withClient } from "./support.ts";

const timeoutAt = DateTime.makeUnsafe("2026-11-05T20:25:00Z");
const historyDeadline = DateTime.makeUnsafe("2026-11-05T20:25:07Z");
const runningCheck = (name: string, run = 1) => ({
  name,
  status: "in_progress",
  started_at: "2026-11-05T19:54:00Z",
  details_url: `https://github.com/basaltbytes/usine/actions/runs/${run}/job/2`,
});
const queuedCheck = (name: string) => ({
  name,
  status: "queued",
  started_at: null,
  details_url: null,
});
const pendingRuns = (check_runs: ReadonlyArray<Schema.Json>) =>
  json({ total_count: check_runs.length, check_runs: [...check_runs] });
const previousJobs = () =>
  json({
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
const runningWeb = (previousDurationMilliseconds: Option.Option<number>, name = "test (web)") =>
  PendingCheck.make({
    name,
    status: "in_progress",
    startedAt: Option.some(DateTime.makeUnsafe("2026-11-05T19:54:00Z")),
    elapsedMilliseconds: Option.some(31 * 60000),
    previousDurationMilliseconds,
  });
const queued = (name: string) =>
  PendingCheck.make({
    name,
    status: "queued",
    startedAt: Option.none(),
    elapsedMilliseconds: Option.none(),
    previousDurationMilliseconds: Option.none(),
  });
const pendingDetails = Effect.gen(function* () {
  yield* TestClock.setTime(DateTime.toEpochMillis(timeoutAt));
  return yield* (yield* GitHubChecks).pendingDetails(repository, head, historyDeadline);
});

it.effect.each(["available", "missing", "forbidden"] as const)(
  "reports running checks before queued checks at timeout with %s duration history",
  (history) =>
    Effect.gen(function* () {
      const report = yield* pendingDetails;
      assert.deepStrictEqual(
        report,
        PendingCheckReport.make({
          checks: [
            runningWeb(history === "available" ? Option.some(6 * 60000) : Option.none()),
            queued("test (server)"),
          ],
          omitted: 0,
        }),
      );
    }).pipe(
      Effect.provide(
        withClient((url) => {
          if (url.includes("/check-runs?"))
            return pendingRuns([
              queuedCheck("test (server)"),
              runningCheck("test (web)"),
              { ...runningCheck("static"), status: "completed" },
            ]);
          if (history === "forbidden") return new Response("", { status: 403 });
          if (url.endsWith("/actions/runs/1"))
            return json({ workflow_id: 7, event: "pull_request" });
          if (url.includes("/actions/workflows/7/runs?")) {
            assert.include(url, "status=success&event=pull_request&");
            return json({ workflow_runs: history === "missing" ? [] : [{ id: 8 }] });
          }
          assert.include(url, "/actions/runs/8/jobs?");
          return previousJobs();
        }),
      ),
    ),
);

it.effect("lists a running job behind ten queued jobs and counts the checks it leaves out", () =>
  Effect.gen(function* () {
    const report = yield* pendingDetails;
    assert.deepStrictEqual(
      report.checks.map(({ name }) => name),
      ["test (web)", ...Array.from({ length: 9 }, (_, index) => `queued ${index}`)],
    );
    assert.strictEqual(report.omitted, 2);
  }).pipe(
    Effect.provide(
      withClient((url) => {
        if (url.includes("/check-runs?"))
          return pendingRuns([
            ...Array.from({ length: 11 }, (_, index) => queuedCheck(`queued ${index}`)),
            runningCheck("test (web)"),
          ]);
        if (url.endsWith("/actions/runs/1")) return json({ workflow_id: 7, event: "pull_request" });
        if (url.includes("/actions/workflows/7/runs?")) return json({ workflow_runs: [] });
        throw new Error(`Unexpected request ${url}`);
      }),
    ),
  ),
);

it.effect("reports pending commit statuses when no check run is pending", () =>
  Effect.gen(function* () {
    const report = yield* pendingDetails;
    assert.deepStrictEqual(
      report,
      PendingCheckReport.make({
        checks: [
          PendingCheck.make({
            name: "ci/jenkins",
            status: "pending",
            startedAt: Option.none(),
            elapsedMilliseconds: Option.none(),
            previousDurationMilliseconds: Option.none(),
          }),
        ],
        omitted: 0,
      }),
    );
  }).pipe(
    Effect.provide(
      withClient((url) => {
        if (url.includes("/check-runs?"))
          return pendingRuns([{ ...runningCheck("static"), status: "completed" }]);
        assert.include(url, `/commits/${head}/status?`);
        return json({
          statuses: [
            { context: "ci/jenkins", state: "pending", description: "Build queued" },
            { context: "ci/lint", state: "success", description: null },
          ],
        });
      }),
    ),
  ),
);

it.effect("reports missing checks without claiming that a job is running", () =>
  Effect.gen(function* () {
    const report = yield* pendingDetails;
    assert.deepStrictEqual(report, PendingCheckReport.make({ checks: [], omitted: 0 }));
  }).pipe(
    Effect.provide(
      withClient((url) => {
        if (url.includes(`/commits/${head}/check-runs?`)) return pendingRuns([]);
        assert.include(url, `/commits/${head}/status?`);
        return json({ statuses: [] });
      }),
    ),
  ),
);

it.effect("stops duration history reads at a rate limit and keeps the pending jobs", () => {
  const requested: Array<string> = [];
  return Effect.gen(function* () {
    const report = yield* pendingDetails;
    assert.deepStrictEqual(
      report,
      PendingCheckReport.make({
        checks: [runningWeb(Option.none()), runningWeb(Option.none(), "test (server)")],
        omitted: 0,
      }),
    );
    assert.deepStrictEqual(
      requested.filter((url) => url.includes("/actions/")),
      ["https://api.github.com/repos/basaltbytes/usine/actions/runs/1"],
    );
  }).pipe(
    Effect.provide(
      withClient((url) => {
        requested.push(url);
        if (url.includes("/check-runs?"))
          return pendingRuns([runningCheck("test (web)"), runningCheck("test (server)", 3)]);
        return new Response("rate limited", { status: 429, headers: { "retry-after": "60" } });
      }),
    ),
  );
});

it.effect("keeps the duration history read before its deadline when a later read stalls", () =>
  Effect.gen(function* () {
    const stalled = yield* Deferred.make<void>();
    const client = HttpClient.make((request) => {
      const url = request.url;
      const respond = (response: Response) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, response));
      if (url.includes("/check-runs?"))
        return respond(pendingRuns([runningCheck("test (web)"), runningCheck("test (server)", 3)]));
      if (url.endsWith("/actions/runs/1"))
        return respond(json({ workflow_id: 7, event: "pull_request" }));
      if (url.includes("/actions/workflows/7/runs?"))
        return respond(json({ workflow_runs: [{ id: 8 }] }));
      if (url.includes("/actions/runs/8/jobs?")) return respond(previousJobs());
      return Deferred.succeed(stalled, undefined).pipe(Effect.andThen(Effect.never));
    });
    const report = yield* pendingDetails.pipe(
      Effect.provide(
        GitHubChecks.layer.pipe(
          Layer.provide(appLayer),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        ),
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(stalled);
    yield* TestClock.adjust("7 seconds");
    const expected = PendingCheckReport.make({
      checks: [runningWeb(Option.some(6 * 60000)), runningWeb(Option.none(), "test (server)")],
      omitted: 0,
    });
    const read = yield* Fiber.join(report);
    assert.deepStrictEqual(read, expected);
  }),
);

// PR #827, Actions job 125150736388: the log retains the assertion and subsequent cleanup.
