#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const command = basename(process.argv[1]);
const args = process.argv.slice(2);
const failure = process.env.BOAT_TEST_FAILURE;
const log = (entry) => appendFileSync(process.env.BOAT_TEST_LOG, `${JSON.stringify(entry)}\n`);

if (command === "curl") {
  readFileSync(0, "utf8");
  const method = args[args.indexOf("-X") + 1];
  const path = new URL(args.find((arg) => arg.startsWith("https:"))).pathname.replace(
    "/api/v1",
    "",
  );
  const body = args.includes("--data") ? JSON.parse(args[args.indexOf("--data") + 1]) : null;
  log({ command, method, path, body, args });
  const state = JSON.parse(readFileSync(process.env.BOAT_TEST_STATE, "utf8"));
  let response = {};
  if (method === "POST" && path === "/sandboxes") {
    const id = body.from ? "verification" : "source";
    assert.equal(state[id], undefined, "sandbox from a previous run was not deleted");
    state[id] = body;
    response = { sandbox: { id } };
  } else if (method === "DELETE") {
    const id = path.split("/").at(-1);
    assert(args.includes(`X-Ascii-Confirm-Delete: ${id}`));
    delete state[id];
  } else if (path.endsWith("/sshkey")) {
    response = {
      hostKey: "ssh-ed25519 ZmFrZQ==",
      sshEndpoint: `${path.split("/")[2]}.test:2222`,
    };
  } else if (method === "GET" && path.startsWith("/sandboxes/")) {
    response = {
      sandbox: {
        state: failure === "readiness" && path.endsWith("verification") ? "error" : "ready",
      },
    };
  } else if (method === "GET" && path.startsWith("/saved-snapshots/")) {
    response = { snapshot: { status: failure === "save" ? "failed" : "ready" } };
  } else {
    assert.equal(method, "POST");
    assert.equal(path, "/saved-snapshots");
    assert.equal(body.sandboxId, "source");
  }
  writeFileSync(process.env.BOAT_TEST_STATE, JSON.stringify(state));
  process.stdout.write(JSON.stringify(response));
} else if (command === "ssh") {
  const script = args.at(-1);
  const input = readFileSync(0, "utf8");
  log({ command, args, script, input });
  if (script.includes("tailscale.com/install.sh")) {
    process.exit(failure === "prepare" ? 1 : 0);
  }
  const result = spawnSync("sh", ["-c", script], { input, encoding: "utf8" });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
} else {
  log({ command, args });
  switch (command) {
    case "tailscale":
      assert.deepEqual(args, ["version"]);
      if (failure === "verify") process.exit(1);
      process.stdout.write("1.90.0\n");
      break;
    default:
      assert.fail(`Unexpected command: ${command}`);
  }
}
