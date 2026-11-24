import { assert, describe, it } from "@effect/vitest";
import { OperatorMessage } from "@usine/core/attempt/channel";
import { Deferred, Effect, Fiber, Option } from "effect";
import { ChildSessionJournal, RestartState } from "../../../src/runtime.ts";
import { sessionChannel } from "../../../src/harness/session.ts";
import { type MessageTaken, sessionConversation } from "../../../src/harness/conversation.ts";
import { Receipt } from "../../../src/harness/receipts.ts";
import { child, policyOf, noDelivery } from "./fixture.ts";

describe("own inputs", () => {
  /**
   * Starts a conversation whose `send` returns `taken()` (default `"queued"`), and `received` runs
   * at each save.
   */
  const ownInputs = (
    id: string,
    options: {
      readonly taken?: () => MessageTaken;
      readonly received?: ChildSessionJournal["Service"]["received"];
    } = {},
  ) =>
    Effect.gen(function* () {
      const session = child(id);
      const channel = yield* sessionChannel({ sessionId: session.id, label: "Conversation test" });
      const policy = policyOf(RestartState.make({}));
      const controls = yield* sessionConversation({
        session,
        channel,
        policy: {
          ...policy,
          journal: ChildSessionJournal.of({
            ...ChildSessionJournal.noop,
            received: options.received ?? ChildSessionJournal.noop.received,
          }),
        },
        decode: (receipt: Receipt) => [receipt],
        send: () => Effect.sync(options.taken ?? (() => "queued" as const)),
        pause: Effect.void,
        beforeFinish: Effect.void,
        maxBackgroundWaitMinutes: Option.none(),
      });
      /** Signals that the harness recorded an input with `text` as native item `item`. */
      const record = (text: string, item: string) =>
        controls.observe(
          Receipt.ByText({ text, at: "now", item: Option.some({ id: item, turn: "turn-1" }) }),
        );
      return { ...controls, record };
    });
  /** Blocks each save until `saved` completes; `saving` completes when the first one starts. */
  const blockedSaves = Effect.gen(function* () {
    const saving = yield* Deferred.make<void>();
    const saved = yield* Deferred.make<void>();
    return {
      saving,
      saved,
      received: () =>
        Deferred.succeed(saving, undefined).pipe(Effect.andThen(Deferred.await(saved))),
    };
  });

  it.effect("drops the own inputs at a turn end that waits for the lock during a save", () =>
    Effect.gen(function* () {
      const { saving, saved, received } = yield* blockedSaves;
      const session = yield* ownInputs("turn-end-order", { received });
      yield* session.sendOwn("Do the task", () => Effect.void);
      const other = yield* session.record("Look around first.", "item-1").pipe(Effect.forkChild);
      yield* Deferred.await(saving);
      const turnEnd = yield* session.turnEnded().pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(saved, undefined);
      yield* Fiber.join(other);
      yield* Fiber.join(turnEnd);
      yield* session.intervene(OperatorMessage.make({ message: "Do the task" }), noDelivery);
      const { read } = yield* session.record("Do the task", "item-2");
      assert.lengthOf(
        read,
        1,
        "the turn end dropped the own input, so the record reads the message",
      );
    }),
  );

  it.effect("keeps an own input that the harness holds for its next turn past a turn end", () =>
    Effect.gen(function* () {
      const session = yield* ownInputs("held-continuation");
      // A turn is interrupting, so the harness holds the recovery's continuation for the next turn.
      yield* session.recover([], () => Effect.succeed("after-turn" as const));
      yield* session.turnEnded();
      // The next turn starts with the continuation.
      yield* session.intervene(OperatorMessage.make({ message: "Continue the task." }), noDelivery);
      const { read } = yield* session.record("Continue the task.", "continuation");
      assert.deepStrictEqual(read, [], "the record is the continuation's");
      const unread = yield* session.unread;
      assert.lengthOf(unread, 1);
    }),
  );

  it.effect("applies a turn end that arrives during an own input's send after the send", () =>
    Effect.gen(function* () {
      const session = yield* ownInputs("turn-end-during-send");
      const sending = yield* Deferred.make<void>();
      const sent = yield* Deferred.make<void>();
      const send = yield* session
        .sendOwn("Continue the task.", () =>
          Deferred.succeed(sending, undefined).pipe(
            Effect.andThen(Deferred.await(sent)),
            Effect.as("after-turn" as const),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(sending);
      const turnEnd = yield* session.turnEnded().pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(sent, undefined);
      yield* Fiber.join(send);
      yield* Fiber.join(turnEnd);
      yield* session.intervene(OperatorMessage.make({ message: "Continue the task." }), noDelivery);
      const { read } = yield* session.record("Continue the task.", "continuation");
      assert.deepStrictEqual(
        read,
        [],
        "the turn end activated the continuation that the harness held for its next turn",
      );
    }),
  );

  it.effect(
    "keeps only after-turn own inputs for the next turn and drops the ended turn's input",
    () =>
      Effect.gen(function* () {
        const session = yield* ownInputs("latest-held-inputs");
        yield* session.sendOwn("Old input", () => Effect.void);
        for (const text of ["Held one", "Held two"])
          yield* session.sendOwn(text, () => Effect.succeed("after-turn" as const));
        yield* session.turnEnded();
        const messages = ["Old input", "Held one", "Held two"].map((message) =>
          OperatorMessage.make({ message }),
        );
        for (const message of messages) yield* session.intervene(message, noDelivery);
        const reads: Array<number> = [];
        for (const [index, message] of messages.entries()) {
          const { read } = yield* session.record(message.message, `item-${index}`);
          reads.push(read.length);
        }
        assert.deepStrictEqual(reads, [1, 0, 0]);
        assert.deepStrictEqual(
          (yield* session.unread).map(({ id }) => id),
          messages.slice(1).map(({ id }) => id),
        );
      }),
  );

  it.effect(
    "keeps after-turn own inputs and operator messages separate from a delayed receipt of the ending turn",
    () =>
      Effect.gen(function* () {
        let disposition: MessageTaken = "after-turn";
        const session = yield* ownInputs("delayed-receipt", { taken: () => disposition });
        yield* session.sendOwn("Continue the task.", () => Effect.succeed("after-turn" as const));
        const repeated = OperatorMessage.make({ message: "Continue the task." });
        yield* session.intervene(repeated, noDelivery);
        const delayed = yield* session.record("Continue the task.", "old-turn-record");
        assert.deepStrictEqual(delayed.read, [], "the old turn's record reads no next-turn input");
        disposition = "queued";
        yield* session.turnEnded();
        const continuation = yield* session.record("Continue the task.", "next-turn-own");
        assert.deepStrictEqual(continuation.read, [], "the next turn's own input stays intact");
        const operator = yield* session.record("Continue the task.", "next-turn-operator");
        assert.deepStrictEqual(operator.read, [repeated.id]);
      }),
  );

  it.effect("keeps an own input that is sent while a receipt saves", () =>
    Effect.gen(function* () {
      const { saving, saved, received } = yield* blockedSaves;
      const session = yield* ownInputs("send-during-save", { received });
      const other = yield* session.record("Look around first.", "item-1").pipe(Effect.forkChild);
      yield* Deferred.await(saving);
      const send = yield* session
        .sendOwn("Do the task", () => Effect.void)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(saved, undefined);
      yield* Fiber.join(other);
      yield* Fiber.join(send);
      yield* session.intervene(OperatorMessage.make({ message: "Do the task" }), noDelivery);
      const { read } = yield* session.record("Do the task", "item-2");
      assert.deepStrictEqual(
        read,
        [],
        "the save didn't write back an inbox without the task, so the record is the task's",
      );
    }),
  );
});
