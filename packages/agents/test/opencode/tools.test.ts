import { assert, describe, it } from "@effect/vitest";
import { AgentSessionId } from "@usine/core/agent/session";
import { type Cause, Deferred, Effect, Fiber, Option, Queue, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { TestClock } from "effect/testing";
import type {
  BridgeMcpClosed,
  BridgeMcpMessage,
  McpMessage,
} from "../../src/harness/opencode/bridge/lines.ts";
import { type McpConnection, serveOpenCodeTools } from "../../src/harness/opencode/tools.ts";
import { hostToolSet } from "../../src/harness/tools.ts";
import type { SessionOperationError } from "../../src/runtime.ts";
import { NOTE, ReadNote } from "../contract/host-tools.ts";

const ROOT = "ses_root";
const decodeListed = Schema.decodeUnknownEffect(
  Schema.Struct({
    result: Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
  }),
);
const sessionId = AgentSessionId.make("parent:tools:child:1");

const WaitForever = Tool.make("wait_forever", {
  description: "Waits until the call is cancelled.",
  success: Schema.String,
});
const tools = Toolkit.make(ReadNote, WaitForever);

/** A bridge that answers the connect line with `status` and records the messages that it relays. */
const connection = (status: number) =>
  Effect.gen(function* () {
    const output = yield* Queue.make<
      BridgeMcpMessage | BridgeMcpClosed,
      SessionOperationError | Cause.Done
    >();
    const sent = yield* Queue.unbounded<McpMessage>();
    const connects = yield* Queue.unbounded<readonly [string, string]>();
    const fake: McpConnection = {
      mcp: Stream.fromQueue(output),
      connectMcp: (_operation, server, directory) =>
        Queue.offer(connects, [server, directory]).pipe(Effect.as({ id: 1, status, body: null })),
      sendMcp: (_server, message) => Queue.offer(sent, message).pipe(Effect.asVoid),
    };
    return {
      fake,
      connects: Queue.take(connects),
      sent: Queue.take(sent),
      /** Sends `message` from OpenCode to the usine tools' server. */
      receive: (message: McpMessage) => Queue.offer(output, { mcp: "usine", message }),
    };
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
  });
  const bound = yield* hostToolSet(tools).pipe(Effect.provide(handlers));
  const server = yield* serveOpenCodeTools(bound, sessionId);
  return { server, started: Deferred.await(started), cancelled: Deferred.await(cancelled) };
});

/** Attaches the tools on a new socket and runs OpenCode's side of the start up to the ping's answer. */
const attached = Effect.gen(function* () {
  const { server, started, cancelled } = yield* served;
  const bridge = yield* connection(101);
  const attach = yield* Effect.forkChild(server.attach(bridge.fake, "/work", ROOT));
  yield* bridge.receive({ jsonrpc: "2.0", id: 0, method: "initialize" });
  yield* bridge.sent;
  yield* bridge.receive({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  yield* bridge.sent;
  const ping = yield* bridge.sent;
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
        ["read_note", "wait_forever"],
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

  it.effect("interrupts a call that OpenCode cancels and never answers it", () =>
    Effect.gen(function* () {
      const { bridge, started, cancelled } = yield* attached;
      yield* bridge.receive(call(7, "wait_forever", ROOT));
      yield* started;
      yield* bridge.receive({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 7, reason: "aborted" },
      });
      yield* cancelled;
      yield* bridge.receive({ jsonrpc: "2.0", id: 8, method: "ping" });
      const answer7 = yield* bridge.sent;
      assert.deepStrictEqual(answer7, { jsonrpc: "2.0", id: 8, result: {} });
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
