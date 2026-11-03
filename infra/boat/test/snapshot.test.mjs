import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

function fixture(t) {
  const work = mkdtempSync(join(tmpdir(), "boat-snapshot-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const bin = join(work, "bin");
  mkdirSync(bin);
  const stub = join(work, "command.mjs");
  writeFileSync(stub, readFileSync(new URL("command.mjs", import.meta.url)));
  chmodSync(stub, 0o755);
  for (const command of ["curl", "ssh", "tailscale"]) {
    symlinkSync(stub, join(bin, command));
  }
  const identity = join(work, "identity with spaces");
  writeFileSync(identity, "fixture");
  writeFileSync(`${identity}.pub`, "ssh-ed25519 ZmFrZQ==");
  const state = join(work, "state.json");
  const log = join(work, "log.jsonl");
  writeFileSync(state, "{}");
  return {
    run(failure = "") {
      writeFileSync(log, "");
      const result = spawnSync(
        "sh",
        [fileURLToPath(new URL("../build-snapshot.sh", import.meta.url)), "attempt", identity],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            BOAT_API_KEY: "fixture",
            BOAT_TEST_FAILURE: failure,
            BOAT_TEST_STATE: state,
            BOAT_TEST_LOG: log,
          },
          encoding: "utf8",
          timeout: 20_000,
        },
      );
      assert.equal(result.error, undefined);
      assert.deepEqual(JSON.parse(readFileSync(state, "utf8")), {}, "every sandbox is deleted");
      const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
      return { ...result, calls };
    },
  };
}

test("verifies a fresh restore before reporting success and can rebuild the same snapshot", (t) => {
  const f = fixture(t);
  for (let run = 0; run < 2; run++) {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Snapshot attempt is verified and ready/);
    const created = result.calls.filter(
      (call) => call.method === "POST" && call.path === "/sandboxes",
    );
    assert.equal(created.length, 2);
    assert.deepEqual(created[1].body, {
      name: "usine-verify-attempt",
      from: "attempt",
      noEnv: true,
      snapshots: false,
      monitoring: false,
      ttlSeconds: 900,
    });
    const preparation = result.calls.find((call) =>
      call.script?.includes("tailscale.com/install.sh"),
    );
    assert.match(preparation.script, /sudo sh \/tmp\/usine-install-tailscale.sh/);
    assert.match(
      preparation.script,
      /systemctl stop tailscaled\s+sudo rm -f \/var\/lib\/tailscale\/tailscaled.state\s+sync/,
    );
    assert.doesNotMatch(preparation.script, /docker|containerd/);
    const version = result.calls.find((call) => call.command === "tailscale");
    assert.deepEqual(version.args, ["version"]);
    const verification = result.calls.find((call) => call.script === "tailscale version");
    assert(verification.args.includes("user@verification.test"));
    assert(verification.args.includes("StrictHostKeyChecking=yes"));
  }
});

for (const failure of ["verify", "prepare", "save", "readiness"]) {
  test(`fails and deletes every created sandbox when ${failure} fails`, (t) => {
    const result = fixture(t).run(failure);
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stdout, /is verified and ready/);
    if (failure === "verify") {
      assert.match(result.stderr, /cannot run Tailscale on sandbox verification/);
    }
  });
}
