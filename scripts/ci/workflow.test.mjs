import assert from "node:assert/strict";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
);
const root = new URL("../../", import.meta.url);
const testTasks = (plan) =>
  plan.tasks.filter(({ task }) => task === "test").map(({ taskId }) => taskId);

test("the CI matrix runs every package test task exactly once", () => {
  const expected = testTasks(
    JSON.parse(
      execFileSync("corepack", ["pnpm", "turbo", "run", "test", "--dry=json"], {
        cwd: root,
        encoding: "utf8",
      }),
    ),
  );
  const actual = workflow.jobs.test.strategy.matrix.include.flatMap((leg) =>
    testTasks(
      JSON.parse(
        execSync(
          `corepack pnpm turbo run test --dry=json --concurrency=1 ${leg.filters} ${leg.args ?? ""}`,
          {
            cwd: root,
            encoding: "utf8",
          },
        ),
      ),
    ),
  );
  assert.deepEqual(actual.sort(), expected.sort());
});

test("the CI aggregate fails for failed or cancelled dependencies, including matrix failures", () => {
  const gate = workflow.jobs.ci;
  for (const dependency of gate.needs) {
    for (const result of ["success", "skipped", "failure", "cancelled"]) {
      const needs = Object.fromEntries(
        gate.needs.map((name) => [
          name,
          {
            result: name === dependency ? result : "success",
          },
        ]),
      );
      const check = spawnSync("bash", ["-e", "-o", "pipefail", "-c", gate.steps[0].run], {
        env: { ...process.env, RESULTS: JSON.stringify(needs) },
        encoding: "utf8",
      });
      assert.equal(
        check.status === 0,
        result === "success" || result === "skipped",
        `${dependency}: ${result}\n${check.stderr}`,
      );
    }
  }
});
