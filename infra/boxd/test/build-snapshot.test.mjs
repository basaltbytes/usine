import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import {
  build,
  clientOptions,
  main,
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
 * An `Exec` stream that relays one line on each output, then `chunks` on stdout, and exits with
 * `exit` after stdin closes, or never exits when `exit` is null. `onEnd` runs when stdin closes.
 * With `chatter`, the stream then prints a line on stdout every `chatter.everyMs` for
 * `chatter.forMs`, and exits only after that. With `silent`, the stream relays nothing. Closing the
 * stream ends it with an error, unless `cancellable` is false, as on a connection that no longer
 * carries bytes.
 */
const fakeStream = ({
  exit = 0,
  onEnd,
  chunks = [],
  chatter,
  cancellable = true,
  silent = false,
} = {}) => {
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
  const output = async function* (text, more = [], chatty) {
    if (!silent) yield new TextEncoder().encode(text);
    for (const chunk of more) yield new TextEncoder().encode(chunk);
    if (chatty !== undefined) {
      const start = Date.now();
      for (let line = 1; Date.now() - start < chatty.forMs; line += 1) {
        if (await Promise.race([ended, sleep(chatty.everyMs, false)])) break;
        yield new TextEncoder().encode(`step ${line}\n`);
      }
      if (exit !== null) finish(exit);
    }
    await ended;
  };
  return {
    stdin,
    ended: false,
    closed: false,
    stdout: output("pulled\n", chunks, chatter),
    stderr: output("progress\n"),
    write(data) {
      assert.equal(this.ended, false);
      stdin.push(data);
    },
    end() {
      this.ended = true;
      onEnd?.(this);
      if (exit !== null && chatter === undefined) finish(exit);
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
 * lifted report the allowlist of the machine's creation again. `create` waits for `creating`, and
 * each machine read waits `readMs` first. `close` sets `state.closed`.
 */
const fakeBoxd = ({
  setup,
  creating,
  reappliesEgress = false,
  failSave = false,
  failDelete = false,
  neverReady = false,
  specKeepsEgress = true,
  egressLags = [],
  previous,
  reads,
  readMs = 0,
} = {}) => {
  const events = [];
  const state = {
    egress: [],
    requested: [],
    lag: 0,
    edits: 0,
    specEgress: [],
    created: [],
    closed: false,
    liftedAt: undefined,
    setupDelay: undefined,
    snapshot: undefined,
    stream: undefined,
  };
  if (previous !== undefined) state.snapshot = [{ status: "ready", version: previous }];
  return {
    events,
    state,
    close: async () => {
      state.closed = true;
    },
    machines: {
      create: async (params) => {
        events.push(["create", params]);
        await creating;
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
        if (readMs > 0) await sleep(readMs);
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

/**
 * Runs `build` with fast timings and with `boxd` as each new client, unless `timing.connect` is
 * set. `onLog` sees each line that the build logs.
 */
const run = (boxd, options, signal = new AbortController().signal, { onLog, ...timing } = {}) => {
  const logged = [];
  const relayed = [];
  const result = build(boxd, options, {
    connect: () => boxd,
    log: (line) => {
      logged.push(line);
      onLog?.(line);
    },
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

/** A `connect` that returns a new fake with `settings` for each call and records it in `made`. */
const connector = (settings) => {
  const made = [];
  const connect = () => {
    const client = fakeBoxd(settings);
    made.push(client);
    return client;
  };
  return { made, connect };
};

/**
 * Asserts that `made` holds one client for each list of calls in `calls`, in order, so no client
 * carries a call after another one, and that each client is closed.
 */
const assertClients = (made, calls) => {
  assert.deepEqual(
    made.map((client) => client.events),
    calls,
  );
  assert.ok(made.every((client) => client.state.closed));
};

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
  assert.equal(boxd.state.stream.ended, true);
  assert.deepEqual(relayed.sort(), ["progress\n", "pulled\n"]);
  assert.match(logged[0], /^Created temporary machine usine-snapshot-/u);
  assert.ok(
    logged.includes(
      "boxd still reports the temporary machine's egress unrestricted 0 seconds later",
    ),
    logged.join("\n"),
  );
  assert.match(logged.at(-1), /^Deleted temporary machine usine-snapshot-/u);
});

/** Returns the setup script that a build sends to the machine. */
const setupScript = async () => {
  const boxd = fakeBoxd();
  await run(boxd, parseOptions(["usine-attempt"], env)).result;
  return Buffer.concat(boxd.state.stream.stdin).toString();
};

/**
 * A command that appends its name and arguments to `$LOG`. As `timeout`, it skips the command
 * that it limits, and exits `$FAIL_CODE` for the first `$FAIL_TIMES` runs of a command that
 * contains `$FAIL`. As `tee`, it also appends its input. As `id`, it prints a user ID.
 */
const STUB = `#!/bin/sh
name=$(basename "$0")
echo "$name $*" >> "$LOG"
case "$name" in
  timeout)
    shift 3
    if [ -n "$FAIL" ]; then
      case "$*" in
        *"$FAIL"*)
          runs=$(cat "$LOG.fails" 2>/dev/null || echo 0)
          runs=$((runs + 1))
          echo "$runs" > "$LOG.fails"
          if [ "$runs" -le "$FAIL_TIMES" ]; then exit "$FAIL_CODE"; fi
          ;;
      esac
    fi
    ;;
  tee) cat >> "$LOG" ;;
  id) echo 1000 ;;
esac
`;

/**
 * Runs the setup script with podman against stub commands, where the first `times` runs of a
 * limited command that contains `fail` exit with `code`; see `STUB`.
 */
const runSetupScript = async (script, { fail = "", times = 0, code = 124 } = {}) => {
  const dir = await mkdtemp(join(tmpdir(), "usine-setup-"));
  try {
    await writeFile(join(dir, "stub"), STUB);
    await chmod(join(dir, "stub"), 0o755);
    for (const name of ["timeout", "tee", "install", "podman", "apt-get", "loginctl"].concat([
      "systemctl",
      "curl",
      "rm",
      "sync",
      "id",
    ]))
      await symlink(join(dir, "stub"), join(dir, name));
    // `sudo` runs the command after it.
    await writeFile(join(dir, "sudo"), '#!/bin/sh\nexec "$@"\n');
    await chmod(join(dir, "sudo"), 0o755);
    const log = join(dir, "log");
    const pending = exec("/bin/sh", ["-s", "--", "podman", "ghcr.io/example/attempt:test"], {
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        LOG: log,
        FAIL: fail,
        FAIL_TIMES: String(times),
        FAIL_CODE: String(code),
      },
    });
    pending.child.stdin.end(script);
    const outcome = await pending.then(
      ({ stderr }) => ({ code: 0, stderr }),
      ({ code, stderr }) => ({ code, stderr }),
    );
    return { ...outcome, log: (await readFile(log, "utf8")).split("\n") };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const limited = (log) => log.filter((line) => line.startsWith("timeout "));

test("the setup limits apt and the Tailscale installer and runs each once more", async () => {
  const script = await setupScript();
  const passed = await runSetupScript(script);
  assert.equal(passed.code, 0, passed.stderr);
  assert.equal(passed.stderr, "");
  const config = passed.log.indexOf("tee /etc/apt/apt.conf.d/80usine-network");
  assert.deepEqual(passed.log.slice(config, config + 3), [
    "tee /etc/apt/apt.conf.d/80usine-network",
    'Acquire::http::Timeout "30";',
    'Acquire::https::Timeout "30";',
  ]);
  assert.deepEqual(limited(passed.log), [
    "timeout -k 10 120 apt-get --error-on=any update",
    "timeout -k 10 240 sh /tmp/usine-tailscale.sh",
  ]);

  const apt = await runSetupScript(script, { fail: "apt-get", times: 1 });
  assert.equal(apt.code, 0, apt.stderr);
  assert.equal(
    apt.stderr,
    "usine: apt-get update didn't finish within 120 seconds\nusine: running apt-get update again\n",
  );
  assert.deepEqual(limited(apt.log).slice(0, 2), [
    "timeout -k 10 120 apt-get --error-on=any update",
    "timeout -k 10 120 apt-get update",
  ]);

  const once = await runSetupScript(script, { fail: "usine-tailscale", times: 1 });
  assert.equal(once.code, 0, once.stderr);
  assert.equal(
    once.stderr,
    "usine: the Tailscale installer didn't finish within 240 seconds\nusine: running the Tailscale installer again\n",
  );
  assert.equal(limited(once.log).filter((line) => line.includes("usine-tailscale")).length, 2);

  const twice = await runSetupScript(script, { fail: "usine-tailscale", times: 2 });
  assert.equal(twice.code, 124);
  assert.equal(
    twice.stderr,
    "usine: the Tailscale installer didn't finish within 240 seconds\nusine: running the Tailscale installer again\nusine: the Tailscale installer didn't finish within 240 seconds\n",
  );
  assert.equal(twice.log.includes("systemctl enable tailscaled"), false);

  // `timeout` exits 137 when it sends KILL.
  const killed = await runSetupScript(script, { fail: "usine-tailscale", times: 1, code: 137 });
  assert.equal(killed.code, 0, killed.stderr);
  assert.equal(
    killed.stderr,
    "usine: the Tailscale installer didn't finish within 240 seconds\nusine: running the Tailscale installer again\n",
  );

  const failed = await runSetupScript(script, { fail: "apt-get", times: 1, code: 100 });
  assert.equal(failed.code, 0, failed.stderr);
  assert.equal(
    failed.stderr,
    "usine: apt-get update exited with code 100\nusine: running apt-get update again\n",
  );

  const failedTwice = await runSetupScript(script, { fail: "usine-tailscale", times: 2, code: 1 });
  assert.equal(failedTwice.code, 1);
  assert.equal(
    failedTwice.stderr,
    "usine: the Tailscale installer exited with code 1\nusine: running the Tailscale installer again\nusine: the Tailscale installer exited with code 1\n",
  );
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
  "an interrupt ends the setup and deletes the machine at once through a client of its own",
  { timeout: 10_000 },
  async () => {
    const controller = new AbortController();
    // The setup's connection no longer carries bytes, so closing the stream doesn't end it.
    const boxd = fakeBoxd({
      setup: { exit: null, cancellable: false, onEnd: () => controller.abort(130) },
    });
    const { made, connect } = connector();
    const { result, logged } = run(boxd, parseOptions(["usine-attempt"], env), controller.signal, {
      connect,
    });
    await assert.rejects(result, /^Error: Interrupted$/u);
    assert.equal(boxd.state.stream.closed, true);
    assert.equal(names(boxd).at(-1), "exec");
    assertClients(made, [[["delete", "vm-1"]]]);
    assert.equal(logged.at(-2), "Interrupted; deleting the temporary machine");
    assert.match(logged.at(-1), /^Deleted temporary machine usine-snapshot-/u);
  },
);

test(
  "stops a setup that prints nothing or runs too long, quotes its last lines, reads the egress and deletes the machine through new clients",
  { timeout: 10_000 },
  async () => {
    const options = parseOptions(["usine-attempt"], env);
    const lines = Array.from({ length: 25 }, (_, index) => `line ${index + 1}\n`);
    for (const [setup, quietMs, setupTimeoutMs, message] of [
      [
        { exit: null },
        50,
        options.setupTimeoutMs,
        /^Error: The setup printed nothing for 0\.05 seconds\. Its last output lines:\n(?:pulled\nprogress|progress\npulled)$/u,
      ],
      // Without output, the quiet limit fires long before the overall one.
      [
        { exit: null, silent: true },
        50,
        5_000,
        /^Error: The setup printed nothing for 0\.05 seconds\. It printed no output$/u,
      ],
      // The lines arrive at once, so the tail is complete before the overall limit fires.
      [
        { exit: null, chunks: lines },
        1_000,
        100,
        new RegExp(
          `^Error: The setup didn't finish within 0\\.1 seconds\\. Its last output lines:\\n${lines.slice(5).join("").trimEnd()}$`,
          "u",
        ),
      ],
    ]) {
      const boxd = fakeBoxd({ setup });
      const { made, connect } = connector();
      const { result, logged } = run(boxd, { ...options, setupTimeoutMs }, undefined, {
        connect,
        quietMs,
      });
      await assert.rejects(result, message);
      assert.equal(boxd.state.stream.closed, true);
      assert.equal(names(boxd).at(-1), "exec");
      assertClients(made, [[["machine", []]], [["delete", "vm-1"]]]);
      assert.ok(
        logged.includes("boxd reports the temporary machine's egress as unrestricted"),
        logged.join("\n"),
      );
    }
  },
);

test("output resets the quiet limit", { timeout: 10_000 }, async () => {
  // The setup prints for longer than the quiet limit, with gaps shorter than it.
  const boxd = fakeBoxd({ setup: { chatter: { everyMs: 20, forMs: 600 } } });
  const { result, relayed } = run(boxd, parseOptions(["usine-attempt"], env), undefined, {
    quietMs: 250,
  });
  assert.equal(await result, "usine-attempt");
  assert.ok(relayed.length > 10, relayed.join(""));
});

/** The number of timers that keep the process running. */
const timers = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;

test("leaves no timer behind when the setup ends", async () => {
  const before = timers();
  const { result } = run(fakeBoxd(), parseOptions(["usine-attempt"], env), undefined, {
    quietMs: 60_000,
  });
  assert.equal(await result, "usine-attempt");
  assert.equal(timers(), before);
});

test(
  "logs the egress reads before it deletes the machine or restricts its egress again",
  { timeout: 10_000 },
  async () => {
    const options = parseOptions(["usine-attempt"], env);
    const timedOut = "usine: the Tailscale installer didn't finish within 240 seconds\n";
    for (const [setup, settings] of [
      // The setup exits right after the timeout line, with a failure and with success.
      [{ exit: 124, chunks: [timedOut] }, {}],
      [{ exit: 0, chunks: [timedOut] }, {}],
      [{ exit: null }, { ...options, setupTimeoutMs: 50 }],
    ]) {
      const boxd = fakeBoxd({ setup });
      const { made, connect } = connector({ readMs: 50 });
      const { result, logged } = run(boxd, { ...options, ...settings }, undefined, { connect });
      await result.catch(() => {});
      const read = logged.indexOf("boxd reports the temporary machine's egress as unrestricted");
      const after = logged.findIndex(
        (line) =>
          line.startsWith("Deleted temporary machine") || line.startsWith("Saving snapshot"),
      );
      assert.ok(read !== -1 && read < after, logged.join("\n"));
      assertClients(made, [[["machine", []]], [["delete", "vm-1"]]]);
    }
  },
);

test("reads the egress through a new client when a command in the setup times out", async () => {
  const boxd = fakeBoxd({
    setup: {
      // The line is split across two chunks.
      chunks: [
        "usine: the Tailscale installer didn't fin",
        "ish within 240 seconds\nusine: running the Tailscale installer again\n",
      ],
    },
  });
  const { made, connect } = connector();
  const { result, logged } = run(boxd, parseOptions(["usine-attempt"], env), undefined, {
    connect,
  });
  assert.equal(await result, "usine-attempt");
  assertClients(made, [[["machine", []]], [["delete", "vm-1"]]]);
  const read = logged.indexOf("boxd reports the temporary machine's egress as unrestricted");
  assert.ok(
    read !== -1 && read < logged.indexOf("Saving snapshot usine-attempt"),
    logged.join("\n"),
  );
});

test(
  "an interrupt during the wait after the lift deletes the machine at once",
  { timeout: 10_000 },
  async () => {
    const controller = new AbortController();
    const boxd = fakeBoxd();
    const { made, connect } = connector();
    let interruptedAt;
    let deletedAt;
    const { result, logged } = run(boxd, parseOptions(["usine-attempt"], env), controller.signal, {
      connect,
      egressInForceMs: 1_000,
      onLog: (line) => {
        if (line === "boxd reports the temporary machine's egress unrestricted") {
          interruptedAt = Date.now();
          controller.abort(130);
        }
        if (line.startsWith("Deleted temporary machine")) deletedAt = Date.now();
      },
    });
    await assert.rejects(result, /^Error: Interrupted$/u);
    assert.ok(deletedAt - interruptedAt < 500, `deleted ${deletedAt - interruptedAt} ms after`);
    assert.equal(names(boxd).includes("exec"), false);
    assert.equal(names(boxd).includes("delete"), false);
    assertClients(made, [[["delete", "vm-1"]]]);
    assert.ok(logged.includes("Interrupted; deleting the temporary machine"), logged.join("\n"));
  },
);

test("an interrupt during the machine's creation logs at once and deletes the machine once boxd creates it", async () => {
  const controller = new AbortController();
  const { promise: creating, resolve: created } = Promise.withResolvers();
  const boxd = fakeBoxd({ creating });
  const { made, connect } = connector();
  const { result, logged } = run(boxd, parseOptions(["usine-attempt"], env), controller.signal, {
    connect,
  });
  controller.abort(130);
  assert.deepEqual(logged, ["Interrupted; deleting the temporary machine"]);
  created();
  await assert.rejects(result, /^Error: Interrupted$/u);
  assert.deepEqual(names(boxd), ["create"]);
  assertClients(made, [[["delete", "vm-1"]]]);
  assert.match(logged.at(-1), /^Deleted temporary machine usine-snapshot-/u);
});

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
    // More minutes than `setTimeout` takes.
    [["--setup-timeout", "10000", "usine-attempt"], env],
    [["--setup-timeout", "35792", "usine-attempt"], env],
    [["--vcpu", "2", "usine-attempt"], env],
    [["Usine_Attempt"], env],
    [["usine-attempt"], { ...env, BOXD_API_KEY: "" }],
    [["usine-attempt"], { ...env, USINE_CONTAINER_RUNTIME: "lxc" }],
    [["usine-attempt"], { ...env, ATTEMPT_IMAGE: "ghcr.io/x;rm -rf /" }],
  ])
    assert.throws(() => parseOptions(argv, environment), UsageError);
});

test("the command line deletes the machine through a client of its own", async () => {
  const controller = new AbortController();
  const { promise: creating, resolve: created } = Promise.withResolvers();
  const made = [];
  const connected = [];
  const logged = [];
  const printed = [];
  const exitCode = main(["--endpoint", "https://127.0.0.1:1", "usine-attempt"], env, {
    connect: (options) => {
      connected.push(options);
      const client = fakeBoxd({ creating });
      made.push(client);
      return client;
    },
    log: (line) => logged.push(line),
    output: { write: () => {} },
    print: (name) => printed.push(name),
    signal: controller.signal,
  });
  controller.abort(130);
  created();
  assert.equal(await exitCode, 130);
  assert.deepEqual(connected, [
    { apiKey: "bxd_test", baseURL: "https://127.0.0.1:1" },
    { apiKey: "bxd_test", baseURL: "https://127.0.0.1:1" },
  ]);
  assert.deepEqual(names(made[0]), ["create"]);
  assertClients(made.slice(1), [[["delete", "vm-1"]]]);
  assert.equal(made[0].state.closed, true);
  assert.deepEqual(printed, []);
  assert.equal(logged.at(-1), "Interrupted");
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
