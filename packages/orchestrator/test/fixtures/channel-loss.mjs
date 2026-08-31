#!/usr/bin/env node

if (process.argv.includes("--protocol-version")) {
  process.stdout.write("1\n");
}
