// Packs every published workspace package, installs the tarballs with npm into an
// empty project, and imports each entry point from there, as a consumer would. It
// also fails when an installed @earendil-works package is not at a version
// pnpm-lock.yaml resolves for the workspace.
// Usage: node scripts/check-packed-install.mjs [scratch-directory]
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const repository = resolve(import.meta.dirname, "..");
const scratch = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), "usine-packed-install-")));
const tarballs = join(scratch, "tarballs");
const project = join(scratch, "project");

const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: "inherit" });
const passes = (command, args) =>
  spawnSync(command, args, { cwd: project, stdio: "inherit" }).status === 0;

rmSync(tarballs, { force: true, recursive: true });
rmSync(project, { force: true, recursive: true });
mkdirSync(tarballs, { recursive: true });
mkdirSync(project, { recursive: true });
console.log(`Scratch directory: ${scratch}`);

const published = JSON.parse(
  execFileSync("pnpm", ["list", "--recursive", "--depth", "-1", "--json"], {
    cwd: repository,
    encoding: "utf8",
  }),
).filter((member) => member.private === false);

run(
  "pnpm",
  ["turbo", "run", "build", ...published.map(({ name }) => `--filter=${name}`)],
  repository,
);
for (const { path } of published) {
  run("pnpm", ["pack", "--pack-destination", tarballs], path);
}

writeFileSync(
  join(project, "package.json"),
  JSON.stringify({ name: "usine-packed-install", private: true, type: "module" }),
);
const packed = readdirSync(tarballs)
  .filter((file) => file.endsWith(".tgz"))
  .map((file) => join(tarballs, file));
run("npm", ["install", "--no-audit", "--no-fund", ...packed], project);

const scope = join(project, "node_modules", "@usine");
const specifiers = readdirSync(scope).flatMap((name) => {
  const manifest = JSON.parse(readFileSync(join(scope, name, "package.json"), "utf8"));
  return Object.keys(manifest.exports ?? {}).map((subpath) => `@usine/${name}${subpath.slice(1)}`);
});
// The server has no exports map; `usine` loads these command modules on demand.
specifiers.push(
  "@usine/server/dist/up.js",
  "@usine/server/dist/backup.js",
  "@usine/server/dist/export-run.js",
);

const importAll = `
let failed = 0;
for (const specifier of ${JSON.stringify(specifiers)}) {
  try {
    await import(specifier);
    console.log("ok      " + specifier);
  } catch (error) {
    failed += 1;
    console.error("FAILED  " + specifier + "\\n        " + String(error).split("\\n")[0]);
  }
}
process.exitCode = failed === 0 ? 0 : 1;
`;

const imported = passes("node", ["--input-type=module", "--eval", importAll]);
const started = passes(join(project, "node_modules", ".bin", "usine"), ["--version"]);

const lockfile = readFileSync(join(repository, "pnpm-lock.yaml"), "utf8");
const lockedPackages = lockfile.slice(
  lockfile.indexOf("\npackages:\n"),
  lockfile.indexOf("\nsnapshots:\n"),
);
const locked = new Map();
for (const [, name, version] of lockedPackages.matchAll(
  /^ {2}'(@earendil-works\/[^@']+)@([^'(]+)':$/gm,
)) {
  locked.set(name, [...(locked.get(name) ?? []), version]);
}

const installed = [];
const collect = (modules) => {
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const names = entry.name.startsWith("@")
      ? readdirSync(join(modules, entry.name)).map((name) => `${entry.name}/${name}`)
      : [entry.name];
    for (const name of names) {
      const directory = join(modules, name);
      if (name.startsWith("@earendil-works/")) {
        const { version } = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
        installed.push({ name, version, path: relative(project, directory) });
      }
      if (existsSync(join(directory, "node_modules"))) collect(join(directory, "node_modules"));
    }
  }
};
collect(join(project, "node_modules"));

const drift = locked.size === 0 ? ["pnpm-lock.yaml resolves no @earendil-works package."] : [];
for (const name of new Set(installed.map((copy) => copy.name))) {
  const copies = installed.filter((copy) => copy.name === name);
  const expected = locked.get(name);
  for (const { version, path } of copies) {
    if (expected === undefined) {
      drift.push(
        `${name} ${version} is installed at ${path}, but pnpm-lock.yaml does not resolve it.`,
      );
    } else if (!expected.includes(version)) {
      drift.push(
        `${name} ${version} is installed at ${path}, but pnpm-lock.yaml resolves ${expected.join(" or ")}.`,
      );
    }
  }
  const versions = [...new Set(copies.map((copy) => copy.version))];
  if (versions.length > 1) {
    drift.push(`${name} is installed more than once, at ${versions.join(" and ")}.`);
  }
}
for (const line of drift) console.error(`DRIFT   ${line}`);
if (drift.length === 0) {
  console.log(`ok      ${installed.length} @earendil-works packages match pnpm-lock.yaml`);
}

if (!imported || !started || drift.length > 0) {
  console.error("A plain npm install of the packed packages is broken.");
  process.exit(1);
}
console.log(
  "Every entry point loads from a plain npm install of the packed packages, and its @earendil-works packages match pnpm-lock.yaml.",
);
