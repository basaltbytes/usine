import {
  AssistantEntry,
  type EntryRecord,
  ToolResultEntry,
  type UsageState,
} from "@earendil-works/pi-durable";
import {
  type AgentSession,
  type AgentSessionEvent,
  TextOutput,
  TokenCount,
  ToolFinished,
  ToolStarted,
} from "@usine/core/agent/session";
import { Option, Schema } from "effect";

const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const ToolCallBlock = Schema.Struct({
  type: Schema.Literal("toolCall"),
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  arguments: Schema.Json,
});
const AssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Array(Schema.Json),
});
const ToolResultMessage = Schema.Struct({
  role: Schema.Literal("toolResult"),
  toolCallId: Schema.NonEmptyString,
  toolName: Schema.NonEmptyString,
  content: Schema.Json,
  details: Schema.optionalKey(Schema.Json),
  isError: Schema.Boolean,
});
const decodeAssistant = Schema.decodeUnknownOption(AssistantMessage);
const decodeToolResult = Schema.decodeUnknownOption(ToolResultMessage);
const isTextBlock = Schema.is(TextBlock);
const isToolCallBlock = Schema.is(ToolCallBlock);

/** The trimmed text of an assistant entry, when it has any. */
export const assistantText = (entry: EntryRecord): Option.Option<string> =>
  Option.flatMap(decodeAssistant(entry.model?.[0]), (message) => {
    const text = message.content
      .filter(isTextBlock)
      .map(({ text }) => text)
      .join("")
      .trim();
    return text.length > 0 ? Option.some(text) : Option.none();
  });

/**
 * The session events one committed parent entry stands for, in the order the
 * Pi SDK emitted them: an assistant entry's text, then one start per tool
 * call; a tool result's output. Other entries (user input, prompt changes,
 * compaction summaries) are not session events.
 */
export const entryEvents = (
  entry: EntryRecord,
  session: AgentSession,
): ReadonlyArray<AgentSessionEvent> => {
  if (entry.kind === AssistantEntry.kind) {
    return Option.match(decodeAssistant(entry.model?.[0]), {
      onNone: () => [],
      onSome: (message) => {
        const events: Array<AgentSessionEvent> = [];
        const text = assistantText(entry);
        if (Option.isSome(text)) events.push(new TextOutput({ session, text: text.value }));
        for (const block of message.content.filter(isToolCallBlock)) {
          events.push(
            new ToolStarted({
              session,
              callId: block.id,
              tool: block.name,
              input: block.arguments,
            }),
          );
        }
        return events;
      },
    });
  }
  if (entry.kind === ToolResultEntry.kind) {
    return Option.match(decodeToolResult(entry.model?.[0]), {
      onNone: () => [],
      onSome: (result) => {
        const output =
          result.details === undefined
            ? { content: result.content }
            : { content: result.content, details: result.details };
        return [
          new ToolFinished({
            session,
            callId: result.toolCallId,
            tool: result.toolName,
            output,
            isError: result.isError,
          }),
        ];
      },
    });
  }
  return [];
};

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const UsageLedger = Schema.Struct({
  models: Schema.Record(
    Schema.String,
    Schema.Struct({ input: Count, output: Count, cacheWrite: Count }),
  ),
});
const decodeUsage = Schema.decodeUnknownOption(UsageLedger);

/**
 * A conversation's consumption from its `pi.usage` ledger: output plus uncached
 * input, where a cache write is new context and a cache read is not, summed
 * over every model it called.
 */
export const usageTokens = (usage: Readonly<UsageState> | undefined): TokenCount =>
  TokenCount.make(
    Option.match(decodeUsage(usage), {
      onNone: () => 0,
      onSome: ({ models }) =>
        Object.values(models).reduce(
          (total, model) => total + model.output + model.input + model.cacheWrite,
          0,
        ),
    }),
  );
