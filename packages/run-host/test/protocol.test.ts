import { describe, expect, it } from "@effect/vitest";
import { SessionOperationError } from "@usine/agents/runtime";
import { AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { Deferred, Effect, Logger, Option, Path, Queue, Schema } from "effect";
import { command, controlledSession, spec, start } from "./support/session.ts";
import { startHost } from "./support/stdio.ts";

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
      expect(logs).toContainEqual(
        expect.arrayContaining([
          expect.objectContaining({
            attemptId: spec.attemptId,
            repository: spec.repository,
            errorTag: "SessionOperationError",
            message: "The SDK interrupt endpoint closed.",
          }),
        ]),
      );
    }).pipe(Effect.scoped, Effect.provide(Path.layer)),
  );

  for (const [name, wire] of [
    [
      "a command before Start",
      Schema.encodeSync(AttemptChannel.InputFrameFromJson)(
        command(new AttemptChannel.Interrupt()),
      ) + "\n",
    ],
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
        expect(error).toMatchObject({ _tag: "RunHostError", stage: "input" });
        expect(host.frames).toEqual([]);
        expect(yield* Queue.size(session.launches)).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(Path.layer)),
    );
  }

  for (const [name, frame] of [
    ["duplicate Start", start()],
    [
      "cross-Attempt Steer",
      command(
        new AttemptChannel.Steer({ message: "Wrong attempt" }),
        2,
        AttemptId.make("other/execute/1"),
      ),
    ],
    [
      "cross-Attempt Interrupt",
      command(new AttemptChannel.Interrupt(), 2, AttemptId.make("other/execute/1")),
    ],
    ["sequence gap", command(new AttemptChannel.Interrupt(), 3)],
    ["replayed sequence", command(new AttemptChannel.Steer({ message: "Replay" }), 1)],
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
        expect(error).toMatchObject({ _tag: "RunHostError", stage: "input" });
        expect(host.frames.map((frame) => frame.payload._tag)).toEqual(["Started"]);
        expect(yield* Queue.size(session.launches)).toBe(1);
        expect(yield* Queue.size(session.steers)).toBe(0);
        expect(yield* Queue.size(interruptions)).toBe(0);
        expect(yield* Deferred.isDone(session.released)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(Path.layer)),
    );
  }

  it.effect(
    "decodes split UTF-8 and coalesced commands, then interrupts the active session once",
    () =>
      Effect.gen(function* () {
        const session = yield* controlledSession();
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
      }).pipe(Effect.scoped, Effect.provide(Path.layer)),
  );

  it.effect("fails when stdin closes during an active Attempt and releases the session", () =>
    Effect.gen(function* () {
      const session = yield* controlledSession();
      const host = yield* startHost(session.runtime);
      yield* host.send(start());
      yield* host.next;
      yield* Queue.end(host.stdin);
      const error = yield* Effect.flip(host.result);
      expect(error).toMatchObject({ _tag: "RunHostError", stage: "input" });
      expect(host.frames.map((frame) => frame.payload._tag)).toEqual(["Started"]);
      expect(yield* Deferred.isDone(session.released)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(Path.layer)),
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
      }).pipe(Effect.scoped, Effect.provide(Path.layer)),
  );
});
