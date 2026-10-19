#!/usr/bin/env node

// Answers `gh api` lookups from the records the test's parent wrote in the checkout:
// the pull request at the final commit, and the review it posted on pull request 71.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2).filter((arg) => arg !== "--lookup-fails");
if (args[0] !== "api") throw new Error("Expected structured GitHub API access");
if (args[1] === "graphql") {
  process.stdout.write(JSON.stringify({ data: { viewer: { login: "usine-test[bot]" } } }));
  process.exit(0);
}
if (!args.includes("--paginate") || !args.includes("--slurp"))
  throw new Error("Expected all pages");
const listed = /^repos\/acme\/demo\/(?:issues|pulls)\/71\/(comments|reviews)\?/u.exec(args[1]);
if (listed !== null) {
  const reviews =
    listed[1] === "reviews" ? [JSON.parse(readFileSync(".test-review.json", "utf8"))] : [];
  process.stdout.write(JSON.stringify([reviews]));
  process.exit(0);
}
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (args[1] !== `repos/acme/demo/commits/${head}/pulls?per_page=100`) {
  throw new Error("Discovery must use the Attempt repository and final commit");
}
if (process.argv.includes("--lookup-fails")) process.exit(1);
const pr = JSON.parse(readFileSync(".test-pull-request.json", "utf8"));
process.stdout.write(
  JSON.stringify([[{ ...pr, number: 99, head: { sha: "f".repeat(40) } }], [pr, pr]]),
);
