import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
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
