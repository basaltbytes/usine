#!/usr/bin/env node

if (!process.argv.includes("--protocol-version")) {
  // An independent logger can write before the host configures its Effect context.
  process.stdout.write(
    process.argv.includes("--malformed-frame")
      ? '{"version":4,"payload":{"_tag":"Started"}}\n'
      : "[19:31:20.123] INFO: library startup\n",
  );
}
await import("../../../run-host/dist/bin.js");
// Console users outside the host's Effect context must also write to stderr.
if (!process.argv.includes("--protocol-version")) console.log("session library diagnostic");
