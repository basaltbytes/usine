#!/usr/bin/env node

if (process.argv.includes("--protocol-version")) {
  process.stdout.write("5\n");
} else if (process.argv.includes("--preflight")) {
  const brain = JSON.parse(process.argv[process.argv.indexOf("--preflight") + 1]);
  process.stdout.write(
    JSON.stringify({
      _tag: "HarnessUnavailableError",
      harness: brain.harness,
      capability: "login",
      message: "Worker login expired",
    }) + "\n",
  );
} else {
  throw new Error("An unavailable harness must never start an Attempt");
}
