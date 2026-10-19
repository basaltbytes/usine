// Packs every published workspace package, installs the tarballs with npm into an
// empty project, and imports each entry point from there, as a consumer would.
// Usage: node scripts/check-packed-install.mjs [scratch-directory]
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
if (!imported || !started) {
  console.error("A plain npm install of the packed packages is broken.");
  process.exit(1);
}
console.log("Every entry point loads from a plain npm install of the packed packages.");
