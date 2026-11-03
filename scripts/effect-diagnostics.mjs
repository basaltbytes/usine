// Type-checks a package with the Effect-patched tsc and holds its Effect diagnostics to the
// package's effect-baseline.json, which records a count per file and rule and may only shrink.
// Usage, from a package directory:
//   node ../../scripts/effect-diagnostics.mjs [--update] <tsconfig>...
// --update lowers baseline counts to the current ones and never raises them; it writes the
// first baseline when the package has none.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const baselineFile = "effect-baseline.json";
const compiler = resolve(import.meta.dirname, "../node_modules/.bin/effect-tsgo");
const header = /^(.+)\((\d+),(\d+)\): (error|warning|suggestion|message) TS(\d+): /;
const global = /^(error|warning) TS\d+: /;
const effectRule = / effect\(([A-Za-z]+)\)$/;

const args = process.argv.slice(2);
const update = args.includes("--update");
const projects = args.filter((arg) => arg !== "--update");
if (projects.length === 0) {
  console.error("Usage: effect-diagnostics.mjs [--update] <tsconfig>...");
  process.exit(2);
}

const packageDirectory = process.cwd();

const typeCheck = (project) => {
  const result = spawnSync(compiler, ["tsc", "-p", project, "--pretty", "false"], {
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
const effect = new Map();
const seen = new Set();
for (const project of projects) {
  for (const diagnostic of typeCheck(project)) {
    const located = header.exec(diagnostic);
    if (located === null) {
      compilerErrors.push(diagnostic);
      continue;
    }
    const [, file, , , severity] = located;
    const rule = effectRule.exec(diagnostic)?.[1];
    if (rule === undefined) {
      if (severity === "error") compilerErrors.push(diagnostic);
      continue;
    }
    if (severity === "suggestion" || severity === "message") continue;
    const path = ownFile(file);
    if (path === undefined || seen.has(`${path} ${diagnostic}`)) continue;
    seen.add(`${path} ${diagnostic}`);
    const key = JSON.stringify([path, rule]);
    effect.set(key, [...(effect.get(key) ?? []), diagnostic]);
  }
}

if (compilerErrors.length > 0) {
  console.error(compilerErrors.join("\n"));
  console.error(`${compilerErrors.length} TypeScript or configuration errors.`);
  process.exit(1);
}

const baseline = existsSync(baselineFile)
  ? new Map(
      Object.entries(JSON.parse(readFileSync(baselineFile, "utf8"))).flatMap(([file, rules]) =>
        Object.entries(rules).map(([rule, count]) => [JSON.stringify([file, rule]), count]),
      ),
    )
  : undefined;

const write = (counts) => {
  const document = {};
  for (const [key, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    if (count === 0) continue;
    const [file, rule] = JSON.parse(key);
    document[file] = { ...document[file], [rule]: count };
  }
  if (Object.keys(document).length === 0) rmSync(baselineFile, { force: true });
  else writeFileSync(baselineFile, `${JSON.stringify(document, null, 2)}\n`);
};

const current = new Map([...effect].map(([key, diagnostics]) => [key, diagnostics.length]));

if (update) {
  const next =
    baseline === undefined
      ? current
      : new Map([...baseline].map(([key, count]) => [key, Math.min(count, current.get(key) ?? 0)]));
  write(next);
}

const allowed = update && baseline === undefined ? current : (baseline ?? new Map());
const added = [...effect].filter(
  ([key, diagnostics]) => diagnostics.length > (allowed.get(key) ?? 0),
);
const stale = [...allowed].filter(([key, count]) => (current.get(key) ?? 0) < count);

for (const [key, diagnostics] of added) {
  const [file, rule] = JSON.parse(key);
  console.error(
    `${file}: ${diagnostics.length} ${rule} diagnostics, baseline allows ${allowed.get(key) ?? 0}:`,
  );
  console.error(diagnostics.map((diagnostic) => `  ${diagnostic}`).join("\n"));
}
if (stale.length > 0 && !update) {
  console.error(
    `${stale.length} baseline entries are above the current counts. Lower them with --update and commit ${baselineFile}.`,
  );
}

const total = [...current.values()].reduce((sum, count) => sum + count, 0);
console.log(`${total} Effect diagnostics, ${added.length} baseline entries exceeded.`);
process.exit(added.length > 0 || (stale.length > 0 && !update) ? 1 : 0);
