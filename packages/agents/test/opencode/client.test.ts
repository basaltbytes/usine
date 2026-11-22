import { assert, describe, it } from "@effect/vitest";
import { type Cause, Effect, Exit, Fiber, Option, Queue, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { MAX_PROTOCOL_LINE_BYTES } from "../../src/child-host/lines.ts";
import { type BridgeClient, bridgeClient } from "../../src/harness/opencode/bridge/client.ts";
import { BridgeRequest, OpenCodePath } from "../../src/harness/opencode/bridge/lines.ts";
import type { SessionOperationError } from "../../src/runtime.ts";
import { collectLogs } from "../logs.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(BridgeRequest));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
const messages = (records: ReturnType<typeof collectLogs>["records"]) =>
  records.map(({ message }) => (Array.isArray(message) ? message[0] : message));

/**
 * A client over scripted bridge streams: `emit` writes a JSON output line, `emitText` any output
 * line, and `sent` reads a request line.
 */
const scripted = (generation: Option.Option<number> = Option.none()) =>
  Effect.gen(function* () {
    const input = yield* Queue.make<Uint8Array, Cause.Done>();
    const output = yield* Queue.make<Uint8Array, SessionOperationError | Cause.Done>();
    const client: BridgeClient = yield* bridgeClient({
      sessionId: Option.none(),
      input,
      output: Stream.fromQueue(output),
      generation,
    });
    const emitText = (line: string) => Queue.offer(output, encoder.encode(`${line}\n`));
    return {
      client,
      input,
      output,
      emitText,
      emit: (value: Schema.Json) => encodeJson(value).pipe(Effect.flatMap(emitText)),
      sent: Queue.take(input).pipe(
        Effect.map((bytes) => decoder.decode(bytes).trimEnd()),
        Effect.flatMap(decodeRequest),
      ),
    };
  });

describe("OpenCode bridge client", () => {
  it.effect(
    "relays readiness, answers, and events, and skips lines that aren't bridge output",
    () => {
      const logs = collectLogs(["Warn"]);
      return Effect.gen(function* () {
        const bridge = yield* scripted();
        yield* bridge.emit({ ready: true });
        yield* bridge.client.ready;
        const request = yield* Effect.forkChild(
          bridge.client.request("launch", {
            method: "POST",
            path: OpenCodePath.make("/api/session"),
            body: { title: "usine" },
          }),
        );
        const sent = yield* bridge.sent;
        assert.deepStrictEqual(sent, {
          id: 1,
          method: "POST",
          path: OpenCodePath.make("/api/session"),
          body: { title: "usine" },
        });
        yield* bridge.emitText("not json");
        for (const line of [
          { event: { data: {} } },
          { id: 99, status: 200, body: null },
          { event: { type: "first", data: {} } },
          { id: 1, status: 200, body: { id: "ses_1" } },
          { event: { type: "second", data: { sessionID: "ses_1" } } },
        ])
          yield* bridge.emit(line);
        const answer = yield* Fiber.join(request);
        assert.deepStrictEqual(answer, { id: 1, status: 200, body: { id: "ses_1" } });
        const events = yield* bridge.client.events.pipe(Stream.take(2), Stream.runCollect);
        assert.deepStrictEqual(Array.from(events), [
          { type: "first", data: {} },
          { type: "second", data: { sessionID: "ses_1" } },
        ]);
        assert.deepStrictEqual(messages(logs.records), [
          "Skipping an unknown OpenCode bridge line",
          "Skipping an unknown OpenCode bridge line",
        ]);
      }).pipe(Effect.scoped, Effect.provide(logs.layer));
    },
  );

  it.effect("prefixes request IDs with the relay generation", () =>
    Effect.gen(function* () {
      const bridge = yield* scripted(Option.some(3));
      const request = yield* Effect.forkChild(
        bridge.client.request("steer", { method: "GET", path: OpenCodePath.make("/api/session") }),
      );
      const sent = yield* bridge.sent;
      assert.deepStrictEqual(sent, {
        id: "3:1",
        method: "GET",
        path: OpenCodePath.make("/api/session"),
      });
      // An answer to the first request of an earlier connection matches nothing.
      yield* bridge.emit({ id: 1, status: 500, body: null });
      yield* bridge.emit({ id: "3:1", status: 404, body: "missing" });
      const answer = yield* Fiber.join(request);
      assert.deepStrictEqual(answer, { id: "3:1", status: 404, body: "missing" });
    }).pipe(Effect.scoped),
  );

  it.effect("fails a request that the bridge couldn't complete", () =>
    Effect.gen(function* () {
      const bridge = yield* scripted();
      const request = yield* Effect.forkChild(
        bridge.client.request("interrupt", {
          method: "POST",
          path: OpenCodePath.make("/api/session/s/interrupt"),
        }),
      );
      yield* bridge.sent;
      yield* bridge.emit({ id: 1, error: "Can't reach OpenCode: socket hang up" });
      const error = yield* Effect.flip(Fiber.join(request));
      assert.strictEqual(error.operation, "interrupt");
      assert.strictEqual(
        error.message,
        "The OpenCode bridge couldn't complete the request: Can't reach OpenCode: socket hang up",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("fails readiness, waiting requests, and events when the output ends", () =>
    Effect.gen(function* () {
      const bridge = yield* scripted();
      const request = yield* Effect.forkChild(
        bridge.client.request("launch", { method: "GET", path: OpenCodePath.make("/api/session") }),
      );
      yield* bridge.sent;
      yield* Queue.end(bridge.output);
      const rejected = yield* Effect.flip(Fiber.join(request));
      const unready = yield* Effect.flip(bridge.client.ready);
      const events = yield* Effect.flip(Stream.runDrain(bridge.client.events));
      const later = yield* Effect.flip(
        bridge.client.request("steer", { method: "GET", path: OpenCodePath.make("/api/session") }),
      );
      for (const error of [rejected, unready, events, later])
        assert.strictEqual(error.message, "The OpenCode bridge's output ended");
    }).pipe(Effect.scoped),
  );

  it.effect("fails a request after 60 seconds without an answer and skips the late answer", () => {
    const logs = collectLogs(["Info"]);
    return Effect.gen(function* () {
      const bridge = yield* scripted();
      const request = yield* Effect.forkChild(
        bridge.client.request("steer", {
          method: "POST",
          path: OpenCodePath.make("/api/session/s/prompt"),
        }),
      );
      yield* bridge.sent;
      yield* TestClock.adjust("59 seconds");
      assert.isUndefined(request.pollUnsafe());
      yield* TestClock.adjust("1 second");
      const error = yield* Effect.flip(Fiber.join(request));
      assert.strictEqual(error.operation, "steer");
      assert.strictEqual(
        error.message,
        "OpenCode didn't answer POST /api/session/s/prompt within 60 seconds",
      );
      yield* bridge.emit({ id: 1, status: 200, body: null });
      // The event follows the late answer, so the client has read the answer once it arrives.
      yield* bridge.emit({ event: { type: "after.answer", data: {} } });
      yield* bridge.client.events.pipe(Stream.take(1), Stream.runDrain);
      assert.deepStrictEqual(
        logs.records.map(({ message }) => message),
        [
          [
            "Skipping an OpenCode bridge answer with no waiting request",
            { requestId: 1, sessionId: undefined },
          ],
        ],
      );
    }).pipe(Effect.scoped, Effect.provide(logs.layer));
  });

  it.effect("fails readiness and events on an output line longer than the protocol limit", () =>
    Effect.gen(function* () {
      const bridge = yield* scripted();
      yield* bridge.emitText("x".repeat(MAX_PROTOCOL_LINE_BYTES + 1));
      yield* bridge.emit({ ready: true });
      const unready = yield* Effect.flip(bridge.client.ready);
      const events = yield* Effect.flip(Stream.runDrain(bridge.client.events));
      for (const error of [unready, events]) {
        assert.strictEqual(error.operation, "stream");
        assert.strictEqual(
          error.message,
          "The OpenCode bridge wrote a line longer than 4194304 bytes",
        );
      }
    }).pipe(Effect.scoped),
  );

  it.effect("fails a request when the bridge's input is closed", () =>
    Effect.gen(function* () {
      const bridge = yield* scripted();
      yield* Queue.end(bridge.input);
      const error = yield* Effect.flip(
        bridge.client.request("steer", { method: "GET", path: OpenCodePath.make("/api/session") }),
      );
      assert.strictEqual(error.message, "The OpenCode bridge's input is closed");
    }).pipe(Effect.scoped),
  );

  it("refuses a path that leaves origin form", () => {
    for (const path of ["/api/session", "/api/model?location[directory]=%2Fwork"])
      assert.isTrue(Schema.is(OpenCodePath)(path), path);
    for (const path of [
      "",
      "api/session",
      "//evil.example/x",
      "http://evil.example/x",
      "/a b",
      "/x\r\nHost: evil.example",
      "/é",
    ])
      assert.isFalse(Schema.is(OpenCodePath)(path), path);
  });

  it.effect("ends its input on close, then ends the events and rejects waiting requests", () => {
    const logs = collectLogs(["Info"]);
    return Effect.gen(function* () {
      const bridge = yield* scripted();
      yield* bridge.emit({ ready: true });
      yield* bridge.emit({ event: { type: "server.connected", data: {} } });
      const request = yield* Effect.forkChild(
        bridge.client.request("steer", { method: "GET", path: OpenCodePath.make("/api/session") }),
      );
      yield* bridge.sent;
      yield* bridge.client.close;
      const input = yield* Effect.exit(Queue.take(bridge.input));
      assert.isTrue(Exit.isFailure(input));
      const closing = yield* Effect.flip(
        bridge.client.request("launch", { method: "GET", path: OpenCodePath.make("/api/session") }),
      );
      assert.strictEqual(closing.message, "The OpenCode bridge is closing");
      yield* Queue.end(bridge.output);
      const rejected = yield* Effect.flip(Fiber.join(request));
      assert.strictEqual(rejected.operation, "steer");
      assert.strictEqual(rejected.message, "The OpenCode bridge closed before it answered");
      const events = yield* Stream.runCollect(bridge.client.events);
      assert.deepStrictEqual(Array.from(events), [{ type: "server.connected", data: {} }]);
      assert.deepStrictEqual(messages(logs.records), [
        "The OpenCode bridge's output ended after close",
      ]);
    }).pipe(Effect.scoped, Effect.provide(logs.layer));
  });
});
