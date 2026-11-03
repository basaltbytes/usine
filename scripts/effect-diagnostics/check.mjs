// Type-checks a package with the Effect-patched tsc and holds its Effect diagnostics to the
// package's effect-baseline.json. The rules for changing the baseline are in baseline.mjs.
// Usage, from a package directory:
//   node ../../scripts/effect-diagnostics/check.mjs [--update] <tsconfig>...
// --update rewrites the baseline from the current counts as far as shrink allows, and writes the
// first baseline when the package has none.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import getExePath from "@effect/tsgo/lib/getExePath";
import { countDiagnostics, fromDocument, sameCounts, shrink, toDocument } from "./baseline.mjs";

const baselineFile = "effect-baseline.json";
const compiler = getExePath();
const header = /^(.+)\((\d+),(\d+)\): (error|warning|suggestion|message) TS(\d+): /;
const global = /^(error|warning) TS\d+: /;
const effectRule = / effect\(([A-Za-z]+)\)$/;

const args = process.argv.slice(2);
const update = args.includes("--update");
const projects = args.filter((arg) => arg !== "--update");
if (projects.length === 0) {
  console.error("Usage: check.mjs [--update] <tsconfig>...");
  process.exit(2);
}

const packageDirectory = process.cwd();

const typeCheck = (project) => {
  const result = spawnSync(compiler, ["-p", project, "--pretty", "false"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  const output = `${result.stdout}${result.stderr}`;
  const diagnostics = [];
  for (const line of output.split("\n")) {
    if (header.test(line) || global.test(line)) diagnostics.push(line);
    else if (diagnostics.length > 0 && line.trim() !== "")
      diagnostics[diagnostics.length - 1] += ` ${line.trim()}`;
  }
  if (result.status !== 0 && diagnostics.length === 0) {
    console.error(output);
    console.error(`effect-tsgo exited with status ${result.status} for ${project}.`);
    process.exit(1);
  }
  return diagnostics;
};

const ownFile = (file) => {
  const path = relative(packageDirectory, resolve(packageDirectory, file));
  return path.startsWith("..") || isAbsolute(path) ? undefined : path;
};

const compilerErrors = [];
const effect = [];
const seen = new Set();
for (const project of projects) {
  for (const text of typeCheck(project)) {
    const located = header.exec(text);
    if (located === null) {
      compilerErrors.push(text);
      continue;
    }
    const [, reported, , , severity] = located;
    const rule = effectRule.exec(text)?.[1];
    if (rule === undefined) {
      if (severity === "error") compilerErrors.push(text);
      continue;
    }
    if (severity === "suggestion" || severity === "message") continue;
    const file = ownFile(reported);
    if (file === undefined || seen.has(`${file} ${text}`)) continue;
    seen.add(`${file} ${text}`);
    effect.push({ rule, file, text });
  }
}

if (compilerErrors.length > 0) {
  console.error(compilerErrors.join("\n"));
  console.error(`${compilerErrors.length} TypeScript or configuration errors.`);
  process.exit(1);
}

const current = countDiagnostics(effect);
const baseline = existsSync(baselineFile)
  ? fromDocument(JSON.parse(readFileSync(baselineFile, "utf8")))
  : undefined;
const { next, uncovered } =
  update && baseline === undefined
    ? { next: current, uncovered: [] }
    : shrink(baseline ?? new Map(), current);

for (const { rule, file, count, allowed } of uncovered) {
  console.error(`${file}: ${count} ${rule} diagnostics, baseline allows ${allowed}:`);
  for (const diagnostic of effect)
    if (diagnostic.rule === rule && diagnostic.file === file) console.error(`  ${diagnostic.text}`);
}

const total = effect.length;
if (update) {
  const document = toDocument(next);
  if (Object.keys(document).length === 0) rmSync(baselineFile, { force: true });
  else writeFileSync(baselineFile, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`${total} Effect diagnostics, ${uncovered.length} baseline entries exceeded.`);
  process.exit(uncovered.length > 0 ? 1 : 0);
}

const matches = sameCounts(baseline ?? new Map(), current);
if (!matches && uncovered.length === 0)
  console.error(
    `${baselineFile} differs from the current counts. Run pnpm effect:baseline and commit the result.`,
  );
console.log(`${total} Effect diagnostics, ${uncovered.length} baseline entries exceeded.`);
process.exit(matches ? 0 : 1);
