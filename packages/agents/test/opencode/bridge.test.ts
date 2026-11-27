// These tests run the bundled bridge against a scripted fake `serve` through real pipes and HTTP.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics asyncFunction:off
// @effect-diagnostics newPromise:off
// @effect-diagnostics globalJson:off
// @effect-diagnostics globalDate:off
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
import {
  type BridgeInput,
  BridgeOutput,
  OpenCodePath,
} from "../../src/harness/opencode/bridge/lines.ts";

const decodeLine = Schema.decodeUnknownSync(Schema.fromJsonString(BridgeOutput));
/** Credentials that a worker's environment may hold, which the bridge must not pass to `serve`. */
const inheritedCredentials = {
  OPENCODE_SERVER_PASSWORD: "inherited",
  OPENCODE_SERVER_USERNAME: "inherited",
};
const childEnvironment = {
  ...inheritedCredentials,
  PATH: process.env.PATH ?? "",
  FAKE_SERVE_SCENARIO: "ready",
};
let fakeServe: string;
const bridges: Array<ChildProcessWithoutNullStreams> = [];
const helpers: Array<number> = [];

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
  for (const helper of helpers.splice(0))
    try {
      process.kill(helper, "SIGKILL");
    } catch {
      // The helper has already exited.
    }
});

/** A wait for OpenCode's first event, in milliseconds, that tests can outlast. */
const SHORT_READY_WAIT_MS = 300;

/**
 * Starts the bundled bridge around the fake `serve` in `scenario`, with `environment` added to its
 * own and a wait of `readyWaitMs` for OpenCode's first event, and records its output.
 */
const start = (
  scenario: string,
  environment: Record<string, string> = {},
  readyWaitMs = 30_000,
) => {
  const child = spawn(
    process.execPath,
    ["-e", OPENCODE_BRIDGE, String(readyWaitMs), process.execPath, "-e", fakeServe],
    {
      env: {
        ...process.env,
        ...environment,
        ...inheritedCredentials,
        FAKE_SERVE_SCENARIO: scenario,
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
  const send = (request: typeof BridgeInput.Encoded) =>
    child.stdin.write(`${JSON.stringify(request)}\n`);
  return { child, lines, stderr: () => stderr, exit, send };
};

/** The bridge's line limit, 4 MiB. */
const LINE_LIMIT = 4 * 1024 ** 2;
const eventually = (condition: () => boolean) =>
  expect.poll(condition, { timeout: 9000, interval: 20 }).toBe(true);
const answerTo = (lines: ReadonlyArray<BridgeOutput>, id: number | string) =>
  lines.find((line) => "id" in line && line.id === id);
const eventTypes = (lines: ReadonlyArray<BridgeOutput>) =>
  lines.flatMap((line) => ("event" in line ? [line.event.type] : []));
/** The MCP messages and socket reports among `lines`. */
const mcpLines = (lines: ReadonlyArray<BridgeOutput>) => lines.filter((line) => "mcp" in line);

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

  it("sets serve-only variables on serve, and its own environment on a session's commands", async () => {
    const bridge = start("ready", {
      FAKE_SHARED: "worker",
      FAKE_SERVE_ONLY: "worker",
      USINE_OPENCODE_SERVE_FAKE_SERVE_ONLY: "serve",
    });
    await eventually(() => bridge.lines.length >= 2);
    bridge.send({ id: 1, method: "GET", path: "/api/environment" });
    bridge.send({ id: 2, environment: "ses_fake" });
    bridge.send({ id: 3, environment: "../api/flood" });
    await eventually(() => [1, 2, 3].every((id) => answerTo(bridge.lines, id)));
    expect(answerTo(bridge.lines, 1)).toEqual({
      id: 1,
      status: 200,
      body: { shared: "worker", serveOnly: "serve", prefixed: false },
    });
    const commands = answerTo(bridge.lines, 2);
    expect(commands).toMatchObject({
      id: 2,
      status: 200,
      body: { variables: { FAKE_SHARED: "worker", FAKE_SERVE_ONLY: "worker" } },
    });
    expect(JSON.stringify(commands)).not.toMatch(/PASSWORD|USINE_OPENCODE_SERVE_/u);
    expect(answerTo(bridge.lines, 3)).toEqual({
      id: 3,
      error: "The request names no OpenCode session",
    });
  });

  it("relays a client MCP server's socket in both directions", async () => {
    const bridge = start("ready");
    await eventually(() => bridge.lines.length >= 2);
    bridge.send({ id: 1, mcp: "usine", directory: "/work" });
    await eventually(() => mcpLines(bridge.lines).length >= 1);
    expect(answerTo(bridge.lines, 1)).toEqual({ id: 1, status: 101, body: null });
    expect(mcpLines(bridge.lines)).toEqual([
      {
        mcp: "usine",
        message: {
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: { name: "usine", directory: "/work", connection: 1 },
        },
      },
    ]);
    bridge.send({ mcp: "usine", message: { jsonrpc: "2.0", id: 0, result: {} } });
    await eventually(() => eventTypes(bridge.lines).includes("fake.mcp"));
    expect(bridge.lines).toContainEqual({
      event: {
        type: "fake.mcp",
        data: { name: "usine", message: { jsonrpc: "2.0", id: 0, result: {} } },
      },
    });
    // The bridge holds the socket, so a second connect line, as after a reattach, opens no other.
    bridge.send({ id: 2, mcp: "usine", directory: "/work" });
    bridge.send({ id: 3, mcp: "usine", directory: "/elsewhere" });
    bridge.send({ id: 4, mcp: "not a name", directory: "/work" });
    bridge.send({ id: 5, mcp: "other", directory: "work" });
    await eventually(() => [2, 3, 4, 5].every((id) => answerTo(bridge.lines, id)));
    expect(answerTo(bridge.lines, 2)).toEqual({ id: 2, status: 200, body: null });
    expect(answerTo(bridge.lines, 3)).toEqual({
      id: 3,
      error: "The MCP server usine is attached in another directory",
    });
    expect(answerTo(bridge.lines, 4)).toEqual({ id: 4, error: "The request names no MCP server" });
    expect(answerTo(bridge.lines, 5)).toEqual({
      id: 5,
      error: "The request has no absolute MCP directory",
    });
    bridge.send({ mcp: "other", message: { jsonrpc: "2.0", method: "ping" } });
    await eventually(() => bridge.stderr().includes("dropping a message for the MCP server other"));
    expect(mcpLines(bridge.lines)).toHaveLength(1);
  });

  it("reports a client MCP socket that OpenCode closes, and reconnects it", async () => {
    const bridge = start("ready");
    await eventually(() => bridge.lines.length >= 2);
    bridge.send({ id: 1, mcp: "usine", directory: "/work" });
    await eventually(() => mcpLines(bridge.lines).length >= 1);
    bridge.send({ id: 2, method: "POST", path: "/api/mcp-close" });
    await eventually(() => mcpLines(bridge.lines).length >= 3);
    expect(mcpLines(bridge.lines).slice(1)).toEqual([
      { mcp: "usine", closed: "code 1011: fake restart" },
      {
        mcp: "usine",
        message: {
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: { name: "usine", directory: "/work", connection: 2 },
        },
      },
    ]);
    expect(bridge.stderr()).toContain(
      "OpenCode closed the MCP socket of usine (code 1011: fake restart); reconnecting in 500 ms",
    );
  });

  it("answers a connect line with an error when OpenCode refuses the socket", async () => {
    const bridge = start("refuse-mcp");
    await eventually(() => bridge.lines.length >= 2);
    bridge.send({ id: 1, mcp: "usine", directory: "/work" });
    await eventually(() => answerTo(bridge.lines, 1) !== undefined);
    expect(answerTo(bridge.lines, 1)).toEqual({
      id: 1,
      error: expect.stringMatching(/^Can't open OpenCode's MCP socket for usine \(code 1006/u),
    });
    // A refused server isn't attached, so the next connect line tries again.
    bridge.send({ id: 2, mcp: "usine", directory: "/elsewhere" });
    await eventually(() => answerTo(bridge.lines, 2) !== undefined);
    expect(answerTo(bridge.lines, 2)).toMatchObject({ id: 2, error: expect.any(String) });
    expect(JSON.stringify(answerTo(bridge.lines, 2))).not.toContain("another directory");
  });

  it("refuses an MCP request of OpenCode too long for a line of 4 MiB", async () => {
    const bridge = start("ready");
    await eventually(() => bridge.lines.length >= 2);
    bridge.send({ id: 1, mcp: "usine", directory: "/work" });
    await eventually(() => mcpLines(bridge.lines).length >= 1);
    bridge.send({ id: 2, method: "POST", path: "/api/mcp-large" });
    await eventually(() => eventTypes(bridge.lines).includes("fake.mcp"));
    expect(bridge.lines).toContainEqual({
      event: {
        type: "fake.mcp",
        data: {
          name: "usine",
          message: {
            jsonrpc: "2.0",
            id: 7,
            error: {
              code: -32603,
              message: "The usine bridge can't relay a tools/call request this long",
            },
          },
        },
      },
    });
    expect(mcpLines(bridge.lines)).toHaveLength(1);
    expect(bridge.stderr()).toMatch(
      /skipping a message of \d+ bytes on the MCP socket of usine that is too long for a line/u,
    );
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

  it("keeps relaying after the wait for the first event once that event arrives", async () => {
    const bridge = start("ready", {}, SHORT_READY_WAIT_MS);
    await eventually(() => bridge.lines.length >= 2);
    const readyAt = Date.now();
    await eventually(() => Date.now() - readyAt > 2 * SHORT_READY_WAIT_MS);
    bridge.send({ id: 1, method: "GET", path: "/api/empty" });
    await eventually(() => answerTo(bridge.lines, 1) !== undefined);
    expect(answerTo(bridge.lines, 1)).toEqual({ id: 1, status: 204, body: null });
    expect(bridge.stderr()).not.toContain("opencode bridge:");
  });

  it("treats a ready line on a host that isn't a loopback address as a diagnostic", async () => {
    const bridge = start("foreign-url");
    await eventually(() => bridge.lines.length >= 2);
    expect(bridge.lines.slice(0, 2)).toEqual([
      { ready: true },
      { event: { type: "server.connected", data: {} } },
    ]);
    expect(bridge.stderr()).toMatch(/^\{"url":"http:\/\/192\.0\.2\.1:\d+"\}$/mu);
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
  });

  it("answers a request whose response is cut short with an error, and keeps running", async () => {
    const bridge = start("ready");
    await eventually(() => bridge.lines.length >= 1);
    bridge.send({ id: 1, method: "GET", path: "/api/cut" });
    await eventually(() => answerTo(bridge.lines, 1) !== undefined);
    expect(answerTo(bridge.lines, 1)).toEqual({
      id: 1,
      error: expect.stringMatching(/^Can't reach OpenCode: /u),
    });
    bridge.send({ id: 2, method: "GET", path: "/api/empty" });
    await eventually(() => answerTo(bridge.lines, 2) !== undefined);
    expect(answerTo(bridge.lines, 2)).toEqual({ id: 2, status: 204, body: null });
  });

  it("answers a request line longer than 4 MiB with an error, and keeps running", async () => {
    const bridge = start("ready");
    await eventually(() => bridge.lines.length >= 1);
    bridge.send({
      id: 1,
      method: "POST",
      path: "/api/echo",
      body: { text: "x".repeat(LINE_LIMIT) },
    });
    bridge.child.stdin.write(`${"x".repeat(LINE_LIMIT + 1)}\n`);
    bridge.send({ id: 2, method: "GET", path: "/api/empty" });
    await eventually(() => answerTo(bridge.lines, 2) !== undefined);
    expect(answerTo(bridge.lines, 1)).toEqual({
      id: 1,
      error: "The request is longer than 4194304 bytes",
    });
    expect(answerTo(bridge.lines, 2)).toEqual({ id: 2, status: 204, body: null });
    await eventually(() =>
      bridge
        .stderr()
        .includes(
          "opencode bridge: skipping an input line of 4194305 bytes that is longer than 4194304 bytes",
        ),
    );
  });

  it("refuses a request that would exceed the 4 MiB of requests held until ready", async () => {
    const bridge = start("no-events");
    const text = (mib: number) => "x".repeat(mib * 1024 ** 2);
    bridge.send({ id: 1, method: "POST", path: "/api/echo", body: { text: text(3) } });
    bridge.send({ id: 2, method: "POST", path: "/api/echo", body: { text: text(2) } });
    bridge.send({ id: 3, method: "GET", path: "/api/empty" });
    await eventually(() => answerTo(bridge.lines, 2) !== undefined);
    expect(bridge.lines).toEqual([
      {
        id: 2,
        error:
          "The request would exceed the 4194304 bytes of requests that the bridge holds until OpenCode is ready",
      },
    ]);
  });

  it("answers a response too long for a line of 4 MiB with an error, and keeps running", async () => {
    const bridge = start("ready");
    await eventually(() => bridge.lines.length >= 1);
    // The body of /api/large is longer than a line; the answer line to /api/limit is, its body isn't.
    bridge.send({ id: 1, method: "GET", path: "/api/large" });
    bridge.send({ id: 2, method: "GET", path: "/api/limit" });
    await eventually(() => [1, 2].every((id) => answerTo(bridge.lines, id)));
    for (const id of [1, 2])
      expect(answerTo(bridge.lines, id)).toEqual({
        id,
        error: "OpenCode's response is too long for a line of 4194304 bytes",
      });
    // The bridge closes the connection once the body is too long, instead of reading all of it.
    await eventually(() => bridge.stderr().includes("fake serve: the large response closed after"));
    bridge.send({ id: 3, method: "GET", path: "/api/empty" });
    await eventually(() => answerTo(bridge.lines, 3) !== undefined);
    expect(answerTo(bridge.lines, 3)).toEqual({ id: 3, status: 204, body: null });
  });

  it("logs and skips an event too long for a line of 4 MiB, and keeps running", async () => {
    const bridge = start("ready");
    await eventually(() => bridge.lines.length >= 2);
    bridge.send({ id: 1, method: "POST", path: "/api/large-event" });
    await eventually(() => eventTypes(bridge.lines).includes("after.large"));
    expect(eventTypes(bridge.lines)).toEqual(["server.connected", "after.large"]);
    // Data longer than a line that isn't JSON, JSON data whose data line is longer than a line, JSON
    // data whose event line is, and two data lines that join to data longer than a line.
    for (const size of [LINE_LIMIT + 1, LINE_LIMIT - 5, LINE_LIMIT - 6, 6 * 1024 ** 2 + 1])
      await eventually(() =>
        bridge
          .stderr()
          .includes(
            `opencode bridge: skipping an OpenCode event of ${size} bytes that is too long for a line of 4194304 bytes`,
          ),
      );
    expect(bridge.stderr()).not.toContain("isn't a JSON object");
  });

  it("logs and skips a line of serve's output longer than 4 MiB", async () => {
    const bridge = start("long-line");
    await eventually(() => bridge.lines.length >= 1);
    expect(bridge.lines[0]).toEqual({ ready: true });
    await eventually(() =>
      bridge
        .stderr()
        .includes(
          "opencode bridge: skipping an OpenCode output line of 4194305 bytes that is longer than 4194304 bytes",
        ),
    );
  });

  it("stops reading OpenCode's events while its reader is slow, then relays them", async () => {
    const bridge = start("ready");
    await eventually(() => bridge.lines.length >= 2);
    bridge.child.stdout.pause();
    bridge.send({ id: 1, method: "POST", path: "/api/flood" });
    // Serve can't send every event while the bridge holds none of them.
    await eventually(() => bridge.stderr().includes("fake serve: flood stalled"));
    bridge.child.stdout.resume();
    await eventually(() => bridge.stderr().includes("fake serve: flood sent"));
    await eventually(
      () => eventTypes(bridge.lines).filter((type) => type === "flood").length === 32,
    );
  });

  it("reports an event stream that closes while serve runs, and exits with 1", async () => {
    const bridge = start("ready", { FAKE_SERVE_EXIT_CODE: "0" });
    await eventually(() => bridge.lines.length >= 1);
    bridge.send({ id: 1, method: "POST", path: "/api/end-events" });
    expect(await bridge.exit).toBe(1);
    expect(answerTo(bridge.lines, 1)).toEqual({ id: 1, status: 200, body: {} });
    expect(bridge.stderr()).toMatch(
      /opencode bridge: OpenCode closed the event stream\n[^]*fake serve: end of input\n/u,
    );
  });

  it("exits with serve's code when serve closes the event stream just before it exits", async () => {
    const bridge = start("ready", { FAKE_SERVE_EXIT_CODE: "0" });
    await eventually(() => bridge.lines.length >= 1);
    bridge.send({ id: 1, method: "POST", path: "/api/shutdown" });
    expect(await bridge.exit).toBe(0);
    expect(bridge.stderr()).not.toContain("opencode bridge:");
    expect(bridge.stderr()).not.toContain("fake serve: end of input");
  });

  it("reports a refused event subscription, ends serve's input, and exits with 1", async () => {
    const bridge = start("refuse-events", { FAKE_SERVE_EXIT_CODE: "0" });
    expect(await bridge.exit).toBe(1);
    expect(bridge.lines).toEqual([]);
    expect(bridge.stderr()).toMatch(
      /opencode bridge: OpenCode refused the event subscription with status 401\n[^]*fake serve: end of input\n/u,
    );
  });

  it("reports no first event within its wait, ends serve's input, and exits with 1", async () => {
    const bridge = start("no-events", { FAKE_SERVE_EXIT_CODE: "0" }, SHORT_READY_WAIT_MS);
    expect(await bridge.exit).toBe(1);
    expect(bridge.lines).toEqual([]);
    expect(bridge.stderr()).toMatch(
      /opencode bridge: OpenCode sent no event within 0\.3 seconds of reporting its address\n[^]*fake serve: end of input\n/u,
    );
  });

  it("doesn't report a refused event subscription after its input ends", async () => {
    const bridge = start("refuse-events-at-end", { FAKE_SERVE_EXIT_CODE: "0" });
    await eventually(() => bridge.stderr().includes("fake serve: holding the event subscription"));
    bridge.child.stdin.end();
    expect(await bridge.exit).toBe(0);
    expect(bridge.stderr()).toContain("fake serve: end of input");
    expect(bridge.stderr()).not.toContain("opencode bridge:");
  });

  it("exits with serve's code when a process that serve started keeps serve's output open", async () => {
    const bridge = start("helper");
    await eventually(() => bridge.stderr().includes("fake serve: helper"));
    helpers.push(Number(/fake serve: helper (\d+)/u.exec(bridge.stderr())?.[1]));
    await eventually(() => bridge.lines.length >= 1);
    bridge.child.stdin.end();
    expect(await bridge.exit).toBe(7);
  });

  it("logs and skips a garbage input line and a garbage event, and keeps running", async () => {
    const bridge = start("ready");
    await eventually(() => bridge.lines.length >= 1);
    bridge.child.stdin.write("not a request\n");
    bridge.child.stdin.write(`${JSON.stringify({ id: 1, method: "get", path: "/api/start" })}\n`);
    bridge.child.stdin.write(`${JSON.stringify({ id: 2, method: "GET", path: "//host/api" })}\n`);
    bridge.child.stdin.write(`${JSON.stringify({ id: 3, method: "GET", path: "api/start" })}\n`);
    // The bridge skips an ID longer than 128 characters, so that no answer that repeats an ID is
    // longer than a line.
    const longId = { id: "x".repeat(129), method: "get", path: "/api/start" };
    bridge.child.stdin.write(`${JSON.stringify(longId)}\n`);
    bridge.send({ id: 4, method: "POST", path: "/api/garbage" });
    await eventually(() => answerTo(bridge.lines, 4) !== undefined);
    bridge.send({ id: 5, method: "GET", path: "/api/empty" });
    await eventually(() => answerTo(bridge.lines, 5) !== undefined);
    expect(answerTo(bridge.lines, 1)).toEqual({ id: 1, error: "The request has no HTTP method" });
    for (const id of [2, 3])
      expect(answerTo(bridge.lines, id)).toEqual({ id, error: "The request has no absolute path" });
    expect(eventTypes(bridge.lines)).toEqual(["server.connected", "after.garbage"]);
    expect(bridge.stderr()).toContain(
      "opencode bridge: skipping an input line of 13 bytes that isn't JSON",
    );
    expect(bridge.stderr()).toContain(
      `opencode bridge: skipping an input line of ${JSON.stringify(longId).length} bytes that has no request ID`,
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
        path: OpenCodePath.make("/api/echo"),
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
