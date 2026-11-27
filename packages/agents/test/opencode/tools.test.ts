import { assert, describe, it } from "@effect/vitest";
import { AgentSessionId } from "@usine/core/agent/session";
import { type Cause, Deferred, Effect, Fiber, Option, Queue, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { TestClock } from "effect/testing";
import { MAX_PROTOCOL_LINE_BYTES } from "../../src/child-host/lines.ts";
import { bridgeClient } from "../../src/harness/opencode/bridge/client.ts";
import {
  BridgeMcpMessage,
  type BridgeMcpClosed,
  type McpMessage,
} from "../../src/harness/opencode/bridge/lines.ts";
import { type McpConnection, serveOpenCodeTools } from "../../src/harness/opencode/tools.ts";
import { hostToolSet } from "../../src/harness/tools.ts";
import { SessionOperationError } from "../../src/runtime.ts";
import { NOTE, ReadNote } from "../contract/host-tools.ts";
import { collectLogs } from "../logs.ts";

const ROOT = "ses_root";
const decodeListed = Schema.decodeUnknownEffect(
  Schema.Struct({
    result: Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
  }),
);
const decodeSent = Schema.decodeUnknownEffect(Schema.fromJsonString(BridgeMcpMessage));
const decoder = new TextDecoder();
const sessionId = AgentSessionId.make("parent:tools:child:1");
const messages = (records: ReturnType<typeof collectLogs>["records"]) =>
  records.map(({ message }) => (Array.isArray(message) ? message[0] : message));

const WaitForever = Tool.make("wait_forever", {
  description: "Waits until the call is cancelled.",
  success: Schema.String,
});
const ReadLarge = Tool.make("read_large", {
  description: "Returns a text longer than a bridge line.",
  success: Schema.String,
});
const tools = Toolkit.make(ReadNote, WaitForever, ReadLarge);

/**
 * A bridge that answers the connect line with `status`, and records the messages that the usine
 * tools send through the bridge client.
 */
const connection = (status: number) =>
  Effect.gen(function* () {
    const output = yield* Queue.make<
      BridgeMcpMessage | BridgeMcpClosed,
      SessionOperationError | Cause.Done
    >();
    const input = yield* Queue.make<Uint8Array, Cause.Done>();
    const client = yield* bridgeClient({
      sessionId: Option.none(),
      input,
      output: Stream.never,
      generation: Option.none(),
    });
    const connects = yield* Queue.unbounded<readonly [string, string]>();
    const fake: McpConnection = {
      mcp: Stream.fromQueue(output),
      connectMcp: (_operation, server, directory) =>
        Queue.offer(connects, [server, directory]).pipe(Effect.as({ id: 1, status, body: null })),
      sendMcp: client.sendMcp,
    };
    return {
      fake,
      connects: Queue.take(connects),
      sent: Queue.take(input).pipe(
        Effect.flatMap((bytes) => decodeSent(decoder.decode(bytes).trimEnd())),
        Effect.map(({ message }) => message),
      ),
      /** Sends `message` from OpenCode to the usine tools' server. */
      receive: (message: McpMessage) => Queue.offer(output, { mcp: "usine", message }),
      /** Reports that OpenCode closed the usine tools' socket. */
      close: Queue.offer(output, { mcp: "usine", closed: "code 1011: restart" }),
      /** Ends the relay, as the bridge's output does after close. */
      end: Queue.end(output),
      /** Fails the relay with `error`, as a lost bridge does. */
      fail: (error: SessionOperationError) => Queue.fail(output, error),
    };
  });

const lost = SessionOperationError.make({
  operation: "stream",
  sessionId: Option.some(sessionId),
  message: "The OpenCode bridge exited with code 137: killed",
  cause: new Error("killed"),
});

/** Serves `tools` with handlers that record when `wait_forever` starts and is cancelled. */
const served = Effect.gen(function* () {
  const started = yield* Deferred.make<void>();
  const cancelled = yield* Deferred.make<void>();
  const handlers = tools.toLayer({
    read_note: ({ name }) =>
      name === "greeting" ? Effect.succeed(NOTE) : Effect.die(new Error("unexpected note")),
    wait_forever: () =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
      ),
    read_large: () => Effect.succeed("x".repeat(MAX_PROTOCOL_LINE_BYTES + 1)),
  });
  const bound = yield* hostToolSet(tools).pipe(Effect.provide(handlers));
  const server = yield* serveOpenCodeTools(bound, sessionId);
  return { server, started: Deferred.await(started), cancelled: Deferred.await(cancelled) };
});

/** Runs OpenCode's start of a new socket on `bridge`, and returns the ping that it waits for. */
const listOn = (bridge: Effect.Success<ReturnType<typeof connection>>) =>
  Effect.gen(function* () {
    yield* bridge.receive({ jsonrpc: "2.0", id: 0, method: "initialize" });
    yield* bridge.sent;
    yield* bridge.receive({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    yield* bridge.sent;
    return yield* bridge.sent;
  });

/** Attaches the tools on a new socket and runs OpenCode's side of the start up to the ping's answer. */
const attached = Effect.gen(function* () {
  const { server, started, cancelled } = yield* served;
  const bridge = yield* connection(101);
  const attach = yield* Effect.forkChild(server.attach(bridge.fake, "/work", ROOT));
  const ping = yield* listOn(bridge);
  yield* bridge.receive({ jsonrpc: "2.0", id: ping.id ?? null, result: {} });
  yield* Fiber.join(attach);
  return { bridge, started, cancelled };
});

const call = (id: number, name: string, caller: string, args: Schema.Json = {}) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args, _meta: { "ai.opencode/sessionID": caller, progressToken: id } },
});

describe("OpenCode usine tools", () => {
  it.effect("lists the tools and waits for a ping's answer before the session prompts", () =>
    Effect.gen(function* () {
      const { server } = yield* served;
      const bridge = yield* connection(101);
      const attach = yield* Effect.forkChild(server.attach(bridge.fake, "/work", ROOT));
      const connect1 = yield* bridge.connects;
      assert.deepStrictEqual(connect1, ["usine", "/work"]);
      yield* bridge.receive({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {} },
      });
      const answer1 = yield* bridge.sent;
      assert.deepStrictEqual(answer1, {
        jsonrpc: "2.0",
        id: 0,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "usine", version: "1.0.0" },
        },
      });
      yield* bridge.receive({ jsonrpc: "2.0", method: "notifications/initialized" });
      yield* bridge.receive({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const listed = yield* bridge.sent.pipe(Effect.flatMap(decodeListed));
      assert.deepStrictEqual(
        listed.result.tools.map(({ name }) => name),
        ["read_note", "wait_forever", "read_large"],
      );
      const ping = yield* bridge.sent;
      assert.deepStrictEqual(ping, { jsonrpc: "2.0", id: "usine-ping-1", method: "ping" });
      assert.isUndefined(attach.pollUnsafe(), "the attach waits for the ping's answer");
      yield* bridge.receive({ jsonrpc: "2.0", id: "usine-ping-1", result: {} });
      yield* Fiber.join(attach);
      assert.strictEqual(server.toolName("usine_read_note"), "read_note");
      assert.strictEqual(server.toolName("shell"), "shell");
      assert.strictEqual(server.toolName("usine_other"), "usine_other");
    }).pipe(Effect.scoped),
  );

  it.effect("serves its session's calls and refuses another session's and unknown requests", () =>
    Effect.gen(function* () {
      const { bridge } = yield* attached;
      yield* bridge.receive(call(2, "read_note", ROOT, { name: "greeting" }));
      const answer2 = yield* bridge.sent;
      assert.deepStrictEqual(answer2, {
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: NOTE }], isError: false },
      });
      yield* bridge.receive(call(3, "read_note", "ses_subagent", { name: "greeting" }));
      const answer3 = yield* bridge.sent;
      assert.deepStrictEqual(answer3, {
        jsonrpc: "2.0",
        id: 3,
        result: {
          content: [{ type: "text", text: "usine tools serve only the session that opened them" }],
          isError: true,
        },
      });
      yield* bridge.receive({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "read_note", arguments: { name: "greeting" } },
      });
      const unnamed = yield* bridge.sent;
      assert.deepStrictEqual(
        unnamed,
        { ...answer3, id: 9 },
        "a call that names no session is refused",
      );
      yield* bridge.receive(call(4, "missing_tool", ROOT));
      const answer4 = yield* bridge.sent;
      assert.deepStrictEqual(answer4, {
        jsonrpc: "2.0",
        id: 4,
        result: {
          content: [{ type: "text", text: "No usine tool is named missing_tool" }],
          isError: true,
        },
      });
      yield* bridge.receive({ jsonrpc: "2.0", id: 5, method: "tools/call" });
      const answer5 = yield* bridge.sent;
      assert.deepStrictEqual(answer5, {
        jsonrpc: "2.0",
        id: 5,
        error: { code: -32602, message: "usine couldn't read the tool call" },
      });
      yield* bridge.receive({ jsonrpc: "2.0", id: 6, method: "resources/list" });
      const answer6 = yield* bridge.sent;
      assert.deepStrictEqual(answer6, {
        jsonrpc: "2.0",
        id: 6,
        error: { code: -32601, message: "Method not found: resources/list" },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("answers a result too long for a bridge line with an error result", () =>
    Effect.gen(function* () {
      const { bridge } = yield* attached;
      yield* bridge.receive(call(2, "read_large", ROOT));
      const answer = yield* bridge.sent;
      assert.deepStrictEqual(answer, {
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [
            {
              type: "text",
              text: `The result of the usine tool read_large is longer than the ${MAX_PROTOCOL_LINE_BYTES} bytes that usine relays to OpenCode`,
            },
          ],
          isError: true,
        },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("interrupts a call that OpenCode cancels and never answers it", () => {
    const logs = collectLogs(["Info", "Warn"]);
    return Effect.gen(function* () {
      const { bridge, started, cancelled } = yield* attached;
      yield* bridge.receive(call(7, "wait_forever", ROOT));
      yield* started;
      yield* bridge.receive({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { reason: "no request ID" },
      });
      yield* bridge.receive({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 7, reason: "aborted" },
      });
      yield* cancelled;
      yield* bridge.receive({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 7, reason: "aborted again" },
      });
      yield* bridge.receive({ jsonrpc: "2.0", id: 8, method: "ping" });
      const answer7 = yield* bridge.sent;
      assert.deepStrictEqual(answer7, { jsonrpc: "2.0", id: 8, result: {} });
      const cancels = messages(logs.records).filter((message) =>
        /^(Skipping a cancel|Cancelling)/u.test(String(message)),
      );
      assert.deepStrictEqual(cancels, [
        "Skipping a cancel of a usine tool call that usine can't read; the call keeps running",
        "Cancelling a usine tool call that OpenCode no longer waits for",
        "Skipping a cancel of a usine tool call that isn't running",
      ]);
    }).pipe(Effect.scoped, Effect.provide(logs.layer));
  });

  it.effect("interrupts the running calls when the relay ends", () =>
    Effect.gen(function* () {
      const { bridge, started, cancelled } = yield* attached;
      yield* bridge.receive(call(7, "wait_forever", ROOT));
      yield* started;
      yield* bridge.fail(lost);
      yield* cancelled;
    }).pipe(Effect.scoped),
  );

  it.effect("waits for the list on the next socket when OpenCode closes the socket first", () =>
    Effect.gen(function* () {
      const { server } = yield* served;
      const bridge = yield* connection(101);
      const attach = yield* Effect.forkChild(server.attach(bridge.fake, "/work", ROOT));
      const ping1 = yield* listOn(bridge);
      assert.strictEqual(ping1.id, "usine-ping-1");
      yield* bridge.close;
      const ping2 = yield* listOn(bridge);
      assert.deepStrictEqual(ping2, { jsonrpc: "2.0", id: "usine-ping-2", method: "ping" });
      yield* bridge.receive({ jsonrpc: "2.0", id: "usine-ping-1", result: {} });
      yield* Effect.yieldNow;
      assert.isUndefined(attach.pollUnsafe(), "the closed socket's answer ends no wait");
      yield* bridge.receive({ jsonrpc: "2.0", id: "usine-ping-2", result: {} });
      yield* Fiber.join(attach);
    }).pipe(Effect.scoped),
  );

  it.effect("fails the launch with the relay's error when the bridge is lost during the wait", () =>
    Effect.gen(function* () {
      const { server } = yield* served;
      const bridge = yield* connection(101);
      const attach = yield* Effect.forkChild(
        server.attach(bridge.fake, "/work", ROOT).pipe(Effect.flip),
      );
      yield* bridge.connects;
      yield* bridge.fail(lost);
      const failure = yield* Fiber.join(attach);
      assert.strictEqual(failure, lost);
    }).pipe(Effect.scoped),
  );

  it.effect("fails the launch when the relay ends during the wait", () =>
    Effect.gen(function* () {
      const { server } = yield* served;
      const bridge = yield* connection(101);
      const attach = yield* Effect.forkChild(
        server.attach(bridge.fake, "/work", ROOT).pipe(Effect.flip),
      );
      yield* bridge.connects;
      yield* bridge.end;
      const failure = yield* Fiber.join(attach);
      assert.strictEqual(
        failure.message,
        "The usine tools' MCP relay ended with the bridge's output",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("doesn't wait for a list on the socket that a retained bridge holds", () =>
    Effect.gen(function* () {
      const { server } = yield* served;
      const bridge = yield* connection(200);
      yield* server.attach(bridge.fake, "/work", ROOT);
      const connect2 = yield* bridge.connects;
      assert.deepStrictEqual(connect2, ["usine", "/work"]);
      yield* bridge.receive(call(1, "read_note", ROOT, { name: "greeting" }));
      const answer8 = yield* bridge.sent;
      assert.deepStrictEqual(answer8, {
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: NOTE }], isError: false },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("fails the launch when OpenCode lists no tools within 30 seconds", () =>
    Effect.gen(function* () {
      const { server } = yield* served;
      const bridge = yield* connection(101);
      const attach = yield* Effect.forkChild(
        server.attach(bridge.fake, "/work", ROOT).pipe(Effect.flip),
      );
      yield* bridge.connects;
      yield* TestClock.adjust("30 seconds");
      const failure = yield* Fiber.join(attach);
      assert.strictEqual(failure.operation, "launch");
      assert.strictEqual(failure.message, "OpenCode didn't list the usine tools within 30 seconds");
      assert.deepStrictEqual(failure.sessionId, Option.some(sessionId));
    }).pipe(Effect.scoped),
  );
});
