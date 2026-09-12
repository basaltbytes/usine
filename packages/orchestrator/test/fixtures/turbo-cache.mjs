#!/usr/bin/env node

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

if (process.argv.includes("--preflight")) {
  const brain = JSON.parse(process.argv[process.argv.indexOf("--preflight") + 1]);
  process.stdout.write(JSON.stringify({ _tag: "HarnessReady", harness: brain.harness }) + "\n");
} else if (process.argv.includes("--protocol-version")) {
  process.stdout.write("5\n");
} else {
  const cacheDirectory = process.env.TURBO_CACHE_DIR;
  if (cacheDirectory === undefined) {
    throw new Error("TURBO_CACHE_DIR is not set");
  }
  const expected = join(dirname(dirname(process.cwd())), "turbo");
  const actual = join(realpathSync(dirname(cacheDirectory)), basename(cacheDirectory));
  if (actual !== expected) {
    throw new Error(`Expected TURBO_CACHE_DIR=${expected}`);
  }
  mkdirSync(cacheDirectory, { recursive: true });
  writeFileSync(join(cacheDirectory, "test-marker"), "turbo cache location");
  await import("../../../run-host/dist/bin.js");
}
