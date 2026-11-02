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
  for (const command of ["curl", "ssh", "sudo", "docker", "containerd", "du", "systemctl"]) {
    symlinkSync(stub, join(bin, command));
  }
  const identity = join(work, "identity with spaces");
  writeFileSync(identity, "fixture");
  writeFileSync(`${identity}.pub`, "ssh-ed25519 ZmFrZQ==");
  const state = join(work, "state.json");
  const log = join(work, "log.jsonl");
  writeFileSync(state, "{}");
  const image = "registry.test/attempt:latest; $(echo unsafe)";
  return {
    image,
    run(failure = "", tomlQuote = '"') {
      writeFileSync(log, "");
      const result = spawnSync(
        "sh",
        [
          fileURLToPath(new URL("../build-snapshot.sh", import.meta.url)),
          "attempt",
          image,
          identity,
        ],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            BOAT_API_KEY: "fixture",
            BOAT_TEST_FAILURE: failure,
            BOAT_TEST_TOML_QUOTE: tomlQuote,
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
    const preparation = result.calls.find((call) => call.script?.includes("docker pull"));
    assert.match(
      preparation.script,
      /docker create[\s\S]*systemctl stop docker docker.socket containerd\s+sync/,
    );
    assert.equal(preparation.input, `${f.image}\n`);
    const inspection = result.calls.find((call) => call.command === "docker");
    assert.deepEqual(inspection.args, ["image", "inspect", f.image]);
    const verification = result.calls.find((call) => call.script?.includes("docker image inspect"));
    assert(verification.args.includes("user@verification.test"));
    assert(verification.args.includes("StrictHostKeyChecking=yes"));
  }
});

for (const quote of ['"', "'"]) {
  test(`prints containerd paths and disk usage for ${quote}-quoted TOML when the image is missing`, (t) => {
    const result = fixture(t).run("missing", quote);
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stdout, /is verified and ready/);
    assert.match(result.stderr, /cannot inspect attempt image/);
    assert(result.stderr.includes(`root = ${quote}/custom/containerd root${quote}`));
    assert(result.stderr.includes(`state = ${quote}/custom/containerd state${quote}`));
    assert.match(result.stderr, /3.1G\s+\/custom\/containerd root/);
    assert.match(result.stderr, /20K\s+\/custom\/containerd state/);
  });
}

for (const failure of ["diagnostics", "prepare", "save", "readiness"]) {
  test(`fails and deletes every created sandbox when ${failure} fails`, (t) => {
    const result = fixture(t).run(failure);
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stdout, /is verified and ready/);
    if (failure === "diagnostics") {
      assert.match(result.stderr, /cannot inspect attempt image/);
      assert.match(result.stderr, /Could not read containerd storage diagnostics/);
    }
  });
}
