// Sets every published workspace package to a prerelease of its next patch version, such as
// 0.4.1-next.312.g1a2b3c4, before release.yml publishes them under the `next` dist-tag. The run
// number orders the prereleases, and every prerelease sorts before the next release.
// Usage: node scripts/prerelease-versions.mjs <run number> <commit sha>
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [run, sha] = process.argv.slice(2);
if (!/^\d+$/u.test(run ?? "") || !/^[0-9a-f]{7,40}$/u.test(sha ?? "")) {
  console.error("Usage: node scripts/prerelease-versions.mjs <run number> <commit sha>");
  process.exit(64);
}

const published = JSON.parse(
  execFileSync("pnpm", ["list", "--recursive", "--depth", "-1", "--json"], { encoding: "utf8" }),
).filter((member) => member.private === false);

for (const { path } of published) {
  const file = join(path, "package.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  const [major, minor, patch] = manifest.version.split("-")[0].split(".").map(Number);
  manifest.version = `${major}.${minor}.${patch + 1}-next.${run}.g${sha.slice(0, 7)}`;
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${manifest.name} ${manifest.version}`);
}
