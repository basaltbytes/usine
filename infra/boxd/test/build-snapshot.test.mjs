import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);
const script = new URL("../build-snapshot.sh", import.meta.url).pathname;

// Feeds the script an answer that a forwarded stdin would hand to a boxd prompt.
const run = (args, env) => {
  const pending = exec(script, args, { env });
  pending.child.stdin.end("yes\n");
  return pending;
};

// Mirrors the boxd CLI 0.3.3 usage checks the script depends on.
// Any byte on stdin means the script passed its own stdin through, where a terminal could prompt.
const fakeBoxd = `#!/bin/sh
printf 'boxd %s\\n' "$*" >> "$BOXD_CALLS"
[ ! -t 0 ] || { echo 'error: interactive prompt on a terminal' >&2; exit 1; }
[ -z "$(cat)" ] || { echo 'error: interactive prompt read stdin' >&2; exit 1; }
case "$1 $2" in
  'machine new')
    shift 2
    json=false
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --size) echo "error: unexpected argument '--size' found" >&2; exit 2;;
        --json) json=true;;
        --vcpu) printf '%s\\n' "$2" >> "$BOXD_VCPU"; shift;;
      esac
      shift
    done
    [ "$json" = true ] || { echo 'error: interactive prompt: Connect now? [Y/n]' >&2; exit 1; };;
  'machine remove')
    shift 2
    confirmed=false
    machine=
    for argument in "$@"; do
      case "$argument" in
        -y|--confirm) confirmed=true;;
        *) machine=$argument;;
      esac
    done
    [ "$confirmed" = true ] || { echo 'error: destroying a machine is permanent, pass -y' >&2; exit 1; }
    printf '%s\\n' "$machine" >> "$BOXD_REMOVED";;
  'snapshots save')
    [ "\${FAIL_SAVE:-}" != 1 ] || exit 1
    [ "$#" -eq 4 ] || { echo 'error: snapshots save takes <machine> <name>' >&2; exit 2; };;
esac
`;

const fakeSsh = `#!/bin/sh
printf 'ssh %s\\n' "$*" >> "$BOXD_CALLS"
case "$*" in
  *'cat >>'*|*'sh -s'*) cat >> "$BOXD_CALLS";;
esac
`;

const setUp = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "boxd-snapshot-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const identity = join(directory, "worker");
  await writeFile(identity, "private-test-key");
  await writeFile(`${identity}.pub`, "ssh-ed25519 AAAAWorkerKey\n");
  await writeFile(join(directory, "boxd"), fakeBoxd, { mode: 0o755 });
  await writeFile(join(directory, "ssh"), fakeSsh, { mode: 0o755 });
  const files = {
    calls: join(directory, "calls"),
    vcpu: join(directory, "vcpu"),
    removed: join(directory, "removed"),
  };
  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    BOXD_CALLS: files.calls,
    BOXD_VCPU: files.vcpu,
    BOXD_REMOVED: files.removed,
    ATTEMPT_IMAGE: "ghcr.io/example/attempt:test",
  };
  const read = (name) => readFile(files[name], "utf8");
  return { identity, env, read };
};

test("snapshot setup sizes the machine by vCPU, bakes the worker key and image, and deletes its source", async (t) => {
  const { identity, env, read } = await setUp(t);
  const result = await run(["--size", "2x8", "usine-attempt", identity], env);
  assert.equal(result.stdout, "usine-attempt\n");
  assert.match(result.stderr, /Created temporary machine usine-snapshot-/u);
  assert.doesNotMatch(result.stderr, /Delete temporary machine/u);
  assert.equal(await read("vcpu"), "2\n");
  const calls = await read("calls");
  assert.match(calls, /boxd machine new .* --vcpu 2 --isolated --auto-hibernate-timeout 0 --json/u);
  assert.match(calls, /ssh-ed25519 AAAAWorkerKey/u);
  assert.match(calls, /sh -s -- 'docker' 'ghcr.io\/example\/attempt:test'/u);
  assert.match(calls, /boxd snapshots save usine-snapshot-\S+ usine-attempt\n/u);
  assert.match(calls, /boxd machine remove -y usine-snapshot-/u);
  assert.match(await read("removed"), /^usine-snapshot-\S+\n$/u);
  assert.match(calls, /volume create usine-pnpm-store/u);
  assert.match(calls, /sudo install -d -m 0755 \/run\/sshd\nsudo sshd -t\n/u);
  assert.match(calls, /sudo systemctl reload ssh 2>\/dev\/null \|\| sudo systemctl restart ssh/u);
  assert.match(
    calls,
    /AcceptEnv GIT_CONFIG_VALUE_0 GH_ENTERPRISE_TOKEN GH_TOKEN ANTHROPIC_AUTH_TOKEN USINE_GATEWAY_TOKEN/u,
  );
});

test("snapshot setup maps the largest size to 8 vCPUs", async (t) => {
  const { identity, env, read } = await setUp(t);
  const result = await run(["--size", "8x32", "usine-attempt", identity], env);
  assert.equal(result.stdout, "usine-attempt\n");
  assert.equal(await read("vcpu"), "8\n");
});

test("snapshot setup deletes its source machine when the save fails", async (t) => {
  const { identity, env, read } = await setUp(t);
  await assert.rejects(run(["usine-attempt", identity], { ...env, FAIL_SAVE: "1" }), (error) => {
    assert.doesNotMatch(error.stderr, /Delete temporary machine/u);
    return true;
  });
  assert.equal(await read("vcpu"), "2\n");
  assert.match(await read("calls"), /boxd machine remove -y usine-snapshot-.*\n$/u);
  assert.match(await read("removed"), /^usine-snapshot-\S+\n$/u);
});
