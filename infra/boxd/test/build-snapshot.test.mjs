import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);
const script = new URL("../build-snapshot.sh", import.meta.url).pathname;

test("snapshot setup creates the requested size, bakes the worker key and image, and deletes its source", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "boxd-snapshot-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, "calls");
  const identity = join(directory, "worker");
  await writeFile(identity, "private-test-key");
  await writeFile(`${identity}.pub`, "ssh-ed25519 AAAAWorkerKey\n");
  await writeFile(
    join(directory, "boxd"),
    `#!/bin/sh
printf 'boxd %s\\n' "$*" >> "$BOXD_CALLS"
if [ "$1 $2" = 'snapshots save' ] && [ "\${FAIL_SAVE:-}" = 1 ]; then exit 1; fi
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(directory, "ssh"),
    `#!/bin/sh
printf 'ssh %s\\n' "$*" >> "$BOXD_CALLS"
case "$*" in
  *'cat >>'*|*'sh -s'*) cat >> "$BOXD_CALLS";;
esac
`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    BOXD_CALLS: log,
    ATTEMPT_IMAGE: "ghcr.io/example/attempt:test",
  };
  const result = await exec(script, ["--size", "4x16", "usine-attempt", identity], { env });
  assert.equal(result.stdout, "usine-attempt\n");
  const calls = await readFile(log, "utf8");
  assert.match(calls, /boxd machine new .* --size 4x16 --isolated --auto-hibernate-timeout 0/u);
  assert.match(calls, /ssh-ed25519 AAAAWorkerKey/u);
  assert.match(calls, /sh -s -- 'docker' 'ghcr.io\/example\/attempt:test'/u);
  assert.match(calls, /boxd snapshots save .* usine-attempt/u);
  assert.match(calls, /boxd machine remove usine-snapshot-/u);
  assert.match(calls, /volume create usine-pnpm-store/u);
  assert.match(calls, /sshd -t/u);
  assert.match(
    calls,
    /AcceptEnv GIT_CONFIG_VALUE_0 GH_ENTERPRISE_TOKEN GH_TOKEN ANTHROPIC_AUTH_TOKEN USINE_GATEWAY_TOKEN/u,
  );

  await assert.rejects(
    exec(script, ["usine-attempt", identity], { env: { ...env, FAIL_SAVE: "1" } }),
  );
  const failed = await readFile(log, "utf8");
  assert.match(failed, /boxd machine remove usine-snapshot-.*\n$/u);
});
