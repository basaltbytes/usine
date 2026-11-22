// These tests run the bundled bridge against a scripted fake `serve` through real pipes and HTTP.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics asyncFunction:off
// @effect-diagnostics newPromise:off
// @effect-diagnostics globalJson:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics processEnv:off
// @effect-diagnostics schemaSync:off
import { NodeServices } from "@effect/platform-node";
import { afterEach, beforeAll, describe, expect, it } from "@effect/vitest";
import { build } from "esbuild";
import { type Cause, Effect, Fiber, Option, Queue, Schema, Stream } from "effect";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir } from "node:os";
import { LocalProcess } from "../../src/child-host/child-host.ts";
import { startChildProcess } from "../../src/child-host/node.ts";
import { OPENCODE_BRIDGE } from "../../src/harness/opencode/bridge/bundle.js";
import { bridgeClient, bridgeCommand } from "../../src/harness/opencode/bridge/client.ts";
import { BridgeOutput, type BridgeRequest } from "../../src/harness/opencode/bridge/lines.ts";

const decodeLine = Schema.decodeUnknownSync(Schema.fromJsonString(BridgeOutput));
const childEnvironment = { PATH: process.env.PATH ?? "", FAKE_SERVE_SCENARIO: "ready" };
let fakeServe: string;
const bridges: Array<ChildProcessWithoutNullStreams> = [];

beforeAll(async () => {
  const result = await build({
    entryPoints: ["test/opencode/fake-serve.ts"],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "iife",
    write: false,
  });
  const output = result.outputFiles[0];
  if (output === undefined) throw new Error("Fake serve bundle missing");
  fakeServe = output.text;
});

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.kill("SIGKILL");
});

/** Starts the bundled bridge around the fake `serve` in `scenario` and records its output. */
const start = (scenario: string) => {
  const child = spawn(
    process.execPath,
    ["-e", OPENCODE_BRIDGE, process.execPath, "-e", fakeServe],
    {
      env: {
        ...process.env,
        FAKE_SERVE_SCENARIO: scenario,
        OPENCODE_SERVER_PASSWORD: "inherited",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  bridges.push(child);
  const lines: Array<BridgeOutput> = [];
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (text: string) => {
    const parts = (stdout + text).split("\n");
    stdout = parts.pop() ?? "";
    lines.push(...parts.map((line) => decodeLine(line)));
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => (stderr += text));
  const exit = new Promise<number | null>((resolve, reject) => {
    child.on("close", resolve);
    child.on("error", reject);
  });
  const send = (request: BridgeRequest) => child.stdin.write(`${JSON.stringify(request)}\n`);
  return { child, lines, stderr: () => stderr, exit, send };
};

const eventually = (condition: () => boolean) =>
  expect.poll(condition, { timeout: 9000, interval: 20 }).toBe(true);
const answerTo = (lines: ReadonlyArray<BridgeOutput>, id: number | string) =>
  lines.find((line) => "id" in line && line.id === id);
const eventTypes = (lines: ReadonlyArray<BridgeOutput>) =>
  lines.flatMap((line) => ("event" in line ? [line.event.type] : []));

describe("OpenCode bridge", () => {
  it("reports ready once serve is listening and the event subscription is registered", async () => {
    const bridge = start("ready");
    await eventually(() => bridge.lines.length >= 2);
    expect(bridge.lines.slice(0, 2)).toEqual([
      { ready: true },
      { event: { type: "server.connected", data: {} } },
    ]);
    bridge.send({ id: 1, method: "GET", path: "/api/start" });
    bridge.send({ id: "2:1", method: "POST", path: "/api/echo", body: { text: "hello" } });
    bridge.send({ id: 3, method: "GET", path: "/api/empty" });
    bridge.send({ id: 4, method: "GET", path: "/api/text" });
    bridge.send({ id: 5, method: "GET", path: "/api/missing" });
    await eventually(() => [1, "2:1", 3, 4, 5].every((id) => answerTo(bridge.lines, id)));
    expect(answerTo(bridge.lines, 1)).toEqual({
      id: 1,
      status: 200,
      body: {
        args: [
          "serve",
          "--stdio",
          "--hostname",
          "127.0.0.1",
          "--port",
          "0",
          "--print-logs",
          "--log-level",
          "warn",
        ],
        passwordInArguments: false,
        passwordInEnvironment: false,
      },
    });
    expect(answerTo(bridge.lines, "2:1")).toEqual({
      id: "2:1",
      status: 201,
      body: {
        method: "POST",
        path: "/api/echo",
        contentType: "application/json",
        body: { text: "hello" },
      },
    });
    expect(answerTo(bridge.lines, 3)).toEqual({ id: 3, status: 204, body: null });
    expect(answerTo(bridge.lines, 4)).toEqual({ id: 4, status: 502, body: "bad gateway" });
    expect(answerTo(bridge.lines, 5)).toEqual({ id: 5, status: 404, body: null });
    // A line before serve's ready line is a diagnostic.
    expect(bridge.stderr()).toContain("a line before the ready line");
  });

  it("waits through a slow start and answers requests sent before it was ready", async () => {
    const bridge = start("slow");
    const started = Date.now();
    bridge.send({ id: 1, method: "POST", path: "/api/echo" });
    await eventually(() => answerTo(bridge.lines, 1) !== undefined);
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
    expect(bridge.lines).toEqual([
      { ready: true },
      { event: { type: "server.connected", data: {} } },
      {
        id: 1,
        status: 201,
        body: { method: "POST", path: "/api/echo", contentType: null, body: null },
      },
    ]);
  });

  it("exits with serve's code when serve exits before it is ready", async () => {
    const bridge = start("exit-before-ready");
    expect(await bridge.exit).toBe(3);
    expect(bridge.lines).toEqual([]);
    expect(bridge.stderr()).toContain("fake serve: the configuration is invalid");
  });

  it("exits with serve's code when serve crashes during a request", async () => {
    const bridge = start("ready");
    await eventually(() => bridge.lines.length >= 1);
    bridge.send({ id: 1, method: "POST", path: "/api/crash" });
    expect(await bridge.exit).toBe(4);
    expect(bridge.stderr()).toContain("fake serve: crashed while answering");
    const answer = answerTo(bridge.lines, 1);
    if (answer !== undefined) expect(answer).toHaveProperty("error");
  });

  it("logs and skips a garbage input line and a garbage event, and keeps running", async () => {
    const bridge = start("ready");
    await eventually(() => bridge.lines.length >= 1);
    bridge.child.stdin.write("not a request\n");
    bridge.child.stdin.write(`${JSON.stringify({ id: 1, method: "get", path: "/api/start" })}\n`);
    bridge.child.stdin.write(`${JSON.stringify({ id: 2, method: "GET", path: "//host/api" })}\n`);
    bridge.send({ id: 3, method: "POST", path: "/api/garbage" });
    await eventually(() => answerTo(bridge.lines, 3) !== undefined);
    bridge.send({ id: 4, method: "GET", path: "/api/empty" });
    await eventually(() => answerTo(bridge.lines, 4) !== undefined);
    expect(answerTo(bridge.lines, 1)).toEqual({ id: 1, error: "The request has no HTTP method" });
    expect(answerTo(bridge.lines, 2)).toEqual({
      id: 2,
      error: "The request has no absolute path",
    });
    expect(eventTypes(bridge.lines)).toEqual(["server.connected", "after.garbage"]);
    expect(bridge.stderr()).toContain(
      "opencode bridge: skipping an input line of 13 bytes that isn't JSON",
    );
    expect(bridge.stderr()).toContain(
      "opencode bridge: skipping an OpenCode event of 9 bytes that isn't a JSON object",
    );
    expect(bridge.stderr()).toContain(
      "opencode bridge: skipping an OpenCode event of 6 bytes that isn't a JSON object",
    );
  });

  it("ends serve's input at end of input and exits with serve's code", async () => {
    const bridge = start("ready");
    await eventually(() => bridge.lines.length >= 1);
    bridge.child.stdin.end();
    expect(await bridge.exit).toBe(7);
    expect(bridge.stderr()).toContain("fake serve: end of input");
    expect(bridge.stderr()).not.toContain("opencode bridge:");
  });

  it("keeps the arrival order of an answer and an event that arrive together", async () => {
    const bridge = start("ready");
    await eventually(() => bridge.lines.length >= 2);
    for (const [id, first] of ["event", "answer"].entries()) {
      const before = bridge.lines.length;
      bridge.send({ id, method: "POST", path: `/api/order?first=${first}` });
      // Serve sends both while the bridge is stopped, so the bridge reads them in one turn.
      await eventually(() => bridge.stderr().includes(`fake serve: order ${first} received`));
      bridge.child.kill("SIGSTOP");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      bridge.child.kill("SIGCONT");
      await eventually(() => bridge.lines.length === before + 2);
      expect(bridge.lines.slice(before)).toEqual(
        first === "event"
          ? [{ event: { type: "order", data: {} } }, { id, status: 200, body: { answered: true } }]
          : [{ id, status: 200, body: { answered: true } }, { event: { type: "order", data: {} } }],
      );
    }
  });

  it.live("runs as an ordinary child through ChildHost, with the typed client", () =>
    Effect.gen(function* () {
      const input = yield* Queue.make<Uint8Array, Cause.Done>();
      const handle = yield* startChildProcess(
        {
          host: LocalProcess.make(),
          cwd: tmpdir(),
          environment: childEnvironment,
          sessionId: Option.none(),
        },
        bridgeCommand({ command: process.execPath, args: ["-e", fakeServe], cwd: tmpdir() }),
        Stream.fromQueue(input),
      );
      const client = yield* bridgeClient({
        sessionId: Option.none(),
        input,
        output: handle.stdout,
        generation: yield* handle.generation,
      });
      yield* client.ready;
      const events = yield* Effect.forkScoped(Stream.runCollect(client.events));
      const answer = yield* client.request("launch", {
        method: "POST",
        path: "/api/echo",
        body: { title: "usine" },
      });
      expect(answer).toEqual({
        id: 1,
        status: 201,
        body: {
          method: "POST",
          path: "/api/echo",
          contentType: "application/json",
          body: { title: "usine" },
        },
      });
      yield* client.close;
      const exit = yield* handle.exit;
      expect(exit.exitCode).toBe(7);
      expect(exit.stderrTail).toContain("fake serve: end of input");
      const received = yield* Fiber.join(events);
      expect(Array.from(received)).toEqual([{ type: "server.connected", data: {} }]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
