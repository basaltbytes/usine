import { NodeServices } from "@effect/platform-node";
import {
  type Cause,
  Clock,
  Config,
  Deferred,
  Duration,
  Effect,
  Exit,
  Option,
  Predicate,
  Queue,
  Ref,
  Schema,
  Scope,
  Sink,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/process";
import { assert, describe, it } from "@effect/vitest";
import { AgentSessionId } from "@usine/core/agent/session";
// The Node process boundary uses native process handles and synchronous subprocess operations.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFileSync, spawn, spawnSync } from "node:child_process";
// This Node boundary needs synchronous filesystem operations that FileSystem does not expose.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { PROCESS_OWNER } from "../src/child-host/supervisor.ts";
import { CHILD_LIFELINE, startChildProcess } from "../src/child-host/node.ts";
import { claudeOutputCheckpoint } from "../src/harness/claude/sdk.ts";
import { ChildSessionLifecycle } from "../src/runtime.ts";
// Synchronous Node path callbacks retain the host platform’s path semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import {
  CHILD_KILL_SCRIPT,
  CHILD_STOP_SCRIPT,
  childPidFile,
  type HostInvocation,
  RemoteShell,
  sshArguments,
} from "../src/child-host/child-host.ts";

const host = RemoteShell.make({
  ssh: { command: "ssh", args: ["-o", "BatchMode=yes"] },
  sshEnvironment: {},
  destination: "worker.exe.xyz",
});

/** Returns the single remote command line passed to ssh after `--`. */
const remoteLine = (invocation: HostInvocation): string => {
  const [option, value, destination, separator, line, ...rest] = sshArguments(host, invocation);
  assert.deepStrictEqual(
    [option, value, destination, separator, rest],
    ["-o", "BatchMode=yes", "worker.exe.xyz", "--", []],
  );
  assert(line !== undefined);
  return line;
};

describe("remote shell commands", () => {
  it("keeps a plain command a quoted exec", () => {
    assert.strictEqual(
      remoteLine({ command: "git", args: ["log", "it's"] }),
      `exec 'git' 'log' 'it'"'"'s'`,
    );
  });

  it("runs in its directory with exported variables and records its pid only while it runs", () => {
    const worktree = mkdtempSync(join(tmpdir(), "usine-remote-shell-"));
    const pidFile = childPidFile(worktree, AgentSessionId.make("parent:attempt/1:child:3"));
    assert.strictEqual(pidFile, `${worktree}.child-3.pid`);
    const line = remoteLine({
      cwd: worktree,
      environment: { GREETING: "it's $HOME", SKIPPED: undefined },
      pidFile,
      command: "sh",
      args: [
        "-c",
        'printf "%s|%s|%s|%s" "$PWD" "$GREETING" "$(cat "$1")" "$$" > seen',
        "sh",
        pidFile,
      ],
    });
    execFileSync("sh", ["-c", line]);
    const [cwd, greeting, recorded, pid] = readFileSync(join(worktree, "seen"), "utf8").split("|");
    assert.strictEqual(cwd, worktree);
    assert.strictEqual(greeting, "it's $HOME");
    assert.strictEqual(recorded, pid, "the pid file names the command itself");
    assert.strictEqual(existsSync(pidFile), false, "the pid file is gone once the command exits");
  });

  it("keeps the command's exit code", () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "usine-remote-shell-")), "child-1.pid");
    const line = remoteLine({ pidFile, command: "sh", args: ["-c", "exit 7"] });
    assert.strictEqual(spawnSync("sh", ["-c", line]).status, 7);
  });

  it.live("stops a running child through its pid file and leaves nothing to stop after", () =>
    Effect.gen(function* () {
      const worktree = mkdtempSync(join(tmpdir(), "usine-remote-shell-"));
      const pidFile = childPidFile(worktree, AgentSessionId.make("parent:attempt/1:child:1"));
      const child = spawn("sh", ["-c", remoteLine({ pidFile, command: "sleep", args: ["30"] })]);
      const exited = (() => {
        const completion = Deferred.makeUnsafe<void>();
        const resolve = () => {
          Deferred.doneUnsafe(completion, Effect.void);
        };
        child.once("exit", resolve);
        return Deferred.await(completion);
      })();
      while (!existsSync(pidFile) || readFileSync(pidFile, "utf8") === "")
        yield* Clock.Clock.defaultValue().sleep(Duration.millis(10));
      const stop = () =>
        execFileSync("sh", ["-c", CHILD_KILL_SCRIPT, "sh", worktree], { encoding: "utf8" }).trim();
      assert.strictEqual(stop(), `${pidFile} stopped`);
      yield* exited;
      assert.strictEqual(existsSync(pidFile), false);
      assert.strictEqual(stop(), "no-children");
    }),
  );

  it.live("stops one child through its pid file and leaves its siblings running", () =>
    Effect.gen(function* () {
      const worktree = mkdtempSync(join(tmpdir(), "usine-remote-shell-"));
      const started = (child: number) => {
        const pidFile = childPidFile(
          worktree,
          AgentSessionId.make(`parent:attempt/1:child:${child}`),
        );
        const process = spawn("sh", [
          "-c",
          remoteLine({ pidFile, command: "sleep", args: ["30"] }),
        ]);
        return {
          pidFile,
          exited: (() => {
            const completion = Deferred.makeUnsafe<void>();
            const resolve = () => {
              Deferred.doneUnsafe(completion, Effect.void);
            };
            process.once("exit", resolve);
            return Deferred.await(completion);
          })(),
        };
      };
      const [stopped, sibling] = [started(1), started(2)];
      for (const { pidFile } of [stopped, sibling])
        while (!existsSync(pidFile) || readFileSync(pidFile, "utf8") === "")
          yield* Clock.Clock.defaultValue().sleep(Duration.millis(10));
      const stop = () =>
        execFileSync("sh", ["-c", CHILD_STOP_SCRIPT, "sh", stopped.pidFile], {
          encoding: "utf8",
        }).trim();
      assert.strictEqual(stop(), `${stopped.pidFile} stopped`);
      yield* stopped.exited;
      assert.strictEqual(stop(), `${stopped.pidFile} absent`);
      assert.isTrue(existsSync(sibling.pidFile), "the sibling still runs");
      execFileSync("sh", ["-c", CHILD_KILL_SCRIPT, "sh", worktree]);
      yield* sibling.exited;
    }),
  );

  it("runs the command line inside a container with its directory, variables, and pid file", () => {
    const worktree = mkdtempSync(join(tmpdir(), "usine-remote-shell-"));
    // Stands in for `docker exec -i <name> ...` by running the rest of its arguments.
    const runtime = join(worktree, "fake-runtime");
    writeFileSync(
      runtime,
      '#!/bin/sh\n[ "$1" = exec ] && [ "$2" = -i ] && [ "$3" = usine-attempt ] || exit 99\nshift 3\nexec "$@"\n',
      { mode: 0o755 },
    );
    const contained = RemoteShell.make({ ...host, container: { runtime, name: "usine-attempt" } });
    const pidFile = childPidFile(worktree, AgentSessionId.make("parent:attempt/1:child:2"));
    const [, , , , line] = sshArguments(contained, {
      cwd: worktree,
      environment: { GREETING: "it's $HOME" },
      pidFile,
      command: "sh",
      args: ["-c", 'printf "%s|%s|%s" "$PWD" "$GREETING" "$(cat "$1")" > seen', "sh", pidFile],
    });
    assert(line !== undefined);
    assert.isTrue(line.startsWith(`exec '${runtime}' 'exec' '-i' 'usine-attempt' 'sh' '-c' `));
    execFileSync("sh", ["-c", line]);
    const [cwd, greeting, recorded] = readFileSync(join(worktree, "seen"), "utf8").split("|");
    assert.strictEqual(cwd, worktree);
    assert.strictEqual(greeting, "it's $HOME");
    assert.match(recorded ?? "", /^\d+$/u);
    assert.strictEqual(existsSync(pidFile), false);
  });

  it("refuses a variable name the shell would not read as one", () => {
    assert.throws(
      () => remoteLine({ environment: { "A;B": "x" }, command: "true", args: [] }),
      /Cannot export A;B/u,
    );
  });
});

// Process callbacks decode wire frames synchronously.
// @effect-diagnostics-next-line schemaSync:off
const decodeOwnerFrame = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      offset: Schema.Int,
      stdout: Schema.optionalKey(Schema.String),
      ready: Schema.optionalKey(Schema.Boolean),
      exitCode: Schema.optionalKey(Schema.Int),
      stderrTail: Schema.optionalKey(Schema.String),
      ack: Schema.optionalKey(Schema.Int),
    }),
  ),
);
// @effect-diagnostics-next-line schemaSync:off
const encodeOwnerFrame = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const sleep = (ms: number) => Clock.Clock.defaultValue().sleep(Duration.millis(ms));
const eventually = (predicate: () => boolean) =>
  Effect.gen(function* () {
    for (let n = 0; !predicate(); n++) {
      assert(n < 500, "process condition did not settle");
      yield* sleep(10);
    }
  });

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const workerRelay = (
  pidFile: string,
  mode: "attach" | "resume",
  cursor: number,
  lease: number,
  command: string,
  args: ReadonlyArray<string>,
  environment: Readonly<Record<string, string>> = {},
  loginEnvironment: Readonly<Record<string, string>> = {},
) => {
  const shim = join(mkdtempSync(join(tmpdir(), "usine-ssh-shim-")), "ssh");
  writeFileSync(shim, '#!/bin/sh\n[ "$2" = -- ] || exit 99\nexec sh -c "$3"\n', { mode: 0o755 });
  const worker = RemoteShell.make({
    ssh: { command: shim, args: [] },
    sshEnvironment: {},
    destination: "worker",
  });
  const child = spawn(
    shim,
    sshArguments(worker, {
      command: process.execPath,
      args: ["-e", PROCESS_OWNER, mode, pidFile, String(cursor), String(lease), command, ...args],
      environment: {},
    }),
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...loginEnvironment } },
  );
  child.stdin.write(encodeOwnerFrame(environment) + "\n");
  const frames: Array<{
    offset: number;
    stdout?: string;
    ready?: boolean;
    exitCode?: number;
    stderrTail?: string;
    ack?: number;
  }> = [];
  let buffer = "";
  child.stdout.on("data", (data) => {
    buffer += String(data);
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      frames.push(decodeOwnerFrame(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  return { child, frames };
};

it.skipIf(process.platform === "linux")(
  "rejects a worker without Linux /proc before spawning its owner",
  () => {
    const cwd = mkdtempSync(join(tmpdir(), "usine-owner-unsupported-"));
    const pidFile = childPidFile(cwd, AgentSessionId.make("attempt:child:1"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          "-e",
          PROCESS_OWNER,
          "replace",
          pidFile,
          "0",
          "120000",
          process.execPath,
          "-e",
          "process.stdin.resume()",
        ],
        { encoding: "utf8", timeout: 2000 },
      );
      assert.strictEqual(result.status, 1);
      assert.include(result.stderr, "The child process owner requires Linux /proc");
      assert.isFalse(existsSync(`${pidFile}.transport`));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);

describe.skipIf(process.platform !== "linux")("worker process owner", () => {
  for (const contained of [false, true]) {
    it.live(
      `keeps credentials out of SSH argv during child launch and stop${contained ? " in a container" : ""}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const cwd = mkdtempSync(join(tmpdir(), "usine-owner-credentials-"));
            const shim = join(cwd, "ssh");
            const runtime = join(cwd, "runtime");
            const commands = join(cwd, "commands");
            const seen = join(cwd, "seen");
            const stderr = join(cwd, "stderr");
            const shellPath = yield* Config.String("PATH");
            const token = "gateway-credential-1024";
            const value = "it's $HOME\nλ";
            writeFileSync(
              shim,
              `#!/bin/sh\nprintf "%s\\n" "$3" >> "${commands}"\nexec sh -c "$3" 2>> "${stderr}"\n`,
              { mode: 0o755 },
            );
            writeFileSync(runtime, '#!/bin/sh\nshift 3\nexec "$@"\n', { mode: 0o755 });
            let worker = RemoteShell.make({
              ssh: { command: shim, args: [] },
              sshEnvironment: { PATH: shellPath },
              destination: "worker",
            });
            if (contained)
              worker = RemoteShell.make({ ...worker, container: { runtime, name: "attempt" } });
            const owner = yield* startChildProcess(
              {
                host: worker,
                cwd,
                environment: { GATEWAY_TOKEN: token, EXPORTED: value },
                sessionId: Option.some(AgentSessionId.make("attempt:child:1")),
              },
              {
                command: process.execPath,
                args: [
                  "-e",
                  "require('node:fs').writeFileSync('seen', JSON.stringify([process.env.GATEWAY_TOKEN, process.env.EXPORTED]));process.stdin.resume()",
                ],
                cwd,
              },
              Stream.never,
            );
            yield* eventually(() => existsSync(seen));
            assert.strictEqual(readFileSync(seen, "utf8"), encodeOwnerFrame([token, value]));
            assert.notInclude(execFileSync("ps", ["-eo", "args"], { encoding: "utf8" }), token);
            yield* owner.kill();
            const lines = readFileSync(commands, "utf8");
            assert.notInclude(lines, token);
            assert.notInclude(lines, value);
            assert.include(lines, "'stop'");
            assert.include(lines, "'remove'");
            assert.notInclude(readFileSync(stderr, "utf8"), token);
            assert.isFalse(
              existsSync(childPidFile(cwd, AgentSessionId.make("attempt:child:1")) + ".transport"),
            );
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      15_000,
    );
  }

  it.live(
    "resumes output at the first unhandled byte of a partly handled stdout frame",
    () =>
      Effect.gen(function* () {
        const cwd = mkdtempSync(join(tmpdir(), "usine-owner-partial-"));
        const shim = join(cwd, "ssh");
        writeFileSync(shim, '#!/bin/sh\nexec sh -c "$3"\n', { mode: 0o755 });
        const target = {
          host: RemoteShell.make({
            ssh: { command: shim, args: [] },
            sshEnvironment: { PATH: yield* Config.String("PATH") },
            destination: "worker",
          }),
          cwd,
          environment: {},
          sessionId: Option.some(AgentSessionId.make("attempt:child:1")),
        };
        const harness = {
          command: process.execPath,
          args: [
            "-e",
            'process.stdout.write("one\\ntwo\\nthree\\n");process.stdin.on("data", () => process.stdout.write("four\\nfive\\n"))',
          ],
          cwd,
        };
        const connect = Effect.fnUntraced(function* (
          transport: "resume" | undefined,
          input: Stream.Stream<Uint8Array>,
        ) {
          const stopping = yield* Ref.make(false);
          const scope = yield* Scope.make();
          const received: Array<string> = [];
          const owner = yield* Effect.gen(function* () {
            const owner = yield* startChildProcess(target, harness, input, transport, "handled");
            yield* owner.stdout.pipe(
              Stream.runForEach((bytes) =>
                Effect.sync(() => received.push(Buffer.from(bytes).toString())),
              ),
              Effect.forkScoped,
            );
            return owner;
          }).pipe(
            Effect.provideService(ChildSessionLifecycle, { isStopping: Ref.get(stopping) }),
            Scope.provide(scope),
          );
          return {
            owner,
            received,
            detach: Ref.set(stopping, true).pipe(Effect.andThen(Scope.close(scope, Exit.void))),
            stop: Scope.close(scope, Exit.void),
          };
        });
        const first = yield* connect(undefined, Stream.never);
        yield* eventually(() => first.received.length > 0);
        assert.deepStrictEqual(first.received, ["one\ntwo\nthree\n"]);
        yield* first.owner.acknowledgeOutput("one\n".length);
        yield* first.detach;
        const input = yield* Queue.unbounded<Uint8Array, Cause.Done>();
        const second = yield* connect("resume", Stream.fromQueue(input));
        yield* eventually(() => second.received.length > 0);
        assert.deepStrictEqual(second.received, ["two\nthree\n"]);
        yield* Queue.offer(input, Buffer.from("more"));
        yield* eventually(() => second.received.length > 1);
        assert.deepStrictEqual(second.received, ["two\nthree\n", "four\nfive\n"]);
        yield* second.owner.acknowledgeOutput("two\nthree\n".length);
        yield* second.owner.acknowledgeOutput("four\n".length);
        yield* second.detach;
        const third = yield* connect("resume", Stream.never);
        yield* eventually(() => third.received.length > 0);
        assert.deepStrictEqual(third.received, ["five\n"]);
        yield* third.stop;
      }).pipe(Effect.provide(NodeServices.layer)),
    20_000,
  );

  it.live(
    "retains the process across SSH login changes and replaces it when exported variables change",
    () =>
      Effect.gen(function* () {
        const cwd = mkdtempSync(join(tmpdir(), "usine-owner-environment-"));
        const pidFile = childPidFile(cwd, AgentSessionId.make("attempt:child:1"));
        const command = ["-e", "process.stdout.write(process.env.EXPORTED);process.stdin.resume()"];
        const first = workerRelay(
          pidFile,
          "attach",
          0,
          10_000,
          process.execPath,
          command,
          { EXPORTED: "first" },
          { XDG_SESSION_ID: "11" },
        );
        yield* eventually(() => first.frames.some((frame) => frame.stdout));
        const owner = Number(readFileSync(pidFile, "utf8"));
        first.child.stdin.end();
        const resumed = workerRelay(
          pidFile,
          "resume",
          0,
          10_000,
          process.execPath,
          command,
          { EXPORTED: "first" },
          { XDG_SESSION_ID: "12", XDG_RUNTIME_DIR: "/run/changed" },
        );
        yield* eventually(() => resumed.frames.some((frame) => frame.ready));
        assert.strictEqual(Number(readFileSync(pidFile, "utf8")), owner);
        resumed.child.stdin.end();
        const replacement = workerRelay(
          pidFile,
          "resume",
          0,
          10_000,
          process.execPath,
          command,
          { EXPORTED: "second" },
          { XDG_SESSION_ID: "13" },
        );
        yield* eventually(() => replacement.frames.some((frame) => frame.stdout));
        assert.notStrictEqual(Number(readFileSync(pidFile, "utf8")), owner);
        assert.isFalse(alive(owner));
        assert.strictEqual(
          Buffer.from(
            replacement.frames.find((frame) => frame.stdout)?.stdout ?? "",
            "base64",
          ).toString(),
          "second",
        );
        replacement.child.stdin.write(encodeOwnerFrame({ sequence: 1, eof: true }) + "\n");
        yield* eventually(() => replacement.frames.some((frame) => frame.exitCode === 0));
      }),
    15_000,
  );

  for (const stale of ["dead", "missing", "reused", "rebooted"] as const) {
    it.live(
      `reports process loss after an owner crash with a ${stale} PID`,
      () =>
        Effect.gen(function* () {
          const cwd = mkdtempSync(join(tmpdir(), "usine-owner-crash-"));
          const pidFile = childPidFile(cwd, AgentSessionId.make("attempt:child:1"));
          const relay = workerRelay(pidFile, "attach", 0, 10_000, process.execPath, [
            "-e",
            "process.stdout.write(String(process.pid));process.stdin.resume()",
          ]);
          yield* eventually(() => relay.frames.some((frame) => frame.stdout));
          const owner = Number(readFileSync(pidFile, "utf8"));
          const lifeline = Number(readFileSync(`${pidFile}.transport/process`, "utf8"));
          const harness = Number(
            Buffer.from(
              relay.frames.find((frame) => frame.stdout)?.stdout ?? "",
              "base64",
            ).toString(),
          );
          relay.child.kill("SIGKILL");
          process.kill(owner, "SIGSTOP");
          process.kill(lifeline, "SIGKILL");
          process.kill(harness, "SIGKILL");
          process.kill(owner, "SIGKILL");
          assert.isFalse(existsSync(`${pidFile}.transport/exit`));
          const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            stdio: "ignore",
          });
          assert(unrelated.pid !== undefined);
          try {
            if (stale === "missing") rmSync(pidFile);
            if (stale === "reused" || stale === "rebooted") {
              writeFileSync(pidFile, String(unrelated.pid));
              const stat = readFileSync(`/proc/${unrelated.pid}/stat`, "utf8");
              const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
              const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
              writeFileSync(
                `${pidFile}.transport/identity`,
                stale === "rebooted"
                  ? `previous-boot:${unrelated.pid}:${start}`
                  : `${boot}:${unrelated.pid}:0`,
              );
            }
            const reattached = workerRelay(pidFile, "attach", 0, 10_000, process.execPath, [
              "-e",
              "process.stdin.resume()",
            ]);
            yield* eventually(() => reattached.frames.some((frame) => frame.exitCode === 1));
            assert.include(
              reattached.frames.find((frame) => frame.exitCode === 1)?.stderrTail ?? "",
              "owner disappeared",
            );
            assert(alive(unrelated.pid), "reattachment must not signal a reused PID");
            if (stale === "reused" || stale === "rebooted") {
              const identity = readFileSync(`${pidFile}.transport/identity`, "utf8");
              writeFileSync(pidFile, String(unrelated.pid));
              writeFileSync(`${pidFile}.transport/process`, String(unrelated.pid));
              execFileSync(process.execPath, ["-e", PROCESS_OWNER, "stop", pidFile, "0", "10000"]);
              assert(alive(unrelated.pid), "owner stop must not signal a reused PID");
              writeFileSync(pidFile, String(unrelated.pid));
              writeFileSync(`${pidFile}.transport/identity`, identity);
              execFileSync("sh", ["-c", CHILD_KILL_SCRIPT, "sh", cwd]);
              assert(alive(unrelated.pid), "attempt cleanup must not signal a reused PID");
            }
            const recovered = workerRelay(pidFile, "resume", 0, 10_000, process.execPath, [
              "-e",
              "process.stdin.resume()",
            ]);
            yield* eventually(() => recovered.frames.some((frame) => frame.ready));
            assert.notStrictEqual(Number(readFileSync(pidFile, "utf8")), owner);
            recovered.child.stdin.write(encodeOwnerFrame({ sequence: 1, eof: true }) + "\n");
            yield* eventually(() => recovered.frames.some((frame) => frame.exitCode === 0));
          } finally {
            unrelated.kill("SIGKILL");
          }
        }),
      15_000,
    );
  }

  it.live(
    "reattaches one process and deduplicates replayed input after transport loss and restart",
    () =>
      Effect.gen(function* () {
        const cwd = mkdtempSync(join(tmpdir(), "usine-owner-"));
        const pidFile = childPidFile(cwd, AgentSessionId.make("attempt:child:1"));
        const program = `require("node:fs").appendFileSync(${encodeOwnerFrame(join(cwd, "launches"))}, String(process.pid) + "\\n"); process.stdin.on("data", data => process.stdout.write(data));`;
        const first = workerRelay(pidFile, "attach", 0, 10_000, process.execPath, ["-e", program]);
        yield* eventually(() => first.frames.some((frame) => frame.ready));
        const owner = Number(readFileSync(pidFile, "utf8"));
        const message =
          encodeOwnerFrame({ sequence: 1, data: Buffer.from("once\n").toString("base64") }) + "\n";
        first.child.stdin.write(message);
        yield* eventually(() => first.frames.some((frame) => frame.stdout));
        const cursor = first.frames.at(-1)?.offset ?? 0;
        first.child.kill("SIGKILL");
        const second = workerRelay(pidFile, "attach", cursor, 10_000, process.execPath, [
          "-e",
          program,
        ]);
        yield* eventually(() => second.frames.some((frame) => frame.ready));
        second.child.stdin.write(message);
        yield* eventually(() => second.frames.some((frame) => frame.ack === 1));
        assert.strictEqual(Number(readFileSync(pidFile, "utf8")), owner);
        assert.isFalse(
          second.frames.some((frame) => frame.stdout),
          "acknowledged input must not run twice",
        );
        second.child.stdin.end();
        const restarted = workerRelay(pidFile, "resume", 0, 10_000, process.execPath, [
          "-e",
          program,
        ]);
        yield* eventually(() => restarted.frames.some((frame) => frame.ready));
        assert.strictEqual(
          Number(readFileSync(pidFile, "utf8")),
          owner,
          "orderly restart retains the owner",
        );
        assert.lengthOf(
          readFileSync(join(cwd, "launches"), "utf8").trim().split("\n"),
          1,
          "one harness process across both reattachments",
        );
        assert.deepStrictEqual(
          readdirSync(join(cwd, "..")).filter(
            (name) => name.startsWith(cwd.split("/").at(-1) + ".child-") && name.endsWith(".pid"),
          ),
          [pidFile.split("/").at(-1)],
        );
        restarted.child.stdin.write(encodeOwnerFrame({ sequence: 2, eof: true }) + "\n");
        yield* eventually(() => restarted.frames.some((frame) => frame.exitCode === 0));
        yield* eventually(() => !existsSync(pidFile));
        assert.deepStrictEqual(
          readdirSync(join(cwd, "..")).filter(
            (name) => name.startsWith(cwd.split("/").at(-1) + ".child-") && name.endsWith(".pid"),
          ),
          [],
        );
      }),
    15_000,
  );

  it.live(
    "expires the lease even when a worker relay survives its orchestrator",
    () =>
      Effect.gen(function* () {
        const cwd = mkdtempSync(join(tmpdir(), "usine-owner-lease-"));
        const pidFile = childPidFile(cwd, AgentSessionId.make("attempt:child:1"));
        const relay = workerRelay(pidFile, "attach", 0, 200, process.execPath, [
          "-e",
          "process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)",
        ]);
        yield* eventually(() => relay.frames.some((frame) => frame.stdout));
        const pid = Number(
          Buffer.from(
            relay.frames.find((frame) => frame.stdout)?.stdout ?? "",
            "base64",
          ).toString(),
        );
        assert(alive(pid));
        yield* eventually(() => relay.frames.some((frame) => frame.exitCode !== undefined));
        assert.isFalse(alive(pid));
        assert.isFalse(existsSync(pidFile));
        assert.isTrue(existsSync(`${pidFile}.transport`));
        execFileSync("sh", ["-c", CHILD_KILL_SCRIPT, "sh", cwd]);
        assert.isFalse(existsSync(`${pidFile}.transport`));
      }),
    10_000,
  );

  it.live(
    "replaces legacy process groups before creating one shared owner",
    () =>
      Effect.gen(function* () {
        const cwd = mkdtempSync(join(tmpdir(), "usine-owner-upgrade-"));
        const pidFile = childPidFile(cwd, AgentSessionId.make("attempt:child:1"));
        const legacy = [pidFile, pidFile.replace(/\.pid$/u, "-resume.pid")].map((file) => {
          const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            detached: true,
            stdio: "ignore",
          });
          assert(child.pid !== undefined);
          writeFileSync(file, String(-child.pid));
          return child;
        });
        const relay = workerRelay(pidFile, "resume", 0, 5000, process.execPath, [
          "-e",
          "process.stdin.resume();",
        ]);
        yield* eventually(() => relay.frames.some((frame) => frame.ready));
        for (const child of legacy) assert.isFalse(alive(child.pid ?? 0));
        assert.isFalse(existsSync(pidFile.replace(/\.pid$/u, "-resume.pid")));
        assert(Number(readFileSync(pidFile, "utf8")) > 0);
        relay.child.stdin.write(encodeOwnerFrame({ sequence: 1, eof: true }) + "\n");
        yield* eventually(() => relay.frames.some((frame) => frame.exitCode === 0));
      }),
    15_000,
  );

  it("rejects an invalid PID instead of signaling a process group", () => {
    const cwd = mkdtempSync(join(tmpdir(), "usine-owner-pid-"));
    const pidFile = childPidFile(cwd, AgentSessionId.make("attempt:child:1"));
    writeFileSync(pidFile, "0");
    const result = spawnSync(
      process.execPath,
      ["-e", PROCESS_OWNER, "stop", pidFile, "0", "5000"],
      { encoding: "utf8" },
    );
    assert.strictEqual(result.status, 1);
    assert.include(result.stderr, "Invalid child process PID");
  });

  it.live(
    "reports exit before first output with a bounded stderr tail",
    () =>
      Effect.gen(function* () {
        const cwd = mkdtempSync(join(tmpdir(), "usine-owner-exit-"));
        const pidFile = childPidFile(cwd, AgentSessionId.make("attempt:child:1"));
        const relay = workerRelay(pidFile, "attach", 0, 5000, process.execPath, [
          "-e",
          "process.stderr.write('x'.repeat(16000) + 'diagnostic');process.exitCode=7",
        ]);
        yield* eventually(() => relay.frames.some((frame) => frame.exitCode === 7));
        const event = relay.frames.find((frame) => frame.exitCode === 7);
        assert.strictEqual(event?.stderrTail?.length, 8192);
        assert(event?.stderrTail?.endsWith("diagnostic"));
        assert.isFalse(relay.frames.some((frame) => frame.stdout));
      }),
    10_000,
  );
});

const decodeOwnerInput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      sequence: Schema.optionalKey(Schema.Int),
      data: Schema.optionalKey(Schema.String),
      checkpoint: Schema.optionalKey(Schema.Boolean),
      offset: Schema.optionalKey(Schema.Int),
      skip: Schema.optionalKey(Schema.Int),
    }),
  ),
);

type OwnerFrame = (value: Schema.Json) => Effect.Effect<boolean>;

/** An owner relay that writes `initial`, passes each input frame to `onInput`, and confirms checkpoints. */
const scriptedOwner = (
  initial: ReadonlyArray<Schema.Json>,
  onInput: (sequence: number, frame: OwnerFrame) => Effect.Effect<unknown>,
) =>
  Effect.gen(function* () {
    const ownerOutput = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const frame: OwnerFrame = (value) =>
      Queue.offer(ownerOutput, Buffer.from(`${encodeOwnerFrame(value)}\n`));
    const saved = yield* Deferred.make<{ readonly offset: number; readonly skip: number }>();
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        assert(command._tag === "StandardCommand");
        const stdin = command.options.stdin;
        assert(Predicate.hasProperty(stdin, "stream") && Stream.isStream(stdin.stream));
        for (const value of initial) yield* frame(value);
        yield* stdin.stream.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.drop(1),
          Stream.mapEffect((text) => decodeOwnerInput(text)),
          Stream.runForEach((input) =>
            Effect.gen(function* () {
              if (input.data !== undefined && input.sequence !== undefined)
                yield* onInput(input.sequence, frame);
              if (
                input.checkpoint === true &&
                input.offset !== undefined &&
                input.skip !== undefined
              ) {
                yield* Deferred.succeed(saved, { offset: input.offset, skip: input.skip });
                yield* frame({ offset: 40, checkpoint: true });
              }
            }),
          ),
          Effect.orDie,
          Effect.forkScoped,
        );
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(4242),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.fromQueue(ownerOutput),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    );
    return { spawner, saved };
  });

const scriptedTarget = {
  host: RemoteShell.make({
    ssh: { command: "ssh", args: [] },
    sshEnvironment: {},
    destination: "worker",
  }),
  cwd: "/worktree",
  environment: {},
  sessionId: Option.some(AgentSessionId.make("attempt:child:1")),
};
const scriptedCommand = { command: "claude", args: [], cwd: "/worktree" };

it.live(
  "checkpoints output that input acknowledged while detaching releases",
  () =>
    Effect.gen(function* () {
      const line = (message: Schema.Json) =>
        Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(message).pipe(
          Effect.map((text) => Buffer.from(`${text}\n`)),
        );
      const hook = yield* line({
        type: "control_request",
        request_id: "hook",
        request: { subtype: "hook_callback" },
      });
      const response = yield* line({
        type: "control_response",
        response: { request_id: "hook", subtype: "success" },
      });
      const responseSent = yield* Deferred.make<void>();
      // An owner whose acknowledgement of the hook response arrives after the detach starts.
      const { spawner, saved } = yield* scriptedOwner(
        [
          { offset: 10, ready: true, sequence: 0, retained: false },
          { offset: 20, stdout: hook.toString("base64") },
        ],
        (sequence, frame) =>
          Deferred.succeed(responseSent, undefined).pipe(
            Effect.andThen(Effect.sleep("300 millis")),
            Effect.andThen(frame({ offset: 30, ack: sequence })),
          ),
      );
      const stopping = yield* Ref.make(false);
      const input = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      const hookRead = yield* Deferred.make<void>();
      const checkpoint = claudeOutputCheckpoint();
      const scope = yield* Scope.make();
      yield* Effect.gen(function* () {
        const owner = yield* startChildProcess(
          scriptedTarget,
          scriptedCommand,
          Stream.fromQueue(input),
          undefined,
          "handled",
          checkpoint.inputAcknowledged,
        );
        yield* owner.stdout.pipe(
          Stream.runForEach((bytes) =>
            checkpoint
              .read(bytes)
              .pipe(
                Effect.flatMap(owner.acknowledgeOutput),
                Effect.andThen(Deferred.succeed(hookRead, undefined)),
              ),
          ),
          Effect.forkScoped,
        );
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(ChildSessionLifecycle, { isStopping: Ref.get(stopping) }),
        Scope.provide(scope),
      );
      yield* Deferred.await(hookRead);
      yield* Queue.offer(input, response);
      yield* Deferred.await(responseSent);
      yield* Ref.set(stopping, true);
      yield* Scope.close(scope, Exit.void);
      const cursor = yield* Deferred.await(saved).pipe(Effect.timeout("1 second"));
      assert.deepStrictEqual(cursor, { offset: 30, skip: 0 }, "the answered hook is not replayed");
    }),
  10_000,
);

it.live(
  "saves the output checkpoint while detaching when the owner never acknowledges input",
  () =>
    Effect.gen(function* () {
      const sent = yield* Deferred.make<void>();
      const { spawner, saved } = yield* scriptedOwner(
        [
          { offset: 10, ready: true, sequence: 0, retained: false },
          { offset: 20, stdout: Buffer.from("line\n").toString("base64") },
        ],
        () => Deferred.succeed(sent, undefined),
      );
      const stopping = yield* Ref.make(false);
      const input = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      const scope = yield* Scope.make();
      const owner = yield* startChildProcess(
        scriptedTarget,
        scriptedCommand,
        Stream.fromQueue(input),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(ChildSessionLifecycle, { isStopping: Ref.get(stopping) }),
        Scope.provide(scope),
      );
      yield* owner.stdout.pipe(Stream.take(1), Stream.runDrain);
      yield* Queue.offer(input, Buffer.from("unanswered"));
      yield* Deferred.await(sent);
      yield* Ref.set(stopping, true);
      yield* Scope.close(scope, Exit.void);
      const cursor = yield* Deferred.await(saved).pipe(Effect.timeout("1 second"));
      assert.deepStrictEqual(cursor, { offset: 20, skip: 0 });
    }),
  10_000,
);

it.live("hands each acknowledged input to its callback once across later acknowledgements", () =>
  Effect.gen(function* () {
    const { spawner } = yield* scriptedOwner(
      [{ offset: 10, ready: true, sequence: 0, retained: false }],
      (sequence, frame) =>
        frame({ offset: 10 + sequence, ack: sequence }).pipe(
          Effect.andThen(
            sequence === 2
              ? frame({ offset: 20, stdout: Buffer.from("done").toString("base64") })
              : Effect.void,
          ),
        ),
    );
    const stopping = yield* Ref.make(false);
    const input = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const acknowledged: Array<string> = [];
    yield* Effect.gen(function* () {
      const owner = yield* startChildProcess(
        scriptedTarget,
        scriptedCommand,
        Stream.fromQueue(input),
        undefined,
        "received",
        (bytes) =>
          Effect.sync(() => {
            acknowledged.push(Buffer.from(bytes).toString());
            return 0;
          }),
      );
      yield* Queue.offerAll(input, [Buffer.from("first"), Buffer.from("second")]);
      yield* owner.stdout.pipe(Stream.take(1), Stream.runDrain);
      assert.deepStrictEqual(acknowledged, ["first", "second"]);
    }).pipe(
      Effect.ensuring(Ref.set(stopping, true)),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(ChildSessionLifecycle, { isStopping: Ref.get(stopping) }),
      Effect.scoped,
    );
  }),
);

it.live("numbers input after a retained owner's sequence and reports it as the generation", () =>
  Effect.gen(function* () {
    const sequences: Array<number> = [];
    const { spawner } = yield* scriptedOwner(
      [{ offset: 10, ready: true, sequence: 7, retained: true }],
      (sequence, frame) =>
        Effect.sync(() => sequences.push(sequence)).pipe(
          Effect.andThen(frame({ offset: 20, ack: sequence })),
          Effect.andThen(frame({ offset: 30, stdout: Buffer.from("done").toString("base64") })),
        ),
    );
    const stopping = yield* Ref.make(false);
    const input = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    yield* Effect.gen(function* () {
      const owner = yield* startChildProcess(
        scriptedTarget,
        scriptedCommand,
        Stream.fromQueue(input),
      );
      const generation = yield* owner.generation;
      assert.deepStrictEqual(generation, Option.some(7));
      yield* Queue.offer(input, Buffer.from("next"));
      yield* owner.stdout.pipe(Stream.take(1), Stream.runDrain);
      assert.deepStrictEqual(sequences, [8]);
    }).pipe(
      Effect.ensuring(Ref.set(stopping, true)),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(ChildSessionLifecycle, { isStopping: Ref.get(stopping) }),
      Effect.scoped,
    );
  }),
);

describe("local process lifeline", () => {
  it.live(
    "ends a local process group after an orchestrator is killed",
    () =>
      Effect.gen(function* () {
        const cwd = mkdtempSync(join(tmpdir(), "usine-orchestrator-crash-"));
        const pidFile = childPidFile(cwd, AgentSessionId.make("attempt:child:1"));
        const program = `const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', ${encodeOwnerFrame(CHILD_LIFELINE)}, ${encodeOwnerFrame(pidFile)}, "", process.execPath, '-e', "process.stdout.write(String(process.pid));setInterval(() => {},1000)"], { detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
      child.stdout.pipe(process.stdout);`;
        const orchestrator = spawn(process.execPath, ["-e", program]);
        let output = "";
        orchestrator.stdout.on("data", (data) => {
          output += String(data);
        });
        yield* eventually(() => output.length > 0);
        const pid = Number(output);
        orchestrator.kill("SIGKILL");
        yield* eventually(() => !alive(pid));
        yield* eventually(() => !existsSync(pidFile));
      }),
    10_000,
  );

  it.live(
    "ends a local process group when the orchestrator lifeline closes",
    () =>
      Effect.gen(function* () {
        const cwd = mkdtempSync(join(tmpdir(), "usine-lifeline-"));
        const pidFile = childPidFile(cwd, AgentSessionId.make("attempt:child:1"));
        const child = spawn(
          process.execPath,
          [
            "-e",
            CHILD_LIFELINE,
            pidFile,
            "",
            process.execPath,
            "-e",
            "process.on('SIGTERM', () => {});process.stdin.on('end', () => {});process.stdout.write(String(process.pid));setInterval(() => {},1000)",
          ],
          { stdio: ["pipe", "pipe", "pipe", "pipe"] },
        );
        let output = "";
        child.stdout.on("data", (data) => {
          output += String(data);
        });
        yield* eventually(() => output.length > 0);
        const pid = Number(output);
        const lifeline = child.stdio[3];
        assert(lifeline !== null && lifeline !== undefined);
        lifeline.destroy();
        yield* sleep(5100);
        yield* eventually(() => !alive(pid));
        yield* eventually(() => !existsSync(pidFile));
      }),
    10_000,
  );
});
