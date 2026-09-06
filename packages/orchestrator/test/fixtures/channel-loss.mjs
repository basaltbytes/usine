#!/usr/bin/env node

if (process.argv.includes("--preflight")) {
  const brain = JSON.parse(process.argv[process.argv.indexOf("--preflight") + 1]);
  process.stdout.write(JSON.stringify({ _tag: "HarnessReady", harness: brain.harness }) + "\n");
} else if (process.argv.includes("--protocol-version")) {
  process.stdout.write("4\n");
}
