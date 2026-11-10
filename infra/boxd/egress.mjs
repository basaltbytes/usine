#!/usr/bin/env node
// Prints a gateway egress allowlist as provisioner.egress for a boxd worker, so the gateway's
// forward proxy and boxd enforce the same hosts. Adds *.tailscale.com, which boxd machines need to
// join the tailnet. Usage: egress.mjs [allowlist], which defaults to the gateway's checked-in file.
import { readFileSync } from "node:fs";

const TAILSCALE = "*.tailscale.com";
const HOST =
  /^(?:\*\.)?(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
};

if (process.argv.length > 3) fail("Usage: egress.mjs [allowlist]");
const path =
  process.argv[2] ?? new URL("../hetzner/gateway/egress-allowlist", import.meta.url).pathname;
const entries = [TAILSCALE];
for (const [index, raw] of readFileSync(path, "utf8").split(/\r?\n/u).entries()) {
  const rule = raw.replace(/#.*$/u, "").trim().toLowerCase();
  if (rule === "") continue;
  if (rule.includes(":"))
    fail(
      `Line ${index + 1}: boxd allowlists have no ports; remove :port from "${rule}" or leave the host out`,
    );
  if (!HOST.test(rule))
    fail(`Line ${index + 1}: expected a host name, or *. and a domain, got "${rule}"`);
  if (!entries.includes(rule)) entries.push(rule);
}
process.stdout.write(`egress:\n${entries.map((entry) => `  - "${entry}"\n`).join("")}`);
