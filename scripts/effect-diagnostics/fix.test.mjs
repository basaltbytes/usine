import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const fixture = async (t, rules, program) => {
  const root = await mkdtemp(join(tmpdir(), "usine-effect-fix-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ["scripts/effect-diagnostics", "tooling/oxlint", "node_modules/.bin"])
    await mkdir(join(root, directory), { recursive: true });
  await copyFile(
    new URL("./fix.mjs", import.meta.url),
    join(root, "scripts/effect-diagnostics/fix.mjs"),
  );
  await writeFile(join(root, "tooling/oxlint/effect-fix.json"), JSON.stringify({ rules }));
  await writeFile(
    join(root, "node_modules/.bin/effect-tsgo"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(args[args.indexOf("-c") + 1], "utf8"));
const rule = Object.keys(config.rules)[0];
const fixing = args.includes("--fix-suggestions");
const report = (files) => {
  console.log(JSON.stringify({ diagnostics: files.map((filename) => ({ filename, code: rule.replace("effecttsgo/", "effecttsgo(") + ")" })) }));
  process.exit(files.length > 0 ? 1 : 0);
};
${program}
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(root, "node_modules/.bin/oxfmt"),
    `#!/usr/bin/env node
require("node:fs").writeFileSync("formatted.json", JSON.stringify(process.argv.slice(2)));
`,
    { mode: 0o755 },
  );
  for (const file of ["changed.ts", "crash.ts", "unchanged.ts", "unrelated.js"])
    await writeFile(join(root, file), "before\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  await writeFile(join(root, "unchanged.ts"), "existing local edit\n");
  return {
    read: (file) => readFile(join(root, file), "utf8"),
    run: () =>
      spawnSync(process.execPath, ["scripts/effect-diagnostics/fix.mjs"], {
        cwd: root,
        encoding: "utf8",
      }),
  };
};

test("an autofixer crash fails with its stderr instead of reporting success", async (t) => {
  const project = await fixture(
    t,
    { "effecttsgo/new-schema-class": "error" },
    `if (!fixing) report(["changed.ts"]);
process.stderr.write("panic: fixer failed\\n");
process.exit(2);`,
  );
  const result = project.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /panic: fixer failed/u);
  assert.match(result.stderr, /exited with 2/u);
  await assert.rejects(project.read("formatted.json"), { code: "ENOENT" });
});

test("rules run separately and only files changed by fixes are formatted", async (t) => {
  const project = await fixture(
    t,
    { "effecttsgo/new-schema-class": "error", "effecttsgo/multiple-effect-provide": "error" },
    `if (!fixing && Object.keys(config.rules).length > 1) {
  console.log(JSON.stringify({ diagnostics: [
    { filename: "changed.ts", code: "effecttsgo(new-schema-class)" },
    { filename: "crash.ts", code: "effecttsgo(multiple-effect-provide)" },
    { filename: "changed.ts", code: "effecttsgo(multiple-effect-provide)" },
  ] }));
  process.exit(1);
}
if (rule === "effecttsgo/new-schema-class") {
  if (!fixing) report(["changed.ts"]);
  if (fs.readFileSync("changed.ts", "utf8") === "before\\n") fs.writeFileSync("changed.ts", "fixed\\n");
  report([]);
}
if (!fixing) report(["crash.ts", "changed.ts"]);
if (args.at(-1) === "crash.ts") {
  fs.writeFileSync("crash.ts", "partial fix\\n");
  process.stderr.write("panic: Debug failure. False expression.\\ninternal/fixables.runMultipleEffectProvideFix\\n");
  process.exit(1);
}
fs.writeFileSync("changed.ts", "both rules fixed\\n");
report([]);`,
  );
  const result = project.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await project.read("changed.ts"), "both rules fixed\n");
  assert.equal(await project.read("crash.ts"), "before\n");
  assert.equal(await project.read("unchanged.ts"), "existing local edit\n");
  assert.deepEqual(JSON.parse(await project.read("formatted.json")), ["changed.ts"]);
  assert.match(result.stdout, /files skipped after the upstream crash:\ncrash.ts/u);
});

test("a different multiple-effect-provide failure is fatal", async (t) => {
  const project = await fixture(
    t,
    { "effecttsgo/multiple-effect-provide": "error" },
    `if (!fixing) report(["crash.ts"]);
process.stderr.write("configuration error\\n");
process.exit(1);`,
  );
  const result = project.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /configuration error/u);
});

test("overlapping fixes converge when Oxlint reports remaining lint errors with exit 1", async (t) => {
  const project = await fixture(
    t,
    { "effecttsgo/new-schema-class": "error" },
    `const content = fs.readFileSync("changed.ts", "utf8");
if (!fixing) report(content === "done" ? [] : ["changed.ts"]);
fs.writeFileSync("changed.ts", content === "before\\n" ? "partial" : "done");
report(content === "before\\n" ? ["changed.ts"] : []);`,
  );
  const result = project.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await project.read("changed.ts"), "done");
  assert.deepEqual(JSON.parse(await project.read("formatted.json")), ["changed.ts"]);
});
