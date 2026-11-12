import { assert, describe, it } from "@effect/vitest";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import {
  AssistantEntry,
  type ConversationId,
  type EntryId,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import { Option } from "effect";
import { failedAssistantTimestamp } from "../src/attempt/events.ts";

const limit = "You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.";
const overload = '503 {"error":{"type":"overloaded_error","message":"Overloaded"}}';

let id = 0;
const assistant = (
  message: ReturnType<typeof fauxAssistantMessage>,
  kind: string = AssistantEntry.kind,
): EntryRecord => ({
  // SAFETY: `failedAssistantTimestamp` reads only each entry's kind and model message.
  id: ++id as EntryId,
  // SAFETY: as above, the conversation ID is never read.
  conversationId: 1 as ConversationId,
  kind,
  model: [message],
});
const failed = (errorMessage: string, timestamp: number) =>
  assistant(fauxAssistantMessage([], { stopReason: "error", errorMessage, timestamp }));

describe("failedAssistantTimestamp", () => {
  it("returns the newest entry that failed with the settled error", () => {
    const entries = [failed(limit, 1_000), failed(limit, 2_000), failed(overload, 3_000)];
    assert.deepStrictEqual(failedAssistantTimestamp(entries, limit), Option.some(2_000));
  });

  it("returns None when no entry failed with the settled error", () => {
    const entries = [
      failed(overload, 1_000),
      assistant(fauxAssistantMessage([fauxText(limit)], { timestamp: 2_000 })),
      assistant(
        fauxAssistantMessage([], { stopReason: "error", errorMessage: limit, timestamp: 3_000 }),
        "usine.note",
      ),
    ];
    assert.deepStrictEqual(failedAssistantTimestamp(entries, limit), Option.none());
  });
});
