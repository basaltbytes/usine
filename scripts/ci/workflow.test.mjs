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

test("browser test jobs use preinstalled matching Playwright browsers and bounded execution", () => {
  const job = workflow.jobs.test;
  assert.ok(job["timeout-minutes"] > 0 && job["timeout-minutes"] <= 15);
  assert.equal(job.container, "${{ matrix.container }}");
  for (const name of ["web", "server"]) {
    const leg = job.strategy.matrix.include.find(({ leg }) => leg === name);
    const pkg = JSON.parse(
      readFileSync(new URL(`../../apps/${name}/package.json`, import.meta.url)),
    );
    assert.equal(
      leg.container,
      `mcr.microsoft.com/playwright:v${pkg.devDependencies.playwright}-noble`,
    );
  }
  for (const step of job.steps) {
    assert.doesNotMatch(
      step.run ?? "",
      /playwright install.*(?:--with-deps|install-deps)|playwright install-deps/u,
    );
    if (step.run?.includes("turbo run test") || step.run?.includes("playwright install")) {
      assert.ok(step["timeout-minutes"] > 0 && step["timeout-minutes"] <= 10);
    }
  }
});

test("browser test tasks receive the container's Playwright browser registry", () => {
  const plan = JSON.parse(
    execFileSync(
      "corepack",
      [
        "pnpm",
        "turbo",
        "run",
        "test",
        "--dry=json",
        "--filter=@usine/web",
        "--filter=@usine/server",
      ],
      {
        cwd: root,
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright" },
        encoding: "utf8",
      },
    ),
  );
  for (const name of ["web", "server"]) {
    const task = plan.tasks.find(({ taskId }) => taskId === `@usine/${name}#test`);
    assert.ok(
      task.environmentVariables.configured.some((value) =>
        value.startsWith("PLAYWRIGHT_BROWSERS_PATH="),
      ),
      `${name} must receive the container browser registry in Turbo's strict environment`,
    );
  }
});

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
