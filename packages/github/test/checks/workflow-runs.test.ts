import { assert, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { GitHubChecks, type WorkflowJob } from "../../src/checks.ts";
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

const runJob = (conclusion: string | null, name = `job-${conclusion ?? "running"}`, id = 1) => ({
  id,
  name,
  status: conclusion === null ? "in_progress" : "completed",
  conclusion,
  started_at: "2026-11-04T18:20:00Z",
  completed_at: conclusion === null ? null : "2026-11-04T18:21:52Z",
});

it.effect("reports the latest failed or canceled workflow runs on a head with their jobs", () => {
  const requested: Array<string> = [];
  return Effect.gen(function* () {
    const { failed: runs, running } = yield* (yield* GitHubChecks).workflowRuns(repository, head);
    assert.deepStrictEqual(running, []);
    assert.deepStrictEqual(
      runs.map(({ id, workflow, conclusion, jobs }) => ({
        id,
        workflow,
        conclusion,
        failedJobs: jobs.filter(({ failed }) => failed).map(({ name }) => name),
      })),
      [
        { id: 42672750451, workflow: "CI", conclusion: "failure", failedJobs: [] },
        { id: 42672750206, workflow: "Worker image", conclusion: "cancelled", failedJobs: [] },
        { id: 50, workflow: "Lint", conclusion: "failure", failedJobs: ["job-failure"] },
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
    const { failed, running } = yield* (yield* GitHubChecks).workflowRuns(repository, head);
    assert.deepStrictEqual(failed, []);
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
    assert.deepStrictEqual(
      running[0]?.jobs.map(({ name, status }) => ({ name, status })),
      [
        { name: "job-success", status: "completed" },
        { name: "job-running", status: "in_progress" },
      ],
    );
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
const stalledJobs = [
  { ...runJob(null, "static", 11), status: "queued" },
  { ...runJob(null, "test (rest)", 12), status: "queued" },
  runJob("success", "test (web)", 13),
  runJob("failure", "ci", 14),
];

const jobFields = ({ id, name, status, conclusion, failed }: WorkflowJob) => ({
  id,
  name,
  status,
  conclusion,
  failed,
});

it.effect("reports the jobs of the latest attempt of a failed run and of a running run", () =>
  Effect.gen(function* () {
    const { failed, running } = yield* (yield* GitHubChecks).workflowRuns(repository, head);
    const stalled = [
      { id: 11, name: "static", status: "queued", conclusion: Option.none(), failed: false },
      { id: 12, name: "test (rest)", status: "queued", conclusion: Option.none(), failed: false },
      {
        id: 13,
        name: "test (web)",
        status: "completed",
        conclusion: Option.some("success"),
        failed: false,
      },
      { id: 14, name: "ci", status: "completed", conclusion: Option.some("failure"), failed: true },
    ];
    assert.deepStrictEqual(
      failed.map(({ id, conclusion, jobs }) => ({ id, conclusion, jobs: jobs.map(jobFields) })),
      [{ id: 43098104121, conclusion: "failure", jobs: stalled }],
    );
    assert.deepStrictEqual(
      running.map(({ id, status, jobs }) => ({ id, status, jobs: jobs.map(jobFields) })),
      [
        { id: 43098104122, status: "in_progress", jobs: stalled },
        { id: 43097310882, status: "queued", jobs: [] },
      ],
    );
  }).pipe(
    Effect.provide(
      withClient((url) => {
        if (url.includes("/runs/43098104121/jobs") || url.includes("/runs/43098104122/jobs"))
          return json({ total_count: 4, jobs: stalledJobs });
        if (url.includes("/jobs")) return json({ total_count: 0, jobs: [] });
        return json({
          total_count: 3,
          workflow_runs: [
            workflowRun(43098104121, {
              name: "CI",
              workflow: 1,
              number: 9,
              conclusion: "failure",
            }),
            workflowRun(43098104122, {
              name: "Worker image",
              workflow: 3,
              number: 4,
              conclusion: null,
            }),
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
