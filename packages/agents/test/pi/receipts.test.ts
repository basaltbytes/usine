import { assert, describe, it } from "@effect/vitest";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  ChildSession,
  OperatorMessageId,
  ToolFinished,
  ToolStarted,
} from "@usine/core/agent/session";
import { Steer } from "@usine/core/attempt/channel";
import { Deferred, Effect, Option, Queue } from "effect";
import { claudeReceipts } from "../../src/harness/claude/codec.ts";
import { codexReceipts } from "../../src/harness/codex/codec.ts";
import type { ContinuationPolicy } from "../../src/harness/continuation.ts";
import { sessionConversation } from "../../src/harness/conversation.ts";
import { piReceipts } from "../../src/harness/pi/turns.ts";
import {
  type Inbox,
  match,
  type Matched,
  Receipt,
  type Unread,
} from "../../src/harness/receipts.ts";
import { sessionChannel } from "../../src/harness/session.ts";
import type { UserMessageItem } from "../../src/protocol/codex/codex.ts";
import { ChildSessionJournal, RestartState } from "../../src/runtime.ts";

const id = (index: number) =>
  OperatorMessageId.make(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);

/** An unread message that this process sent, unless `sent` is false. */
const unread = (index: number, message: string, options: Partial<Unread> = {}): Unread => ({
  id: id(index),
  message,
  sent: true,
  queuedAfter: 0,
  turnStart: Option.none(),
  ...options,
});

const inbox = (...messages: ReadonlyArray<Unread>): Inbox<Unread> => ({
  unread: messages,
  own: [],
  counted: [],
  turn: Option.none(),
  saved: [],
});

/** Applies `receipts` in order at tool-call count `calls`, and returns what each one changed. */
const applied = (start: Inbox<Unread>, receipts: ReadonlyArray<Receipt>, calls = 0) =>
  receipts.reduce<{ readonly inbox: Inbox<Unread>; readonly steps: Array<Matched<Unread>> }>(
    (state, receipt) => {
      const step = match(state.inbox, receipt, calls);
      return { inbox: step.inbox, steps: [...state.steps, step] };
    },
    { inbox: start, steps: [] },
  );

/** The ID and read point of each message that `steps` read, in order. */
const reads = (steps: ReadonlyArray<Matched<Unread>>) =>
  steps.flatMap(({ read }) => read.map(({ message, at }) => [message.id, at]));

describe("receipt matching on Claude Code's decoder", () => {
  it("reads the messages that a frame names, at the frame", () => {
    const { steps, inbox: after } = applied(
      inbox(unread(1, "Check the diff"), unread(2, "Check the tests")),
      claudeReceipts({
        message: { type: "user", user_message_uuids: [id(2)] },
        betweenTurns: false,
      }),
    );
    assert.deepStrictEqual(reads(steps), [[id(2), "now"]]);
    assert.deepStrictEqual(
      after.unread.map(({ id }) => id),
      [id(1)],
    );
  });

  it("folds in a message that the first frame of a turn doesn't name", () => {
    const { steps, inbox: after } = applied(
      inbox(
        unread(1, "Start with this", { turnStart: Option.some(2) }),
        unread(2, "Then this", { turnStart: Option.some(2) }),
      ),
      claudeReceipts({
        message: { type: "assistant", user_message_uuids: [id(1)] },
        betweenTurns: true,
      }),
    );
    assert.deepStrictEqual(reads(steps), [[id(1), "now"]]);
    assert.strictEqual(steps[0]?.folded, 1);
    assert.deepStrictEqual(
      after.unread.map(({ turnStart }) => turnStart),
      [Option.none()],
    );
  });

  it("reads a result's messages where their turn started or where the turn folded them in", () => {
    const { steps } = applied(
      inbox(unread(1, "Started a turn", { turnStart: Option.some(3) }), unread(2, "Folded in")),
      claudeReceipts({
        message: {
          type: "result",
          subtype: "success",
          result: "Done",
          user_message_uuids: [id(1), id(2)],
        },
        betweenTurns: false,
      }),
    );
    assert.deepStrictEqual(reads(steps), [
      [id(1), 3],
      [id(2), "turn"],
    ]);
  });

  it("counts a result's queued turns without names, and starts a turn with each of them", () => {
    const { steps, inbox: after } = applied(
      inbox(
        unread(1, "Read in this turn"),
        unread(2, "Queued as a turn"),
        unread(3, "Restored, not sent", { sent: false }),
      ),
      claudeReceipts({
        message: { type: "result", subtype: "success", result: "Done", queued_turn_count: 1 },
        betweenTurns: false,
      }),
      5,
    );
    assert.deepStrictEqual(reads(steps), [[id(1), "turn"]]);
    assert.deepStrictEqual(
      after.unread.map(({ id, turnStart }) => [id, turnStart]),
      [
        [id(2), Option.some(5)],
        [id(3), Option.none()],
      ],
    );
  });

  it("counts nothing on a failed result", () => {
    assert.deepStrictEqual(
      claudeReceipts({
        message: { type: "result", subtype: "error_during_execution", queued_turn_count: 0 },
        betweenTurns: false,
      }),
      [],
    );
  });
});

const userMessage = (item: string, text: string): typeof UserMessageItem.Type => ({
  type: "userMessage",
  id: item,
  content: [{ type: "text", text, text_elements: [] }],
});

describe("receipt matching on Codex's decoder", () => {
  it("reads the oldest sent message with a recorded item's text, once per item", () => {
    const recorded = codexReceipts({
      _tag: "Recorded",
      item: userMessage("item-1", "Check the diff"),
      turn: "turn-1",
    });
    const { steps, inbox: after } = applied(
      inbox(
        unread(1, "Check the diff", { sent: false }),
        unread(2, "Check the diff"),
        unread(3, "Check the diff"),
      ),
      [...recorded, ...recorded],
    );
    assert.deepStrictEqual(reads(steps), [[id(2), "now"]]);
    assert.deepStrictEqual(
      steps.map(({ save }) => save),
      [Option.some(["item-1"]), Option.none()],
    );
    assert.deepStrictEqual(
      steps.map(({ repeated }) => repeated),
      [Option.none(), Option.some({ id: "item-1", turn: "turn-1" })],
    );
    assert.deepStrictEqual(
      after.unread.map(({ id }) => id),
      [id(1), id(3)],
    );
  });

  it("reads no message at the record of the session's own input with the same text", () => {
    const { steps, inbox: after } = applied(
      { ...inbox(unread(1, "The task")), own: ["The task"] },
      [
        ...codexReceipts({
          _tag: "Recorded",
          item: userMessage("task", "The task"),
          turn: "turn-1",
        }),
        ...codexReceipts({
          _tag: "Recorded",
          item: userMessage("item-1", "The task"),
          turn: "turn-1",
        }),
      ],
    );
    assert.deepStrictEqual(
      steps.map(({ own }) => own),
      [Option.some({ item: Option.some({ id: "task", turn: "turn-1" }) }), Option.none()],
    );
    assert.deepStrictEqual(reads(steps), [[id(1), "now"]]);
    assert.deepStrictEqual(steps[0]?.save, Option.some(["task"]));
    assert.deepStrictEqual(after.own, []);
  });

  it("reads restored messages that a restored turn's items record, saving each item", () => {
    const { steps } = applied(
      inbox(unread(1, "Check the diff", { sent: false })),
      codexReceipts({
        _tag: "Restored",
        turn: "turn-1",
        items: [userMessage("task", "The task"), userMessage("item-1", "Check the diff")],
        known: true,
      }),
    );
    assert.deepStrictEqual(reads(steps), [[id(1), "restored"]]);
    assert.deepStrictEqual(
      steps.map(({ save }) => save),
      [Option.some(["task"]), Option.some(["task", "item-1"])],
    );
  });

  it("keeps the session's own inputs for its live records at a restored record", () => {
    const { steps, inbox: after } = applied(
      { ...inbox(unread(1, "Continue", { sent: false })), own: ["Continue"] },
      codexReceipts({
        _tag: "Restored",
        turn: "turn-1",
        items: [userMessage("item-1", "Continue")],
        known: true,
      }),
    );
    assert.deepStrictEqual(reads(steps), [[id(1), "restored"]]);
    assert.deepStrictEqual(after.own, ["Continue"]);
  });

  it("counts a restored turn's items without reading when the session saved none before", () => {
    const { steps, inbox: after } = applied(inbox(unread(1, "Check the diff", { sent: false })), [
      ...codexReceipts({
        _tag: "Restored",
        turn: "turn-1",
        items: [userMessage("item-1", "Check the diff")],
        known: false,
      }),
      ...codexReceipts({
        _tag: "Recorded",
        item: userMessage("item-1", "Check the diff"),
        turn: "turn-1",
      }),
    ]);
    assert.deepStrictEqual(reads(steps), []);
    assert.deepStrictEqual(steps[0]?.save, Option.some(["item-1"]));
    assert.isTrue(Option.isSome(steps[1]?.repeated ?? Option.none()));
    assert.deepStrictEqual(after.counted, ["item-1"]);
  });
});

describe("receipt matching on Pi's decoder", () => {
  it("reads the sent message whose text starts, at the tool-call count of its start", () => {
    const { steps } = applied(
      inbox(unread(1, "Run the tests.", { sent: false }), unread(2, "Run the tests.")),
      piReceipts({
        message: { role: "user", content: "Run the tests.", timestamp: 0 },
        toolCalls: 4,
      }),
    );
    assert.deepStrictEqual(reads(steps), [[id(2), 4]]);
  });

  it("reads no message at the start of the session's own input with the same text", () => {
    const start = piReceipts({
      message: { role: "user", content: "The task", timestamp: 0 },
      toolCalls: 0,
    });
    const { steps } = applied({ ...inbox(unread(1, "The task")), own: ["The task"] }, [
      ...start,
      ...start,
    ]);
    assert.deepStrictEqual(reads(steps), [[id(1), 0]]);
  });

  it("reads nothing at an assistant message", () => {
    assert.deepStrictEqual(
      piReceipts({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Run the tests." }],
          api: "openai-responses",
          provider: "openai",
          model: "gpt",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 0,
        },
        toolCalls: 0,
      }),
      [],
    );
  });
});

describe("a harness adapter that supplies only a receipt decoder", () => {
  const session = ChildSession.make({
    id: AgentSessionId.make("decoder-only"),
    parentId: AgentSessionId.make("parent"),
    agent: AgentName.make("developer"),
    brain: BrainSpec.make({
      harness: Harness.make("pi"),
      model: ModelId.make("openai/model"),
      effort: "medium",
    }),
  });

  /** What the test harness reports: it echoes each input it reads as a numbered record. */
  interface Echo {
    readonly record: string;
    readonly text: string;
  }

  it.effect("gets the read, its delivery and receipts, and the answer to the operator", () =>
    Effect.gen(function* () {
      const saved: Array<ReadonlyArray<string>> = [];
      const delivered: Array<string> = [];
      const restored = Steer.make({ message: "Check the lockfile." });
      const policy: ContinuationPolicy = {
        restored: RestartState.make({
          unread: [{ id: restored.id, message: restored.message }],
        }),
        journal: ChildSessionJournal.of({
          started: () => Effect.void,
          prompted: Effect.void,
          continued: () => Effect.void,
          received: (items) =>
            Effect.sync(() => {
              saved.push(items);
            }),
          delivered: (message, state) =>
            Effect.sync(() => {
              delivered.push(`${Option.isSome(state) ? "read" : "unread"} ${message}`);
            }),
        }),
        reopen: (native) => native,
        recover: () => Effect.void,
      };
      const channel = yield* sessionChannel({ sessionId: session.id, label: "Decoder test" });
      const conversation = yield* sessionConversation({
        session,
        channel,
        policy,
        submitted: [restored.id],
        decode: ({ record, text }: Echo) => [
          Receipt.ByText({
            text,
            at: "now",
            item: Option.some({ id: record, turn: "turn-1" }),
          }),
        ],
        send: () => Effect.succeed("queued"),
        pause: Effect.void,
        beforeFinish: Effect.void,
      });
      const steer = Steer.make({ message: "Run the tests." });
      const onDelivery = yield* Deferred.make<boolean>();
      const state = yield* conversation.intervene(steer, (read) =>
        Deferred.succeed(onDelivery, Option.isSome(read)).pipe(Effect.asVoid),
      );
      yield* channel.emit(
        ToolStarted.make({ session, callId: "call-1", tool: "bash", input: "pnpm test" }),
      );
      yield* channel.emit(
        ToolFinished.make({
          session,
          callId: "call-1",
          tool: "bash",
          output: "ok",
          isError: false,
        }),
      );
      yield* conversation.observe({ record: "record-1", text: restored.message });
      yield* conversation.observe({ record: "record-2", text: steer.message });
      yield* conversation.observe({ record: "record-2", text: steer.message });
      yield* conversation.finish("The tests pass.");
      const result = yield* Deferred.await(channel.result);
      const events = yield* Queue.clear(channel.events);
      const onDeliveryRead = yield* Deferred.await(onDelivery);

      assert.isTrue(state.queued);
      assert.isTrue(onDeliveryRead);
      assert.deepStrictEqual(delivered, [`read ${restored.id}`]);
      assert.deepStrictEqual(saved, [["record-1"], ["record-1", "record-2"]]);
      assert.deepStrictEqual(
        events.flatMap((event) => (event._tag === "OperatorMessageRead" ? [event.messageId] : [])),
        [restored.id, steer.id],
      );
      assert.isTrue(result.answeredOperator);
    }).pipe(Effect.scoped),
  );
});
