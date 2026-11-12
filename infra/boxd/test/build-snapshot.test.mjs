import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
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
 * or never exits when `exit` is null. `onEnd` runs when stdin closes. A `chatty` stream then prints
 * a line on stdout every few milliseconds until it ends. Closing the stream ends it with an error,
 * unless `cancellable` is false, as on a connection that no longer carries bytes.
 */
const fakeStream = ({ exit = 0, onEnd, chatty = false, cancellable = true } = {}) => {
  const stdin = [];
  let finish;
  let fail;
  const done = new Promise((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const ended = done.then(
    () => true,
    () => true,
  );
  const output = async function* (text, chatter) {
    yield new TextEncoder().encode(text);
    for (let line = 1; chatter && !(await Promise.race([ended, sleep(5, false)])); line += 1)
      yield new TextEncoder().encode(`step ${line}\n`);
    await ended;
  };
  return {
    stdin,
    ended: false,
    closed: false,
    stdout: output("pulled\n", chatty),
    stderr: output("progress\n", false),
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
      if (cancellable) fail(new Error("exec cancelled"));
    },
    wait: () => done,
  };
};

/**
 * A boxd API in the shape of the SDK client. An egress edit updates the spec as boxd documents,
 * unless `specKeepsEgress` is false, when the edit drops the spec's allowlist. The nth edit comes
 * into effect after `egressLags[n]` machine reads, or never when it is `Infinity`; the default is
 * at once. `previous` is the latest ready version of an existing snapshot. A save captures the
 * next version. After it, the snapshot reads `reads` in order and then repeats the last one; by
 * default, the first read returns the previous version, and the next ones the new version, or
 * `pending` for good when `neverReady` is set. `setup` holds the options of the setup's `Exec`
 * stream. When `reappliesEgress` is set, the reads after the first one that reports the allowlist
 * lifted report the allowlist of the machine's creation again.
 */
const fakeBoxd = ({
  setup,
  reappliesEgress = false,
  failSave = false,
  failDelete = false,
  neverReady = false,
  specKeepsEgress = true,
  egressLags = [],
  previous,
  reads,
} = {}) => {
  const events = [];
  const state = {
    egress: [],
    requested: [],
    lag: 0,
    edits: 0,
    specEgress: [],
    created: [],
    liftedAt: undefined,
    setupDelay: undefined,
    snapshot: undefined,
    stream: undefined,
  };
  if (previous !== undefined) state.snapshot = [{ status: "ready", version: previous }];
  return {
    events,
    state,
    machines: {
      create: async (params) => {
        events.push(["create", params]);
        const spec = params.spec.resolve();
        state.egress = spec.egress;
        state.requested = spec.egress;
        state.specEgress = spec.egress;
        state.created = spec.egress;
        return { id: "vm-1", name: params.name };
      },
      waitUntilReady: async (id) => events.push(["ready", id]),
      setAutoHibernateTimeout: async (id, seconds) => events.push(["hibernate", seconds]),
      setAutoSuspendTimeout: async (id, seconds) => events.push(["suspend", seconds]),
      setEgressAllow: async (id, entries) => {
        events.push(["egress", entries]);
        state.requested = entries;
        state.lag = egressLags[state.edits++] ?? 0;
        if (state.lag === 0) state.egress = entries;
        state.specEgress = specKeepsEgress ? entries : [];
        return entries;
      },
      get: async (id) => {
        if (state.lag > 0) state.lag -= 1;
        else if (reappliesEgress && state.liftedAt !== undefined) state.egress = state.created;
        else state.egress = state.requested;
        if (state.egress.length === 0) state.liftedAt ??= Date.now();
        events.push(["machine", state.egress]);
        return { id, egressAllow: state.egress, spec: { egress: state.specEgress } };
      },
      streamExec: (id, params) => {
        events.push(["exec", params.command, state.egress]);
        state.setupDelay = Date.now() - state.liftedAt;
        state.stream = fakeStream(setup);
        return state.stream;
      },
      delete: async (id) => {
        events.push(["delete", id]);
        if (failDelete) throw new Error("delete failed");
      },
    },
    snapshots: {
      get: async () => {
        const current = state.snapshot.length > 1 ? state.snapshot.shift() : state.snapshot[0];
        events.push(["snapshot", current.status, current.version]);
        return { ...current };
      },
      create: async (machine, name) => {
        events.push(["save", machine, name, state.egress, state.specEgress]);
        if (failSave) throw new Error("save failed");
        const stale = state.snapshot?.at(-1);
        const version = (previous ?? 0) + 1;
        const next = neverReady
          ? { status: "pending", version: null }
          : { status: "ready", version };
        state.snapshot = reads ?? (stale === undefined ? [next] : [stale, next]);
        return { name, version, status: "pending" };
      },
    },
  };
};

const run = (boxd, options, signal = new AbortController().signal, timing = {}) => {
  const logged = [];
  const relayed = [];
  const result = build(boxd, options, {
    cleanup: boxd,
    log: (line) => logged.push(line),
    output: { write: (chunk) => relayed.push(Buffer.from(chunk).toString()) },
    signal,
    pollMs: 0,
    egressInForceMs: 0,
    egressTimeoutMs: 2_000,
    snapshotTimeoutMs: 2_000,
    quietMs: 2_000,
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
    "machine",
    "machine",
    "exec",
    "egress",
    "machine",
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
  assert.match(setup, /Acquire::http::Timeout "30";' 'Acquire::https::Timeout "30";'/u);
  assert.match(
    setup,
    /^(sudo timeout -k 10 \d+ sh \/tmp\/usine-tailscale\.sh) \|\| \1$/mu,
    "the Tailscale installer, which runs apt-get update, runs once more after a failure",
  );
  assert.match(
    setup,
    /apt-get --error-on=any update \|\| sudo timeout -k 10 \d+ apt-get update$/mu,
    "apt-get update runs once more after a failed download",
  );
  assert.equal(boxd.state.stream.ended, true);
  assert.deepEqual(relayed.sort(), ["progress\n", "pulled\n"]);
  assert.match(logged[0], /^Created temporary machine usine-snapshot-/u);
  assert.match(logged.at(-1), /^Deleted temporary machine usine-snapshot-/u);
});

test("passes each size to the spec, including one that only a self-hosted cluster lists", async () => {
  for (const size of ["1x4", "8x32", "1x32"]) {
    const boxd = fakeBoxd();
    await run(boxd, parseOptions(["--size", size, "usine-attempt"], env)).result;
    assert.equal(boxd.events[0][1].spec.resolve().size, size);
  }
});

test("builds without isolation with --no-isolated", async () => {
  const boxd = fakeBoxd();
  await run(boxd, parseOptions(["--no-isolated", "usine-attempt"], env)).result;
  assert.equal(boxd.events[0][1].spec.resolve().isolated, undefined);
});

test("waits for the version that the save captures", async () => {
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
  "gives up on a version that doesn't become ready and deletes the machine",
  { timeout: 10_000 },
  async () => {
    // A failed save of a snapshot that has a ready version leaves the snapshot ready at that one.
    for (const settings of [
      { neverReady: true },
      { previous: 3, reads: [{ status: "ready", version: 3 }] },
    ]) {
      const boxd = fakeBoxd(settings);
      const { result } = run(boxd, parseOptions(["usine-attempt"], env), undefined, {
        snapshotTimeoutMs: 20,
      });
      const version = (settings.previous ?? 0) + 1;
      await assert.rejects(
        result,
        new RegExp(
          `^Error: Version ${version} of snapshot usine-attempt didn't become ready within 0\\.02 seconds$`,
          "u",
        ),
      );
      assert.equal(names(boxd).at(-1), "delete");
      assert.ok(names(boxd).filter((name) => name === "snapshot").length > 2);
    }
  },
);

test("fails when boxd reports the save failed, after it showed the save pending", async () => {
  const boxd = fakeBoxd({
    reads: [
      { status: "failed", version: null },
      { status: "pending", version: null },
      { status: "failed", version: null },
    ],
  });
  const { result } = run(boxd, parseOptions(["usine-attempt"], env));
  await assert.rejects(
    result,
    /^Error: boxd reports that version 1 of snapshot usine-attempt failed$/u,
  );
  assert.equal(names(boxd).filter((name) => name === "snapshot").length, 3);
  assert.equal(names(boxd).at(-1), "delete");
});

test("a failed read before the save shows pending is a previous save's record", async () => {
  const boxd = fakeBoxd({
    reads: [
      { status: "failed", version: null },
      { status: "pending", version: null },
      { status: "ready", version: 1 },
    ],
  });
  assert.equal(await run(boxd, parseOptions(["usine-attempt"], env)).result, "usine-attempt");
  assert.equal(names(boxd).filter((name) => name === "snapshot").length, 3);
});

test(
  "starts the setup once boxd still reports the allowlist lifted after the wait",
  { timeout: 10_000 },
  async () => {
    const boxd = fakeBoxd({ egressLags: [2, 2] });
    const egress = boxdEgress();
    const { result } = run(boxd, parseOptions(["usine-attempt"], env), undefined, {
      egressInForceMs: 50,
    });
    assert.equal(await result, "usine-attempt");
    const machine = names(boxd).indexOf("machine");
    assert.deepEqual(boxd.events.slice(machine, machine + 5), [
      ["machine", egress],
      ["machine", egress],
      ["machine", []],
      ["machine", []],
      ["exec", "sh -s -- 'docker' 'ghcr.io/example/attempt:test'", []],
    ]);
    assert.ok(
      boxd.state.setupDelay >= 45,
      `the setup started ${boxd.state.setupDelay} ms after the lift`,
    );
    const save = boxd.events.find(([name]) => name === "save");
    assert.deepEqual(save, ["save", "vm-1", "usine-attempt", egress, egress]);
  },
);

test("names the machine when its deletion fails", async () => {
  const boxd = fakeBoxd({ failDelete: true });
  const { result, logged } = run(boxd, parseOptions(["usine-attempt"], env));
  assert.equal(await result, "usine-attempt");
  assert.match(logged.at(-1), /^Delete temporary machine usine-snapshot-\d{14}-\d+ in boxd$/u);
  assert.doesNotMatch(logged.join("\n"), /Deleted temporary machine/u);
});

test("deletes the machine when the setup or the save fails, or boxd doesn't apply, keep, or record an egress edit", async () => {
  for (const [settings, message, saved, executed] of [
    [{ setup: { exit: 1 } }, /The setup exited with code 1/u, false, true],
    [{ failSave: true }, /save failed/u, true, true],
    [{ specKeepsEgress: false }, /didn't record the egress allowlist/u, false, true],
    [{ egressLags: [Infinity] }, /egress as unrestricted within 0\.02 seconds/u, false, false],
    // The spec has the allowlist, but boxd never reports it in effect.
    [
      { egressLags: [0, Infinity] },
      /egress as (?!unrestricted).+ within 0\.02 seconds/u,
      false,
      true,
    ],
    [
      { reappliesEgress: true },
      /egress unrestricted, then \*\.tailscale\.com, .+ 0 seconds later$/u,
      false,
      false,
    ],
  ]) {
    const boxd = fakeBoxd(settings);
    const { result, logged } = run(boxd, parseOptions(["usine-attempt"], env), undefined, {
      egressTimeoutMs: 20,
    });
    await assert.rejects(result, message);
    assert.equal(names(boxd).includes("save"), saved);
    assert.equal(names(boxd).includes("exec"), executed);
    assert.equal(names(boxd).at(-1), "delete");
    assert.doesNotMatch(logged.join("\n"), /Delete temporary machine/u);
  }
});

test(
  "an interrupt ends the setup and deletes the machine through the second client at once",
  { timeout: 10_000 },
  async () => {
    const controller = new AbortController();
    // The setup's connection no longer carries bytes, so closing the stream doesn't end it.
    const boxd = fakeBoxd({
      setup: { exit: null, cancellable: false, onEnd: () => controller.abort(130) },
    });
    const cleanup = fakeBoxd();
    const { result, logged } = run(boxd, parseOptions(["usine-attempt"], env), controller.signal, {
      cleanup,
    });
    await assert.rejects(result, /^Error: Interrupted$/u);
    assert.equal(boxd.state.stream.closed, true);
    assert.equal(names(boxd).at(-1), "exec");
    assert.deepEqual(cleanup.events, [["delete", "vm-1"]]);
    assert.equal(logged.at(-2), "Interrupted; deleting the temporary machine");
    assert.match(logged.at(-1), /^Deleted temporary machine usine-snapshot-/u);
  },
);

test(
  "stops a setup that prints nothing or runs too long, quotes its last lines, and deletes the machine",
  { timeout: 10_000 },
  async () => {
    const options = parseOptions(["usine-attempt"], env);
    for (const [setup, quietMs, setupTimeoutMs, message] of [
      [
        { exit: null },
        50,
        options.setupTimeoutMs,
        /^Error: The setup printed nothing for 0\.05 seconds\. Its last output lines:\n(?:pulled\nprogress|progress\npulled)$/u,
      ],
      [
        { exit: null, chatty: true },
        1_000,
        100,
        /^Error: The setup didn't finish within 0\.1 seconds\. Its last output lines:\n(?:.+\n){19}step \d+$/u,
      ],
    ]) {
      const boxd = fakeBoxd({ setup });
      const { result, logged } = run(boxd, { ...options, setupTimeoutMs }, undefined, { quietMs });
      await assert.rejects(result, message);
      assert.equal(boxd.state.stream.closed, true);
      assert.deepEqual(names(boxd).slice(-3), ["exec", "machine", "delete"]);
      assert.ok(
        logged.includes("boxd reports the temporary machine's egress as unrestricted"),
        logged.join("\n"),
      );
    }
  },
);

test("sends stdin in chunks of at most 64 KiB, byte-exact", () => {
  assert.equal(STDIN_CHUNK_BYTES, 65_536);
  const bytes = new Uint8Array(3 * 65_536 + 100).map((_, index) => index % 251);
  const stream = fakeStream();
  sendStdin(stream, bytes);
  assert.deepEqual(
    stream.stdin.map((chunk) => chunk.length),
    [65_536, 65_536, 65_536, 100],
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

test("limits the setup to 20 minutes, or the minutes that --setup-timeout names", () => {
  assert.equal(parseOptions(["usine-attempt"], env).setupTimeoutMs, 1_200_000);
  assert.equal(
    parseOptions(["--setup-timeout", "45", "usine-attempt"], env).setupTimeoutMs,
    2_700_000,
  );
});

test("refuses invalid options and a missing API key", () => {
  for (const [argv, environment] of [
    [[], env],
    [["--size", "small", "usine-attempt"], env],
    [["--size", "0x4", "usine-attempt"], env],
    [["--size", "2x0", "usine-attempt"], env],
    [["--size", "02x8", "usine-attempt"], env],
    [["--size", "2x08", "usine-attempt"], env],
    [["--size", "2X8", "usine-attempt"], env],
    [["--size", "2x8.5", "usine-attempt"], env],
    [["--size", "2x8x1", "usine-attempt"], env],
    [["--size", "x8", "usine-attempt"], env],
    [["--size", "2x", "usine-attempt"], env],
    [["--size", "28", "usine-attempt"], env],
    [["--size", "12345x8", "usine-attempt"], env],
    [["--size", "2x1234567", "usine-attempt"], env],
    [["--size", "2x8\n1x4", "usine-attempt"], env],
    [["--region", "NYC", "usine-attempt"], env],
    [["--endpoint", "", "usine-attempt"], env],
    [["--setup-timeout", "0", "usine-attempt"], env],
    [["--setup-timeout", "1.5", "usine-attempt"], env],
    [["--setup-timeout", "20m", "usine-attempt"], env],
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
