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
  UsdAmount,
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

/** Returns the trimmed text of an assistant entry, or `None` if it has no text. */
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
 * Returns the session events for one committed parent entry, in Pi SDK emission order. User input,
 * prompt changes, and compaction summaries produce no events.
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
const Dollars = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const UsageLedger = Schema.Struct({
  models: Schema.Record(
    Schema.String,
    Schema.Struct({
      input: Count,
      output: Count,
      cacheWrite: Count,
      cost: Schema.optionalKey(Schema.Struct({ total: Dollars })),
    }),
  ),
});
const decodeUsage = Schema.decodeUnknownOption(UsageLedger);

/** A conversation's token count and cost. `costUsd` is `None` if no model was priced. */
interface LedgerUsage {
  readonly totalTokens: TokenCount;
  readonly costUsd: Option.Option<UsdAmount>;
}

/**
 * Sums a conversation's `pi.usage` ledger over every model. Tokens are output plus uncached input,
 * where cache writes count and cache reads don't.
 */
export const ledgerUsage = (usage: Readonly<UsageState> | undefined): LedgerUsage => {
  const models = Option.match(decodeUsage(usage), {
    onNone: () => [],
    onSome: ({ models }) => Object.values(models),
  });
  const priced = models.flatMap(({ cost }) => (cost === undefined ? [] : [cost.total]));
  return {
    totalTokens: TokenCount.make(
      models.reduce((total, model) => total + model.output + model.input + model.cacheWrite, 0),
    ),
    costUsd:
      priced.length === 0
        ? Option.none()
        : Option.some(UsdAmount.make(priced.reduce((total, value) => total + value, 0))),
  };
};
