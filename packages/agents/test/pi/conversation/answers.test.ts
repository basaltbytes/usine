import { assert, describe, it } from "@effect/vitest";
import { OperatorMessage, Release, Steer } from "@usine/core/attempt/channel";
import { Effect, Fiber } from "effect";
import { child, conversation, noDelivery } from "./fixture.ts";

describe("answers to the operator", () => {
  /** Returns a held child that finished its task turn and waits idle after one tool call. */
  const heldAfterWork = (id: string) =>
    Effect.gen(function* () {
      const session = yield* conversation(child(id));
      yield* session.intervene(OperatorMessage.make({ message: "Wait for me." }), noDelivery);
      yield* session.read((yield* session.unread).map(({ id }) => id));
      yield* session.runTool("call-1");
      yield* session.finish("Opened the pull request.");
      return session;
    });

  it.effect("marks a final answer that replies to the operator's message", () =>
    Effect.gen(function* () {
      const session = yield* heldAfterWork("answered");
      yield* session.intervene(
        OperatorMessage.make({ message: "Why did you skip the tests?" }),
        noDelivery,
      );
      yield* session.finish("The tests need a database.");
      yield* session.intervene(Release.make(), noDelivery);
      const result = yield* Fiber.join(session.result);
      assert.strictEqual(result.message, "The tests need a database.");
      assert.isTrue(result.answeredOperator);
    }),
  );

  it.effect("doesn't mark an answer when a tool call followed the operator's input", () =>
    Effect.gen(function* () {
      const session = yield* heldAfterWork("worked-after");
      yield* session.intervene(Steer.make({ message: "Run the tests too." }), noDelivery);
      yield* session.runTool("call-2");
      yield* session.finish("The tests pass.");
      yield* session.intervene(Release.make(), noDelivery);
      assert.isFalse((yield* Fiber.join(session.result)).answeredOperator);
    }),
  );

  it.effect("marks the answer to a queued message that the session read after its last tool", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("queued-answer"));
      yield* session.runTool("call-1");
      yield* session.intervene(Steer.make({ message: "What changed?" }), noDelivery);
      yield* session.read((yield* session.unread).map(({ id }) => id));
      yield* session.finish("Only the lockfile changed.");
      assert.isTrue((yield* Fiber.join(session.result)).answeredOperator);
    }),
  );

  it.effect("doesn't mark an answer when a vendor callback queued a later tool call", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("vendor-tool"));
      yield* session.intervene(Steer.make({ message: "What changed?" }), noDelivery);
      yield* session.read((yield* session.unread).map(({ id }) => id));
      yield* session.runToolUnsafe("call-1");
      yield* session.finish("Only the lockfile changed.");
      assert.isFalse((yield* Fiber.join(session.result)).answeredOperator);
    }),
  );

  it.effect("counts a read at the tool-call count that the harness captured", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("captured-read"));
      yield* session.intervene(Steer.make({ message: "What changed?" }), noDelivery);
      const captured = yield* session.toolCalls;
      // A tool call that the harness started before the forked read ran.
      yield* session.runTool("call-1");
      yield* session.read(
        (yield* session.unread).map(({ id }) => id),
        captured,
      );
      yield* session.finish("Only the lockfile changed.");
      assert.isFalse((yield* Fiber.join(session.result)).answeredOperator);
    }),
  );

  it.effect("keeps the later of two reads when the harness reports an earlier one last", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("later-read"));
      yield* session.intervene(Steer.make({ message: "Check the lockfile." }), noDelivery);
      yield* session.intervene(Steer.make({ message: "Check the tests." }), noDelivery);
      const [first, second] = yield* session.unread;
      assert(first !== undefined && second !== undefined);
      yield* session.runTool("call-1");
      const captured = yield* session.toolCalls;
      yield* session.runTool("call-2");
      yield* session.read([first.id]);
      // A forked read that the harness captured before the second tool call runs last.
      yield* session.read([second.id], captured);
      yield* session.finish("Both are fine.");
      assert.isTrue((yield* Fiber.join(session.result)).answeredOperator);
    }),
  );

  // A turn's result acknowledges input that the turn folded in at the first tool result after the
  // input was queued, or at its end.
  for (const { name, before, after, answered } of [
    {
      name: "marks an answer to a steer that a turn folded in at the next tool result",
      before: [],
      after: ["call-1"],
      answered: true,
    },
    {
      name: "doesn't mark an answer to a steer that a turn folded in before a later tool call",
      before: [],
      after: ["call-1", "call-2"],
      answered: false,
    },
  ])
    it.effect(name, () =>
      Effect.gen(function* () {
        const session = yield* conversation(child("turn-read"));
        for (const callId of before) yield* session.runToolRound(callId);
        yield* session.intervene(Steer.make({ message: "Run the tests too." }), noDelivery);
        for (const callId of after) yield* session.runToolRound(callId);
        yield* session.read(
          (yield* session.unread).map(({ id }) => id),
          "turn",
        );
        yield* session.finish("The tests pass.");
        assert.strictEqual((yield* Fiber.join(session.result)).answeredOperator, answered);
      }),
    );

  it.effect("reads several messages of one turn at the latest point that it folded one in", () =>
    Effect.gen(function* () {
      for (const { later, answered } of [
        { later: false, answered: true },
        { later: true, answered: false },
      ]) {
        const session = yield* conversation(child(`turn-reads-${String(later)}`));
        yield* session.intervene(Steer.make({ message: "Check the lockfile." }), noDelivery);
        // The turn folds in the first steer here, and the second one at the next tool result.
        yield* session.runToolRound("call-1");
        yield* session.intervene(Steer.make({ message: "Check the tests." }), noDelivery);
        yield* session.runToolRound("call-2");
        if (later) yield* session.runToolRound("call-3");
        yield* session.read(
          (yield* session.unread).map(({ id }) => id),
          "turn",
        );
        yield* session.finish("Both are fine.");
        assert.strictEqual((yield* Fiber.join(session.result)).answeredOperator, answered);
      }
    }),
  );

  it.effect("doesn't mark an answer after the harness's own continuation input", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("continued"));
      yield* session.intervene(Steer.make({ message: "What changed?" }), noDelivery);
      yield* session.read((yield* session.unread).map(({ id }) => id));
      yield* session.recover([], () => Effect.succeed("queued" as const));
      yield* session.finish("Done.");
      assert.isFalse((yield* Fiber.join(session.result)).answeredOperator);
    }),
  );

  it.effect("keeps the answer to the operator of an idle report restored under a Hold", () =>
    Effect.gen(function* () {
      const answered = yield* heldAfterWork("idle-answer");
      yield* answered.intervene(OperatorMessage.make({ message: "Why?" }), noDelivery);
      yield* answered.events;
      yield* answered.finish("The tests need a database.");
      const [idle] = yield* answered.events;
      assert(idle?._tag === "SessionIdle");
      assert.isTrue(idle.answeredOperator);

      // A restart restores the stored idle report and whether it answered the operator.
      const restored = yield* conversation(child("idle-answer-restored"), {
        held: true,
        idle: idle.message,
        idleAnsweredOperator: idle.answeredOperator,
      });
      yield* restored.intervene(Release.make(), noDelivery);
      const result = yield* Fiber.join(restored.result);
      assert.strictEqual(result.message, "The tests need a database.");
      assert.isTrue(result.answeredOperator);
    }),
  );
});
