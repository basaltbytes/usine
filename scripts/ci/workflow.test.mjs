import assert from "node:assert/strict";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      leg.container.image,
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

test("the server container reaps detached processes and installs its required CLI tools", () => {
  const job = workflow.jobs.test;
  const server = job.strategy.matrix.include.find(({ leg }) => leg === "server");
  assert.ok(server.container.options.split(/\s+/u).includes("--init"));
  const testIndex = job.steps.findIndex(({ run }) => run?.includes("turbo run test"));
  const setupIndex = job.steps.findIndex(
    ({ run, if: condition }) => condition === "matrix.leg == 'server'" && run?.includes("apt-get"),
  );
  assert.ok(setupIndex >= 0 && setupIndex < testIndex);
  const tests = job.steps[testIndex];
  assert.match(tests.run, /if \[ "\$\{\{ matrix.leg \}\}" = server \]; then/u);
  assert.match(tests.run, /chown -R pwuser:pwuser "\$GITHUB_WORKSPACE"/u);
  assert.match(tests.run, /runuser -u pwuser -- env "PATH=\$PATH" pnpm turbo run test/u);
  const setup = job.steps[setupIndex];
  assert.ok(setup["timeout-minutes"] > 0 && setup["timeout-minutes"] <= 5);
  for (const tool of ["jq", "lsof"]) {
    assert.match(setup.run, new RegExp(`apt-get [^\\n]*install[^\\n]*\\b${tool}\\b`, "u"));
  }
});

test("the server test tools install from a per-image cache before any apt mirror", () => {
  const steps = workflow.jobs.test.steps;
  const setupIndex = steps.findIndex(({ name }) => name === "Install server test tools");
  const saveIndex = steps.findIndex(
    ({ uses, if: condition }) =>
      uses?.startsWith("actions/cache/save@") && condition?.includes("matrix.leg == 'server'"),
  );
  const restore = steps.find(({ id }) => id === "server-tools");
  const setup = steps[setupIndex];
  const save = steps[saveIndex];
  assert.ok(restore.uses.startsWith("actions/cache/restore@"));
  assert.ok(steps.indexOf(restore) < setupIndex && setupIndex < saveIndex);
  assert.equal(restore.if, "matrix.leg == 'server'");
  assert.match(restore.with.key, /\$\{\{ matrix\.container\.image \}\}/u);
  for (const tool of ["jq", "lsof"])
    assert.match(restore.with.key, new RegExp(`\\b${tool}\\b`, "u"));
  assert.equal(setup.env.CACHE_HIT, "${{ steps.server-tools.outputs.cache-hit }}");
  assert.equal(setup.env.DEBS, restore.with.path);
  assert.equal(save.with.path, restore.with.path);
  assert.equal(save.with.key, "${{ steps.server-tools.outputs.cache-primary-key }}");
  assert.match(save.if, /steps\.server-tools\.outputs\.cache-hit != 'true'/u);
  assert.match(setup.env.APT_OPTIONS, /Acquire::Retries=\d+/u);
  assert.match(setup.env.APT_OPTIONS, /Acquire::http::Timeout=\d+/u);

  // The apt-get stub mirrors real apt: a failed index fetch only warns and exits 0
  // unless --error-on=any is set, and a missing package index fails the download.
  const install = ({ cacheHit, failedUpdates, packagesIndexed = false }) => {
    const scratch = mkdtempSync(join(tmpdir(), "server-tools-"));
    try {
      const bin = join(scratch, "bin");
      const debs = join(scratch, "debs");
      const calls = join(scratch, "calls");
      const state = join(scratch, "failed-updates");
      const lists = join(scratch, "lists");
      mkdirSync(bin);
      mkdirSync(debs);
      writeFileSync(state, "0");
      writeFileSync(lists, "missing");
      if (cacheHit) writeFileSync(join(debs, "jq.deb"), "");
      const stub = (name, body) =>
        writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${calls}"\n${body}\n`, {
          mode: 0o755,
        });
      stub(
        "apt-get",
        `case " $* " in
  *" update "*)
    failed=$(cat "${state}")
    if [ "$failed" -lt ${failedUpdates} ]; then
      echo $((failed + 1)) > "${state}"
      echo "W: Some index files failed to download." >&2
      case " $* " in *" --error-on=any "*) exit 100 ;; esac
      echo ${packagesIndexed ? "present" : "missing"} > "${lists}"
    else
      echo present > "${lists}"
    fi ;;
  *" --download-only "*)
    if [ "$(cat "${lists}")" != present ]; then echo "E: Unable to locate package jq" >&2; exit 100; fi
    touch "${debs}/jq.deb" "${debs}/lsof.deb" ;;
esac`,
      );
      stub("dpkg", "");
      stub("sleep", "");
      const result = spawnSync("sh", ["-e", "-c", setup.run], {
        env: {
          ...process.env,
          ...setup.env,
          CACHE_HIT: cacheHit ? "true" : "",
          DEBS: debs,
          PATH: `${bin}:${process.env.PATH}`,
        },
        encoding: "utf8",
      });
      const log = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
      return { status: result.status, log };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };

  const hit = install({ cacheHit: true, failedUpdates: 0 });
  assert.equal(hit.status, 0);
  assert.ok(
    hit.log.every((call) => !call.startsWith("apt-get")),
    hit.log.join("\n"),
  );
  assert.ok(hit.log.some((call) => call.startsWith("dpkg -i") && call.endsWith("jq.deb")));

  const updates = (log) => log.filter((call) => call.endsWith(" update"));

  const flakyMirror = install({ cacheHit: false, failedUpdates: 2 });
  assert.equal(flakyMirror.status, 0, flakyMirror.log.join("\n"));
  assert.equal(updates(flakyMirror.log).length, 3);
  assert.ok(
    updates(flakyMirror.log)
      .slice(0, 2)
      .every((call) => call.includes(" --error-on=any ")),
  );
  assert.ok(flakyMirror.log.some((call) => /--download-only.*\bjq lsof$/u.test(call)));
  assert.ok(flakyMirror.log.at(-1).startsWith("dpkg -i"));

  // A source that stays down (security.ubuntu.com) while the main archive serves jq and lsof.
  const partialMirror = install({ cacheHit: false, failedUpdates: 3, packagesIndexed: true });
  assert.equal(partialMirror.status, 0, partialMirror.log.join("\n"));
  assert.equal(updates(partialMirror.log).length, 3);
  assert.ok(!updates(partialMirror.log).at(-1).includes("--error-on=any"));
  assert.ok(partialMirror.log.at(-1).startsWith("dpkg -i"));

  const downMirror = install({ cacheHit: false, failedUpdates: 3 });
  assert.notEqual(downMirror.status, 0);
  assert.equal(updates(downMirror.log).length, 3);
  assert.ok(downMirror.log.every((call) => !call.startsWith("dpkg")));
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
