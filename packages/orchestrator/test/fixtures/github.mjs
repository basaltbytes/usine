#!/usr/bin/env node

// Answers `gh api` lookups from the records the test's parent wrote in the checkout, and refuses
// the GraphQL viewer query because the scheduler provides the bot login.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const args = process.argv
  .slice(2)
  .filter((arg) => !["--lookup-fails", "--hide-comments", "--require-credentials"].includes(arg));
if (
  process.argv.includes("--require-credentials") &&
  !existsSync(`${process.env.GH_CONFIG_DIR}/hosts.yml`)
)
  throw new Error("Expected a live credential for comment harvesting");
if (args[0] !== "api" || args[1] === "graphql")
  throw new Error("Expected structured GitHub REST access");
if (!args.includes("--paginate") || !args.includes("--slurp"))
  throw new Error("Expected all pages");
const listed = /^repos\/acme\/demo\/(?:issues|pulls)\/71\/(comments|reviews)\?/u.exec(args[1]);
if (listed !== null) {
  if (process.argv.includes("--hide-comments")) {
    process.stdout.write("[[]]");
    process.exit(0);
  }
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
