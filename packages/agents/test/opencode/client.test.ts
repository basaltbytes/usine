import { assert, describe, it } from "@effect/vitest";
import { type Cause, Effect, Exit, Fiber, Option, Queue, Schema, Stream } from "effect";
import { bridgeClient } from "../../src/harness/opencode/bridge/client.ts";
import { BridgeRequest } from "../../src/harness/opencode/bridge/lines.ts";
import type { SessionOperationError } from "../../src/runtime.ts";
import { collectLogs } from "../logs.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(BridgeRequest));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

/**
 * A client over scripted bridge streams: `emit` writes a JSON output line, `emitText` any output
 * line, and `sent` reads a request line.
 */
const scripted = (generation: Option.Option<number> = Option.none()) =>
  Effect.gen(function* () {
    const input = yield* Queue.make<Uint8Array, Cause.Done>();
    const output = yield* Queue.make<Uint8Array, SessionOperationError | Cause.Done>();
    const client = yield* bridgeClient({
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
            path: "/api/session",
            body: { title: "usine" },
          }),
        );
        const sent = yield* bridge.sent;
        assert.deepStrictEqual(sent, {
          id: 1,
          method: "POST",
          path: "/api/session",
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
        assert.deepStrictEqual(
          logs.records.map(({ message }) => (Array.isArray(message) ? message[0] : message)),
          ["Skipping an unknown OpenCode bridge line", "Skipping an unknown OpenCode bridge line"],
        );
      }).pipe(Effect.scoped, Effect.provide(logs.layer));
    },
  );

  it.effect("prefixes request IDs with the relay generation", () =>
    Effect.gen(function* () {
      const bridge = yield* scripted(Option.some(3));
      const request = yield* Effect.forkChild(
        bridge.client.request("steer", { method: "GET", path: "/api/session" }),
      );
      const sent = yield* bridge.sent;
      assert.deepStrictEqual(sent, { id: "3:1", method: "GET", path: "/api/session" });
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
        bridge.client.request("interrupt", { method: "POST", path: "/api/session/s/interrupt" }),
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
        bridge.client.request("launch", { method: "GET", path: "/api/session" }),
      );
      yield* bridge.sent;
      yield* Queue.end(bridge.output);
      const rejected = yield* Effect.flip(Fiber.join(request));
      const unready = yield* Effect.flip(bridge.client.ready);
      const events = yield* Effect.flip(Stream.runDrain(bridge.client.events));
      const later = yield* Effect.flip(
        bridge.client.request("steer", { method: "GET", path: "/api/session" }),
      );
      for (const error of [rejected, unready, events, later])
        assert.strictEqual(error.message, "The OpenCode bridge's output ended");
    }).pipe(Effect.scoped),
  );

  it.effect("ends its input on close, then ends the events and rejects waiting requests", () =>
    Effect.gen(function* () {
      const bridge = yield* scripted();
      yield* bridge.emit({ ready: true });
      yield* bridge.emit({ event: { type: "server.connected", data: {} } });
      const request = yield* Effect.forkChild(
        bridge.client.request("steer", { method: "GET", path: "/api/session" }),
      );
      yield* bridge.sent;
      yield* bridge.client.close;
      const input = yield* Effect.exit(Queue.take(bridge.input));
      assert.isTrue(Exit.isFailure(input));
      const closing = yield* Effect.flip(
        bridge.client.request("launch", { method: "GET", path: "/api/session" }),
      );
      assert.strictEqual(closing.message, "The OpenCode bridge is closing");
      yield* Queue.end(bridge.output);
      const rejected = yield* Effect.flip(Fiber.join(request));
      assert.strictEqual(rejected.operation, "steer");
      assert.strictEqual(rejected.message, "The OpenCode bridge closed before it answered");
      const events = yield* Stream.runCollect(bridge.client.events);
      assert.deepStrictEqual(Array.from(events), [{ type: "server.connected", data: {} }]);
    }).pipe(Effect.scoped),
  );
});
