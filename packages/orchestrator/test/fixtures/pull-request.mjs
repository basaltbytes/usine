#!/usr/bin/env node

// Answers `gh api` pull request lookups from the record the test's parent wrote in the checkout.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2).filter((arg) => arg !== "--lookup-fails");
if (args[0] !== "api") throw new Error("Expected structured GitHub API access");
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (args[1] !== `repos/acme/demo/commits/${head}/pulls?per_page=100`) {
  throw new Error("Discovery must use the Attempt repository and final commit");
}
if (!args.includes("--paginate") || !args.includes("--slurp"))
  throw new Error("Expected all pages");
if (process.argv.includes("--lookup-fails")) process.exit(1);
const pr = JSON.parse(readFileSync(".test-pull-request.json", "utf8"));
process.stdout.write(
  JSON.stringify([[{ ...pr, number: 99, head: { sha: "f".repeat(40) } }], [pr, pr]]),
);
