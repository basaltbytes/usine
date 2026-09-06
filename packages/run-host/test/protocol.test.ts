import { assert, describe, expect, it } from "@effect/vitest";
import { SessionOperationError } from "@usine/agents/runtime";
import { AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { Deferred, Effect, Layer, Logger, Option, Path, Queue, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { command, controlledSession, spec, start } from "./support/session.ts";
import { startHost } from "./support/stdio.ts";

// Protocol rejection and interruption must finish without harvesting results.
const services = Layer.merge(
  Path.layer,
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
    ChildProcessSpawner.make(() => Effect.die("Unexpected process during a protocol test")),
  ),
);

describe("run-host protocol", () => {
  it.effect("reports failed SDK interrupt delivery while retaining the interrupted outcome", () =>
    Effect.gen(function* () {
      const logs: Array<unknown> = [];
      const logger = Logger.make<unknown, void>(({ message }) => {
        logs.push(message);
      });
      const session = yield* controlledSession(
        new SessionOperationError({
          operation: "interrupt",
          sessionId: Option.none(),
          message: "The SDK interrupt endpoint closed.",
          cause: new Error("Connection closed"),
        }),
      );
      const host = yield* startHost(session.runtime).pipe(Effect.withLogger(logger));
      yield* host.send(start());
      yield* host.next;
      yield* host.send(command(new AttemptChannel.Interrupt()));
      yield* host.result;
      expect(host.frames.map((frame) => frame.payload._tag)).toEqual(["Started", "Interrupted"]);
      expect(logs).toContainEqual([
        "Session interrupt delivery failed",
        {
          attemptId: spec.attemptId,
          repository: spec.repository,
          errorTag: "SessionOperationError",
          message: "The SDK interrupt endpoint closed.",
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  for (const payload of [
    new AttemptChannel.Steer({ message: "Wait for Start" }),
    new AttemptChannel.Interrupt(),
  ]) {
    it.effect(`rejects ${payload._tag} before Start without launching an agent`, () =>
      Effect.gen(function* () {
        const session = yield* controlledSession();
        const host = yield* startHost(session.runtime);
        yield* host.send(command(payload));
        const error = yield* Effect.flip(host.result);
        assert.strictEqual(error._tag, "RunHostError");
        expect(error.stage).toBe("input");
        expect(error.message).toBe("The first protocol frame must be Start");
        expect(host.frames).toEqual([]);
        expect(yield* Queue.size(session.launches)).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(services)),
    );
  }

  for (const [name, wire] of [
    ["malformed JSON", "{\n"],
    [
      "unsupported version",
      JSON.stringify({ ...Schema.encodeSync(AttemptChannel.Start)(start()), version: 0 }) + "\n",
    ],
    [
      "unknown field",
      JSON.stringify({ ...Schema.encodeSync(AttemptChannel.Start)(start()), token: "unexpected" }) +
        "\n",
    ],
  ]) {
    it.effect(`rejects ${name} at the stdio boundary`, () =>
      Effect.gen(function* () {
        const session = yield* controlledSession();
        const host = yield* startHost(session.runtime);
        yield* Queue.offer(host.stdin, new TextEncoder().encode(wire));
        const error = yield* Effect.flip(host.result);
        assert.strictEqual(error._tag, "RunHostError");
        expect(error.stage).toBe("input");
        expect(error.message).toBe("Invalid protocol input frame");
        expect(host.frames).toEqual([]);
        expect(yield* Queue.size(session.launches)).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(services)),
    );
  }

  for (const [name, frame, message] of [
    ["duplicate Start", start(), "The run host received a second Start frame"],
    [
      "cross-Attempt Steer",
      command(
        new AttemptChannel.Steer({ message: "Wrong attempt" }),
        1,
        AttemptId.make("other/execute/1"),
      ),
      "The run host received a command for another Attempt",
    ],
    [
      "cross-Attempt Interrupt",
      command(new AttemptChannel.Interrupt(), 1, AttemptId.make("other/execute/1")),
      "The run host received a command for another Attempt",
    ],
    [
      "sequence gap",
      command(new AttemptChannel.Interrupt(), 3),
      "The run host received a non-contiguous input sequence",
    ],
    [
      "replayed sequence",
      command(new AttemptChannel.Steer({ message: "Replay" }), 1),
      "The run host received a non-contiguous input sequence",
    ],
  ] as const) {
    it.effect(`rejects ${name} during an active Attempt`, () =>
      Effect.gen(function* () {
        const interruptions = yield* Queue.make<void>();
        const session = yield* controlledSession(
          Queue.offer(interruptions, undefined).pipe(Effect.asVoid),
        );
        const host = yield* startHost(session.runtime);
        yield* host.send(start());
        expect((yield* host.next).payload._tag).toBe("Started");
        yield* host.send(command(new AttemptChannel.Steer({ message: "Continue" })));
        expect(yield* Queue.take(session.steers)).toBe("Continue");
        yield* host.send(frame);
        const error = yield* Effect.flip(host.result);
        assert.strictEqual(error._tag, "RunHostError");
        expect(error.stage).toBe("input");
        expect(error.message).toBe(message);
        expect(host.frames.map((frame) => frame.payload._tag)).toEqual(["Started"]);
        expect(yield* Queue.size(session.launches)).toBe(1);
        expect(yield* Queue.size(session.steers)).toBe(0);
        expect(yield* Queue.size(interruptions)).toBe(0);
        expect(yield* Deferred.isDone(session.released)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(services)),
    );
  }

  it.effect(
    "decodes split UTF-8 and coalesced commands, then interrupts the active session once",
    () =>
      Effect.gen(function* () {
        const interruptions = yield* Queue.make<void>();
        const session = yield* controlledSession(
          Queue.offer(interruptions, undefined).pipe(Effect.asVoid),
        );
        const host = yield* startHost(session.runtime);
        const encode = Schema.encodeSync(AttemptChannel.InputFrameFromJson);
        const bytes = new TextEncoder().encode(
          `${encode(start())}\n${encode(command(new AttemptChannel.Steer({ message: "Keep café accents" })))}\n${encode(command(new AttemptChannel.Interrupt(), 2))}\n`,
        );
        const split = bytes.indexOf(0xc3) + 1;
        yield* Queue.offer(host.stdin, bytes.slice(0, split));
        yield* Queue.offer(host.stdin, bytes.slice(split));
        yield* host.result;
        expect((yield* Queue.take(session.launches)).spec).toEqual(spec);
        expect(yield* Queue.take(session.steers)).toBe("Keep café accents");
        expect(yield* Queue.size(interruptions)).toBe(1);
        expect(
          host.frames.map((frame) => [frame.sequence, frame.attemptId, frame.payload._tag]),
        ).toEqual([
          [1, spec.attemptId, "Started"],
          [2, spec.attemptId, "Interrupted"],
        ]);
        expect(host.frames[0]?.payload).toEqual(
          new AttemptChannel.Started({ parentModel: session.session.brain.model }),
        );
        expect(yield* Deferred.isDone(session.released)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.effect("fails when stdin closes during an active Attempt and releases the session", () =>
    Effect.gen(function* () {
      const session = yield* controlledSession();
      const host = yield* startHost(session.runtime);
      yield* host.send(start());
      yield* host.next;
      yield* Queue.end(host.stdin);
      const error = yield* Effect.flip(host.result);
      assert.strictEqual(error._tag, "RunHostError");
      expect(error.message).toBe("The protocol input channel closed before the run host finished");
      expect(host.frames.map((frame) => frame.payload._tag)).toEqual(["Started"]);
      expect(yield* Deferred.isDone(session.released)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.effect(
    "starts native interrupt delivery before terminal cleanup without waiting for the SDK promise",
    () =>
      Effect.gen(function* () {
        let deliveries = 0;
        const deliveryStopped = yield* Deferred.make<void>();
        const session = yield* controlledSession(
          Effect.promise(() => {
            deliveries += 1;
            return new Promise<void>(() => {});
          }).pipe(Effect.ensuring(Deferred.succeed(deliveryStopped, undefined))),
        );
        const host = yield* startHost(session.runtime);
        yield* host.send(start());
        yield* host.next;
        yield* host.send(command(new AttemptChannel.Interrupt()));
        yield* host.result;
        expect(deliveries).toBe(1);
        expect(host.frames.map((frame) => frame.payload._tag)).toEqual(["Started", "Interrupted"]);
        expect(yield* Deferred.isDone(deliveryStopped)).toBe(true);
        expect(yield* Deferred.isDone(session.released)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(services)),
  );
});
