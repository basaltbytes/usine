import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { NotFoundError } from "@boxd-sh/sdk";
import {
  build,
  clientOptions,
  parseOptions,
  sendStdin,
  STDIN_CHUNK_BYTES,
  UsageError,
} from "../build-snapshot.mjs";
import { boxdEgress } from "../egress.mjs";

const exec = promisify(execFile);
const script = new URL("../build-snapshot.mjs", import.meta.url).pathname;
const env = { BOXD_API_KEY: "bxd_test", ATTEMPT_IMAGE: "ghcr.io/example/attempt:test" };

/**
 * An `Exec` stream that relays one line on each output, and exits with `exit` after stdin closes,
 * or never exits when `exit` is null. `onEnd` runs when stdin closes.
 */
const fakeStream = (exit, onEnd) => {
  const stdin = [];
  let finish;
  let fail;
  const done = new Promise((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const output = async function* (text) {
    yield new TextEncoder().encode(text);
    await done.catch(() => {});
  };
  return {
    stdin,
    ended: false,
    closed: false,
    stdout: output("pulled\n"),
    stderr: output("progress\n"),
    write(data) {
      assert.equal(this.ended, false);
      stdin.push(data);
    },
    end() {
      this.ended = true;
      onEnd?.(this);
      if (exit !== null) finish(exit);
    },
    close() {
      this.closed = true;
      fail(new Error("exec cancelled"));
    },
    wait: () => done,
  };
};

/**
 * A boxd API in the shape of the SDK client. An egress edit updates the spec as boxd documents,
 * unless `specKeepsEgress` is false, when the edit drops the spec's allowlist; `previous` is the
 * version of an existing snapshot. After a save, the first read returns the previous version, and
 * the next ones the new version, or `pending` for good when `neverReady` is set. `onSetupEnd`
 * runs when the setup's stdin closes; a null `setupExit` means the setup never exits.
 */
const fakeBoxd = ({
  setupExit = 0,
  failSave = false,
  failDelete = false,
  neverReady = false,
  specKeepsEgress = true,
  previous,
  onSetupEnd,
} = {}) => {
  const events = [];
  const state = { egress: [], specEgress: [], snapshot: undefined, stream: undefined };
  if (previous !== undefined) state.snapshot = { reads: [{ status: "ready", version: previous }] };
  return {
    events,
    state,
    machines: {
      create: async (params) => {
        events.push(["create", params]);
        const spec = params.spec.resolve();
        state.egress = spec.egress;
        state.specEgress = spec.egress;
        return { id: "vm-1", name: params.name };
      },
      waitUntilReady: async (id) => events.push(["ready", id]),
      setAutoHibernateTimeout: async (id, seconds) => events.push(["hibernate", seconds]),
      setAutoSuspendTimeout: async (id, seconds) => events.push(["suspend", seconds]),
      setEgressAllow: async (id, entries) => {
        events.push(["egress", entries]);
        state.egress = entries;
        state.specEgress = specKeepsEgress ? entries : [];
        return entries;
      },
      get: async (id) => ({ id, egressAllow: state.egress, spec: { egress: state.specEgress } }),
      streamExec: (id, params) => {
        events.push(["exec", params.command, state.egress]);
        state.stream = fakeStream(setupExit, onSetupEnd);
        return state.stream;
      },
      delete: async (id) => {
        events.push(["delete", id]);
        if (failDelete) throw new Error("delete failed");
      },
    },
    snapshots: {
      get: async (name) => {
        const reads = state.snapshot?.reads ?? [];
        const current = reads.length > 1 ? reads.shift() : reads[0];
        events.push(["snapshot", current?.status, current?.version]);
        if (current === undefined) throw new NotFoundError(`snapshot not found: ${name}`);
        return { ...current };
      },
      create: async (machine, name) => {
        events.push(["save", machine, name, state.egress, state.specEgress]);
        if (failSave) throw new Error("save failed");
        const stale = state.snapshot?.reads.at(-1);
        const version = (stale?.version ?? 0) + 1;
        const next = neverReady ? { status: "pending", version } : { status: "ready", version };
        state.snapshot = { reads: stale === undefined ? [next] : [stale, next] };
        return { name, status: "pending" };
      },
    },
  };
};

const run = (boxd, options, signal = new AbortController().signal, timing = {}) => {
  const logged = [];
  const relayed = [];
  const result = build(boxd, options, {
    log: (line) => logged.push(line),
    output: { write: (chunk) => relayed.push(Buffer.from(chunk).toString()) },
    signal,
    pollMs: 0,
    ...timing,
  });
  return { result, logged, relayed };
};

const names = (boxd) => boxd.events.map(([name]) => name);

test("builds on an isolated, shared machine from a spec with the allowlist, over Exec", async () => {
  const boxd = fakeBoxd();
  const egress = boxdEgress();
  const { result, logged, relayed } = run(boxd, parseOptions(["usine-attempt"], env));
  assert.equal(await result, "usine-attempt");
  const [, create] = boxd.events[0];
  assert.match(create.name, /^usine-snapshot-\d{14}-\d+$/u);
  assert.equal(create.shared, true);
  assert.deepEqual(create.spec.resolve(), { version: 1, size: "2x8", isolated: true, egress });
  assert.deepEqual(names(boxd), [
    "create",
    "ready",
    "hibernate",
    "suspend",
    "egress",
    "exec",
    "egress",
    "snapshot",
    "save",
    "snapshot",
    "delete",
  ]);
  const execution = boxd.events.find(([name]) => name === "exec");
  assert.deepEqual(execution, ["exec", "sh -s -- 'docker' 'ghcr.io/example/attempt:test'", []]);
  const save = boxd.events.find(([name]) => name === "save");
  assert.deepEqual(save, ["save", "vm-1", "usine-attempt", egress, egress]);
  const setup = Buffer.concat(boxd.state.stream.stdin).toString();
  assert.match(setup, /volume create usine-pnpm-store/u);
  assert.match(setup, /rm -f \/var\/lib\/tailscale\/tailscaled\.state/u);
  assert.doesNotMatch(setup, /sshd|AcceptEnv|systemctl (?:reload|restart) ssh|service ssh/u);
  assert.equal(boxd.state.stream.ended, true);
  assert.deepEqual(relayed.sort(), ["progress\n", "pulled\n"]);
  assert.match(logged[0], /^Created temporary machine usine-snapshot-/u);
  assert.match(logged.at(-1), /^Deleted temporary machine usine-snapshot-/u);
});

test("passes each size to the spec", async () => {
  for (const size of ["1x4", "8x32"]) {
    const boxd = fakeBoxd();
    await run(boxd, parseOptions(["--size", size, "usine-attempt"], env)).result;
    assert.equal(boxd.events[0][1].spec.resolve().size, size);
  }
});

test("waits for a version newer than the snapshot's previous one", async () => {
  const boxd = fakeBoxd({ previous: 3 });
  await run(boxd, parseOptions(["usine-attempt"], env)).result;
  const saved = names(boxd).indexOf("save");
  assert.deepEqual(
    boxd.events.slice(saved + 1).filter(([name]) => name === "snapshot"),
    [
      ["snapshot", "ready", 3],
      ["snapshot", "ready", 4],
    ],
  );
  assert.equal(names(boxd).at(-1), "delete");
});

test(
  "gives up on a snapshot that stays pending and deletes the machine",
  { timeout: 10_000 },
  async () => {
    const boxd = fakeBoxd({ neverReady: true });
    const { result } = run(boxd, parseOptions(["usine-attempt"], env), undefined, {
      snapshotTimeoutMs: 20,
    });
    await assert.rejects(result, /Snapshot usine-attempt is still pending/u);
    assert.equal(names(boxd).at(-1), "delete");
    assert.ok(names(boxd).filter((name) => name === "snapshot").length > 2);
  },
);

test("names the machine when its deletion fails", async () => {
  const boxd = fakeBoxd({ failDelete: true });
  const { result, logged } = run(boxd, parseOptions(["usine-attempt"], env));
  assert.equal(await result, "usine-attempt");
  assert.match(logged.at(-1), /^Delete temporary machine usine-snapshot-\d{14}-\d+ in boxd$/u);
  assert.doesNotMatch(logged.join("\n"), /Deleted temporary machine/u);
});

test("deletes the machine when the setup fails, the save fails, or the spec loses the allowlist", async () => {
  for (const [settings, message, saved] of [
    [{ setupExit: 1 }, /The setup exited with code 1/u, false],
    [{ failSave: true }, /save failed/u, true],
    [{ specKeepsEgress: false }, /didn't record the egress allowlist/u, false],
  ]) {
    const boxd = fakeBoxd(settings);
    const { result, logged } = run(boxd, parseOptions(["usine-attempt"], env));
    await assert.rejects(result, message);
    assert.equal(names(boxd).includes("save"), saved);
    assert.equal(names(boxd).at(-1), "delete");
    assert.doesNotMatch(logged.join("\n"), /Delete temporary machine/u);
  }
});

test("an interrupt ends the setup and deletes the machine", { timeout: 10_000 }, async () => {
  const controller = new AbortController();
  const boxd = fakeBoxd({ setupExit: null, onSetupEnd: () => controller.abort(130) });
  await assert.rejects(
    run(boxd, parseOptions(["usine-attempt"], env), controller.signal).result,
    /exec cancelled/u,
  );
  assert.equal(boxd.state.stream.closed, true);
  assert.deepEqual(names(boxd).slice(-2), ["exec", "delete"]);
  assert.equal(names(boxd).filter((name) => name === "delete").length, 1);
});

test("sends stdin in chunks of at most 64 KiB, byte-exact", () => {
  const bytes = new Uint8Array(3 * STDIN_CHUNK_BYTES + 100).map((_, index) => index % 251);
  const stream = fakeStream(0);
  sendStdin(stream, bytes);
  assert.deepEqual(
    stream.stdin.map((chunk) => chunk.length),
    [STDIN_CHUNK_BYTES, STDIN_CHUNK_BYTES, STDIN_CHUNK_BYTES, 100],
  );
  assert.deepEqual(Buffer.concat(stream.stdin), Buffer.from(bytes));
  assert.equal(stream.ended, true);
});

test("calls the hosted endpoint, or the region and endpoint that the options name", () => {
  assert.deepEqual(clientOptions(parseOptions(["usine-attempt"], env)), { apiKey: "bxd_test" });
  assert.deepEqual(
    clientOptions(
      parseOptions(
        ["--region", "nyc", "--endpoint", "https://api.boxd.example.com:9443", "usine-attempt"],
        env,
      ),
    ),
    { apiKey: "bxd_test", baseURL: "https://api.boxd.example.com:9443", region: "nyc" },
  );
});

test("refuses invalid options and a missing API key", () => {
  for (const [argv, environment] of [
    [[], env],
    [["--size", "2x16", "usine-attempt"], env],
    [["--region", "NYC", "usine-attempt"], env],
    [["--endpoint", "", "usine-attempt"], env],
    [["--vcpu", "2", "usine-attempt"], env],
    [["Usine_Attempt"], env],
    [["usine-attempt"], { ...env, BOXD_API_KEY: "" }],
    [["usine-attempt"], { ...env, USINE_CONTAINER_RUNTIME: "lxc" }],
    [["usine-attempt"], { ...env, ATTEMPT_IMAGE: "ghcr.io/x;rm -rf /" }],
  ])
    assert.throws(() => parseOptions(argv, environment), UsageError);
});

test("the command line exits 2 with its usage before it calls boxd", async () => {
  await assert.rejects(
    exec(process.execPath, [script, "usine-attempt"], { env: { PATH: process.env.PATH } }),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /Set BOXD_API_KEY/u);
      assert.match(error.stderr, /^Usage: build-snapshot\.mjs /mu);
      return true;
    },
  );
});
