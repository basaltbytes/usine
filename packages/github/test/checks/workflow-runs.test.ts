import { assert, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { GitHubChecks } from "../../src/checks.ts";
import { head, json, repository, withClient } from "./support.ts";

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

const runJob = (conclusion: string | null, name = `job-${conclusion ?? "running"}`) => ({
  name,
  status: conclusion === null ? "in_progress" : "completed",
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
    assert.isTrue(Option.isNone(running[0]?.loneFailure ?? Option.none()));
    assert.include(requested.join("\n"), "/runs/42672750451/jobs");
  }).pipe(
    Effect.provide(
      withClient((url) => {
        requested.push(url);
        if (url.includes("/jobs"))
          return json({ total_count: 2, jobs: [runJob("success"), runJob(null)] });
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

// The jobs of CI run 43098104121 on 2026-11-11: the gate job failed because the jobs it needs
// stayed queued after GitHub Actions stalled.
const stalledJobs = (gate: string | null) => [
  { ...runJob(null, "static"), status: "queued" },
  { ...runJob(null, "test (rest)"), status: "queued" },
  runJob("success", "test (web)"),
  runJob(gate, "ci"),
];

it.effect(
  "reports a concluded run whose only failed job failed while other jobs stayed queued",
  () =>
    Effect.gen(function* () {
      const { incomplete, running } = yield* (yield* GitHubChecks).workflowRuns(repository, head);
      assert.deepStrictEqual(running, []);
      assert.deepStrictEqual(
        incomplete.map(({ id, conclusion, loneFailure }) => ({
          id,
          conclusion,
          loneFailure: Option.map(loneFailure, ({ job, unfinished }) => ({ job, unfinished })),
        })),
        [
          {
            id: 43098104121,
            conclusion: "failure",
            loneFailure: Option.some({ job: "ci", unfinished: ["static", "test (rest)"] }),
          },
        ],
      );
    }).pipe(
      Effect.provide(
        withClient((url) => {
          if (url.includes("/runs/43098104121/jobs"))
            return json({ total_count: 4, jobs: stalledJobs("failure") });
          if (url.includes("/runs/50/jobs"))
            return json({
              total_count: 2,
              jobs: [runJob("success", "lint"), runJob("failure", "test")],
            });
          return json({
            total_count: 2,
            workflow_runs: [
              workflowRun(43098104121, {
                name: "CI",
                workflow: 1,
                number: 9,
                conclusion: "failure",
              }),
              workflowRun(50, { name: "Lint", workflow: 4, number: 7, conclusion: "failure" }),
            ],
          });
        }),
      ),
    ),
);

it.effect.each([
  { sibling: "queued", lone: true },
  { sibling: "in_progress", lone: false },
])(
  "reports a lone failed job of a running run only while a sibling is $sibling",
  ({ sibling, lone }) =>
    Effect.gen(function* () {
      const { incomplete, running } = yield* (yield* GitHubChecks).workflowRuns(repository, head);
      assert.deepStrictEqual(incomplete, []);
      assert.deepStrictEqual(
        running.map(({ status, loneFailure }) => ({
          status,
          loneFailure: Option.map(loneFailure, ({ job, unfinished }) => ({ job, unfinished })),
        })),
        [
          {
            status: "in_progress",
            loneFailure: lone ? Option.some({ job: "ci", unfinished: ["static"] }) : Option.none(),
          },
          { status: "queued", loneFailure: Option.none() },
        ],
      );
    }).pipe(
      Effect.provide(
        withClient((url) => {
          if (url.includes("/runs/43098104121/jobs"))
            return json({
              total_count: 3,
              jobs: [
                { ...runJob(null, "static"), status: sibling },
                runJob("success", "test (web)"),
                runJob("failure", "ci"),
              ],
            });
          if (url.includes("/jobs")) return json({ total_count: 0, jobs: [] });
          return json({
            total_count: 2,
            workflow_runs: [
              workflowRun(43098104121, { name: "CI", workflow: 1, number: 9, conclusion: null }),
              {
                ...workflowRun(43097310882, {
                  name: "Docs",
                  workflow: 2,
                  number: 3,
                  conclusion: null,
                }),
                status: "queued",
              },
            ],
          });
        }),
      ),
    ),
);
