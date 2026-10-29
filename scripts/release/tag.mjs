import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { unpublishedPackages } from "./registry.mjs";

// The action reads this report even when approval is pending and no tags exist.
if (process.env.CHANGESETS_OUTPUT) appendFileSync(process.env.CHANGESETS_OUTPUT, "");

const packages = JSON.parse(
  execFileSync("pnpm", ["list", "--recursive", "--depth", "-1", "--json"], { encoding: "utf8" }),
).filter((member) => member.private === false);

const pending = await unpublishedPackages(packages, "https://registry.npmjs.org/");
if (pending.length > 0) {
  console.log(JSON.stringify({ event: "release_approval_pending", packages: pending }));
  console.log("Approve every staged version on npm, then rerun this release job to create tags.");
} else {
  console.log(JSON.stringify({ event: "release_versions_public", packages: packages.length }));
  execFileSync("pnpm", ["exec", "changeset", "git-tag"], { stdio: "inherit" });
}
