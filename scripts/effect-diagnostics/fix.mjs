// Applies each configured Effect autofix until a pass changes no files, then formats changed files.
// Usage, from the repository root: node scripts/effect-diagnostics/fix.mjs [paths...]
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const bin = (name) => resolve(root, "node_modules/.bin", name);
const paths = process.argv.slice(2);
const maxPasses = 10;
const config = JSON.parse(readFileSync(join(root, "tooling/oxlint/effect-fix.json"), "utf8"));
const temporary = mkdtempSync(join(tmpdir(), "usine-effect-fix-"));
const configPath = join(temporary, "rules.json");
const crashing = new Set();

const run = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  return result;
};

const failed = (result) => {
  throw new Error(
    `Command exited with ${result.signal ?? result.status}.\n${result.stderr}${result.stdout}`,
  );
};

const files = run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
if (files.status !== 0) failed(files);
const sources = [...new Set(files.stdout.split("\0"))].filter(
  (file) => /\.[cm]?[jt]sx?$/u.test(file) && existsSync(join(root, file)),
);
const snapshot = () =>
  new Map(sources.map((file) => [file, readFileSync(join(root, file), "utf8")]));
const changedSince = (before) =>
  sources.filter((file) => before.get(file) !== readFileSync(join(root, file), "utf8"));
const initial = snapshot();

const lint = (rules, targets, fix) => {
  // Exclude Oxlint's default correctness rules from this Effect-only codemod.
  writeFileSync(
    configPath,
    JSON.stringify({ ...config, $schema: undefined, categories: { correctness: "off" }, rules }),
  );
  return run(bin("effect-tsgo"), [
    "oxlint",
    "-c",
    configPath,
    "--format",
    "json",
    ...(fix ? ["--fix-suggestions"] : []),
    ...targets,
  ]);
};

const diagnostics = (result) => {
  // Oxlint exits 1 for unfixed lint errors, including overlapping fixes and unfixable JS types.
  // Only a structured diagnostic result is recoverable; a tool failure must propagate.
  if (result.status !== 0 && (result.status !== 1 || result.stderr !== "")) failed(result);
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    failed(result);
  }
  if (!Array.isArray(report.diagnostics)) failed(result);
  if (result.status !== 0 && report.diagnostics.length === 0) failed(result);
  for (const diagnostic of report.diagnostics) {
    const rule = diagnostic.code?.replace(/^effecttsgo\((.+)\)$/u, "effecttsgo/$1");
    if (!Object.hasOwn(config.rules, rule) || !sources.includes(diagnostic.filename))
      failed(result);
  }
  return report.diagnostics;
};

const fix = (rule, targets) => {
  const before = snapshot();
  const result = lint({ [rule]: config.rules[rule] }, targets, true);
  if (
    result.status !== 0 &&
    rule === "effecttsgo/multiple-effect-provide" &&
    result.stderr.includes("panic: Debug failure. False expression.") &&
    result.stderr.includes("runMultipleEffectProvideFix")
  ) {
    for (const file of changedSince(before)) writeFileSync(join(root, file), before.get(file));
    crashing.add(targets[0]);
    console.error(`Skipped ${rule} in ${targets[0]}:\n${result.stderr}`);
    return;
  }
  const remaining = diagnostics(result);
  console.log(
    `${rule}: changed ${changedSince(before).length} files; ${remaining.length} diagnostics remain.`,
  );
};

try {
  for (let count = 1; count <= maxPasses; count++) {
    const before = snapshot();
    const found = diagnostics(lint(config.rules, paths, false));
    for (const rule of Object.keys(config.rules)) {
      const code = rule.replace(/^effecttsgo\/(.+)$/u, "effecttsgo($1)");
      const targets = [
        ...new Set(found.filter((item) => item.code === code).map((item) => item.filename)),
      ];
      if (rule === "effecttsgo/multiple-effect-provide") {
        for (const file of targets) if (!crashing.has(file)) fix(rule, [file]);
      } else if (targets.length > 0) fix(rule, targets);
    }
    const changed = changedSince(before);
    console.log(`Pass ${count} changed ${changed.length} files.`);
    if (changed.length === 0) break;
    if (count === maxPasses)
      throw new Error(`Autofixes still change files after ${maxPasses} passes.`);
  }
  const changed = changedSince(initial);
  if (changed.length > 0) {
    const format = run(bin("oxfmt"), changed);
    if (format.status !== 0) failed(format);
    console.log(`Formatted ${changed.length} changed files.`);
  }
  if (crashing.size > 0)
    console.log(
      `multipleEffectProvide files skipped after the upstream crash:\n${[...crashing].sort().join("\n")}`,
    );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
