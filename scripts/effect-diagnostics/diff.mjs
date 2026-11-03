// Fails when any effect-baseline.json in the working tree allows more than the same file at a git
// ref: a file count above its count there, a rule total above its total there, or a baseline the
// ref doesn't have. A ref without any baseline passes: the baselines being compared are the first.
// Usage: node scripts/effect-diagnostics/diff.mjs <ref>
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fromDocument, raises } from "./baseline.mjs";

const ref = process.argv[2];
if (ref === undefined) {
  console.error("Usage: diff.mjs <ref>");
  process.exit(2);
}

const run = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" });
const top = run(["rev-parse", "--show-toplevel"]).trim();
const git = (args) => run(args, top);
const isBaseline = (path) =>
  path === "effect-baseline.json" || path.endsWith("/effect-baseline.json");
const baselines = git(["ls-files", "--cached", "--others", "--exclude-standard"])
  .split("\n")
  .filter(isBaseline);
const atRef = new Set(git(["ls-tree", "-r", "--name-only", ref]).split("\n").filter(isBaseline));

if (atRef.size === 0) {
  console.log(`${ref} has no Effect baselines, so the baselines here are the first ones.`);
  process.exit(0);
}

let failures = 0;
for (const path of baselines) {
  if (!existsSync(join(top, path))) continue;
  const head = fromDocument(JSON.parse(readFileSync(join(top, path), "utf8")));
  const base = atRef.has(path)
    ? fromDocument(JSON.parse(git(["show", `${ref}:${path}`])))
    : new Map();
  for (const raise of raises(base, head)) {
    failures++;
    const where = raise.file === undefined ? "total" : raise.file;
    console.error(`${path}: ${raise.rule} ${where} rose from ${raise.before} to ${raise.after}.`);
  }
}

if (failures > 0) {
  console.error(
    `${failures} Effect baseline counts rose against ${ref}. Fix the new violations instead.`,
  );
  process.exit(1);
}
console.log(`${baselines.length} Effect baselines checked against ${ref}; no count rose.`);
