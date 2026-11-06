// These tests drive standalone Node programs through real pipes, signals, and temporary journals.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics asyncFunction:off
// @effect-diagnostics newPromise:off
// @effect-diagnostics globalJson:off
// @effect-diagnostics processEnv:off
// @effect-diagnostics schemaSync:off
import { build } from "esbuild";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_LIFELINE } from "../../src/child-host/lifeline.ts";
import { PROCESS_OWNER } from "../../src/child-host/supervisor.ts";
import { ownerProgram } from "../../src/child-host/worker/program.ts";

import type { RelayFrame } from "../../src/child-host/worker/protocol.ts";

const Frame = Schema.Union([
  Schema.Struct({
    ready: Schema.Literal(true),
    offset: Schema.Int,
    skip: Schema.Int,
    sequence: Schema.Int,
    retained: Schema.Boolean,
  }),
  Schema.Struct({ stdout: Schema.String, offset: Schema.Int }),
  Schema.Struct({ ack: Schema.Int, offset: Schema.Int }),
  Schema.Struct({ exitCode: Schema.Int, stderrTail: Schema.String, offset: Schema.Int }),
  Schema.Struct({ checkpoint: Schema.Literal(true), offset: Schema.Int }),
]);
type Frame = typeof Frame.Type;
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Frame));
const eventually = (condition: () => boolean) =>
  expect.poll(condition, { timeout: 9000, interval: 20 }).toBe(true);
let program: string;
const directories: string[] = [];
const relays: ChildProcess[] = [];

beforeAll(async () => {
  const result = await build({
    entryPoints: ["test/child-host/worker-entry.ts"],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "iife",
    globalName: "ChildHostWorker",
    write: false,
  });
  const output = result.outputFiles[0];
  expect(output).toBeDefined();
  if (output === undefined) throw new Error("Worker bundle missing");
  program = ownerProgram({ owner: output.text, lifeline: CHILD_LIFELINE });
});

describe("standalone worker lifeline", () => {
  it("records an early harness exit with a bounded stderr tail", async () => {
    const { dir, pidFile } = temporary();
    const exitFile = join(dir, "exit");
    const child = spawn(
      process.execPath,
      [
        "-e",
        CHILD_LIFELINE,
        pidFile,
        exitFile,
        process.execPath,
        "-e",
        'process.stderr.write("x".repeat(16000) + "diagnostic");process.exitCode = 7',
      ],
      { stdio: ["pipe", "pipe", "pipe", "pipe"] },
    );
    relays.push(child);
    child.stderr.resume();
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("close", resolve);
      child.on("error", reject);
    });
    expect(code).toBe(7);
    const recorded = decode(
      JSON.stringify({ ...JSON.parse(readFileSync(exitFile, "utf8")), offset: 0 }),
    );
    expect(recorded).toMatchObject({
      exitCode: 7,
      stderrTail: "x".repeat(8192 - "diagnostic".length) + "diagnostic",
    });
    expect(existsSync(pidFile)).toBe(false);
  });

  it("stops a TERM-resistant harness when its parent pipe closes", async () => {
    const { dir, pidFile } = temporary();
    const exitFile = join(dir, "exit");
    const child = spawn(
      process.execPath,
      [
        "-e",
        CHILD_LIFELINE,
        pidFile,
        exitFile,
        process.execPath,
        "-e",
        'process.on("SIGTERM", () => process.stderr.write("received TERM"));process.stdout.write("ready");setInterval(() => {}, 1000)',
      ],
      { stdio: ["pipe", "pipe", "pipe", "pipe"] },
    );
    relays.push(child);
    let output = "";
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });
    child.stderr.resume();
    const closed = new Promise<number | null>((resolve, reject) => {
      child.on("close", resolve);
      child.on("error", reject);
    });
    await eventually(() => output === "ready");
    const pipe = child.stdio[3];
    if (pipe === null || pipe === undefined) throw new Error("Missing parent pipe");
    pipe.destroy();
    expect(await closed).toBe(137);
    expect(JSON.parse(readFileSync(exitFile, "utf8"))).toMatchObject({
      exitCode: 137,
      stderrTail: "received TERM",
    });
    expect(existsSync(pidFile)).toBe(false);
  }, 15_000);
});

const temporary = () => {
  const dir = mkdtempSync(join(tmpdir(), "usine-worker-unit-"));
  directories.push(dir);
  return { dir, pidFile: join(dir, "child.pid"), root: join(dir, "child.pid.transport") };
};

const start = (
  pidFile: string,
  mode = "attach",
  lease = 30_000,
  environment: Record<string, string> = {},
  harness = 'process.stdin.on("data", data => process.stdout.write(data))',
  cursor = 0,
  source = program,
) => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      source,
      mode,
      pidFile,
      String(cursor),
      String(lease),
      JSON.stringify(Object.keys(environment)),
      process.execPath,
      "-e",
      harness,
    ],
    { env: { ...process.env, ...environment } },
  );
  relays.push(child);
  const frames: Frame[] = [];
  let buffered = "";
  let stderr = "";
  child.stdout.on("data", (data: Buffer) => {
    buffered += data.toString();
    let end;
    while ((end = buffered.indexOf("\n")) >= 0) {
      frames.push(decode(buffered.slice(0, end)));
      buffered = buffered.slice(end + 1);
    }
  });
  child.stderr.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.on("close", resolve);
    child.on("error", reject);
  });
  return {
    child,
    frames,
    closed,
    stderr: () => stderr,
    send: (frame: RelayFrame) => child.stdin.write(JSON.stringify(frame) + "\n"),
  };
};

const stdout = (frames: Frame[]) =>
  frames
    .flatMap((frame) => ("stdout" in frame ? [Buffer.from(frame.stdout, "base64").toString()] : []))
    .join("");
const exited = (frames: Frame[]) => frames.some((frame) => "exitCode" in frame);
const ready = (frames: Frame[]) => frames.find((frame) => "ready" in frame);

afterEach(() => {
  for (const child of relays.splice(0)) child.kill("SIGKILL");
  for (const dir of directories.splice(0)) {
    const stopped = spawnSync(process.execPath, ["-e", program, "stop", join(dir, "child.pid")], {
      encoding: "utf8",
      timeout: 15_000,
    });
    try {
      expect(stopped.error).toBeUndefined();
      expect(stopped.status, stopped.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("standalone worker owner", () => {
  it("deduplicates input replay across relay replacement and resumes its output checkpoint", async () => {
    const { pidFile, root } = temporary();
    const first = start(pidFile);
    await eventually(() => ready(first.frames) !== undefined);
    const owner = readFileSync(pidFile, "utf8");
    const input = { sequence: 1, data: Buffer.from("once\n").toString("base64") };
    first.send(input);
    await eventually(() => stdout(first.frames) === "once\n");
    const offset = first.frames.at(-1)?.offset ?? 0;
    first.send({ heartbeat: true, checkpoint: true, offset, skip: 0 });
    await eventually(() => first.frames.some((frame) => "checkpoint" in frame));
    first.child.stdin.end();
    await first.closed;
    const second = start(pidFile, "resume");
    await eventually(() => ready(second.frames) !== undefined);
    expect(ready(second.frames)).toMatchObject({ retained: true, sequence: 1, offset });
    expect(readFileSync(pidFile, "utf8")).toBe(owner);
    second.send(input);
    await eventually(() => second.frames.some((frame) => "ack" in frame && frame.ack === 1));
    second.send({ sequence: 2, eof: true });
    await eventually(() => exited(second.frames));
    expect(stdout(second.frames)).toBe("");
    expect(readFileSync(join(root, "sequence"), "utf8")).toBe("2");
    expect(await second.closed, second.stderr()).toBe(0);
  }, 15_000);

  it("expires the lease and records a terminated harness before removing its owner PID", async () => {
    const { pidFile, root } = temporary();
    const relay = start(
      pidFile,
      "attach",
      500,
      {},
      'process.stdout.write("running");setInterval(() => {}, 1000)',
    );
    await eventually(() => stdout(relay.frames) === "running");
    await eventually(() => exited(relay.frames));
    expect(relay.frames.find((frame) => "exitCode" in frame)).toMatchObject({ exitCode: 143 });
    expect(existsSync(pidFile)).toBe(false);
    expect(JSON.parse(readFileSync(join(root, "exit"), "utf8"))).toMatchObject({ exitCode: 143 });
    expect(await relay.closed, relay.stderr()).toBe(0);
  }, 15_000);

  for (const recorded of [false, true]) {
    it(`reports a dead owner ${recorded ? "from its exit record" : "without an exit record"}`, async () => {
      const { pidFile, root } = temporary();
      mkdirSync(root);
      for (const [name, content] of Object.entries({
        input: "",
        output: "",
        ready: "",
        heartbeat: "",
        sequence: "0",
        delivered: "0",
        identity: "previous-boot:999999999",
      }))
        writeFileSync(join(root, name), content);
      writeFileSync(pidFile, "999999999");
      if (recorded)
        writeFileSync(
          join(root, "exit"),
          JSON.stringify({ exitCode: 7, stderrTail: "recorded diagnostic" }),
        );
      const relay = start(pidFile);
      await eventually(() => exited(relay.frames));
      const terminal = relay.frames.find((frame) => "exitCode" in frame);
      expect(terminal).toMatchObject(
        recorded
          ? { exitCode: 7, stderrTail: "recorded diagnostic" }
          : { exitCode: 1, stderrTail: expect.stringContaining("owner disappeared") },
      );
      expect(relay.frames.filter((frame) => "exitCode" in frame)).toHaveLength(1);
      expect(existsSync(pidFile)).toBe(false);
      expect(await relay.closed, relay.stderr()).toBe(0);
    });
  }

  it("does not signal a reused PID when stopping or removing stale journals", async () => {
    const { pidFile, root } = temporary();
    const unrelated = spawn(process.execPath, [
      "-e",
      'process.stdout.write("ready");setInterval(() => {}, 1000)',
    ]);
    try {
      const pid = unrelated.pid;
      expect(pid).toBeDefined();
      if (pid === undefined) throw new Error("Unrelated process missing");
      mkdirSync(root);
      writeFileSync(pidFile, String(pid));
      writeFileSync(join(root, "identity"), `previous-boot:${pid}`);
      writeFileSync(join(root, "process"), String(pid));
      writeFileSync(join(root, "process.identity"), `test-boot:${pid}:previous-start`);
      for (const mode of ["stop", "remove"]) {
        const stopped = spawnSync(process.execPath, ["-e", program, mode, pidFile], {
          encoding: "utf8",
        });
        expect(stopped.status, stopped.stderr).toBe(0);
        expect(unrelated.kill(0)).toBe(true);
      }
      expect(existsSync(root)).toBe(false);
    } finally {
      unrelated.kill("SIGKILL");
    }
  });

  it("replaces a retained owner when its exported environment hash changes", async () => {
    const { pidFile } = temporary();
    const harness = "process.stdout.write(process.env.WORKER_TEST_VALUE);process.stdin.resume()";
    const first = start(pidFile, "attach", 30_000, { WORKER_TEST_VALUE: "one" }, harness);
    await eventually(() => stdout(first.frames) === "one");
    const owner = readFileSync(pidFile, "utf8");
    first.child.stdin.end();
    await first.closed;
    const second = start(pidFile, "resume", 30_000, { WORKER_TEST_VALUE: "two" }, harness);
    await eventually(() => stdout(second.frames) === "two");
    expect(ready(second.frames)).toMatchObject({ retained: false, sequence: 0 });
    expect(readFileSync(pidFile, "utf8")).not.toBe(owner);
    second.send({ sequence: 1, eof: true });
    await eventually(() => exited(second.frames));
    expect(await second.closed, second.stderr()).toBe(0);
  }, 15_000);

  for (const ignoresTerm of [false, true]) {
    it(`stops the harness with ${ignoresTerm ? "TERM then KILL" : "TERM"} and preserves its exit diagnostic`, async () => {
      const { pidFile, root } = temporary();
      const harness = `process.on("SIGTERM", () => { process.stderr.write("received TERM"); ${ignoresTerm ? "" : "process.exit(0)"} });process.stdout.write("running");setInterval(() => {}, 1000)`;
      const relay = start(pidFile, "attach", 30_000, {}, harness);
      await eventually(() => stdout(relay.frames) === "running");
      const stopped = spawn(process.execPath, ["-e", program, "stop", pidFile]);
      const code = await new Promise<number | null>((resolve, reject) => {
        stopped.on("close", resolve);
        stopped.on("error", reject);
      });
      expect(code).toBe(0);
      await eventually(() => exited(relay.frames));
      expect(JSON.parse(readFileSync(join(root, "exit"), "utf8"))).toMatchObject({
        exitCode: ignoresTerm ? 137 : 0,
        stderrTail: "received TERM",
      });
      expect(existsSync(pidFile)).toBe(false);
      expect(await relay.closed, relay.stderr()).toBe(0);
    }, 15_000);
  }

  it.skipIf(process.platform !== "linux")(
    "runs the shipped bundle without a loader or installed worker dependencies",
    async () => {
      const { pidFile } = temporary();
      const relay = start(pidFile, "attach", 30_000, {}, undefined, 0, PROCESS_OWNER);
      await eventually(() => ready(relay.frames) !== undefined);
      relay.send({ sequence: 1, data: Buffer.from("built output").toString("base64") });
      relay.send({ sequence: 2, eof: true });
      await eventually(() => exited(relay.frames));
      expect(stdout(relay.frames)).toBe("built output");
      expect(await relay.closed, relay.stderr()).toBe(0);
    },
    15_000,
  );
});
