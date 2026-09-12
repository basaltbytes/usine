import { TokenCount } from "@usine/core/agent/session";
import { Option, Schema } from "effect";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PiUsage = Schema.Struct({
  role: Schema.Literal("assistant"),
  usage: Schema.Struct({ totalTokens: Count }),
});

/** Pi assistant usage is per completed message, including cache tokens. */
export const piMessageTokens = Schema.decodeUnknownOption(PiUsage);

const ClaudeAssistantUsage = Schema.Struct({
  type: Schema.Literal("assistant"),
  message: Schema.Struct({
    id: Schema.NonEmptyString,
    usage: Schema.Struct({
      input_tokens: Count,
      output_tokens: Count,
      cache_read_input_tokens: Schema.optionalKey(Schema.NullOr(Count)),
      cache_creation_input_tokens: Schema.optionalKey(Schema.NullOr(Count)),
    }),
  }),
});
const ClaudeModelUsage = Schema.Struct({
  inputTokens: Count,
  outputTokens: Count,
  cacheReadInputTokens: Count,
  cacheCreationInputTokens: Count,
});
const ClaudeResultUsage = Schema.Struct({
  type: Schema.Literal("result"),
  modelUsage: Schema.Record(Schema.String, ClaudeModelUsage),
});
const decodeAssistant = Schema.decodeUnknownOption(ClaudeAssistantUsage);
const decodeResult = Schema.decodeUnknownOption(ClaudeResultUsage);

/** Tracks Claude's live message usage and reconciles its cumulative query meter at each result.
 * Repeated blocks with the same message id count only their additional tokens.
 * The SDK's result.usage is per-turn and excludes auxiliary work; modelUsage
 * includes that work and stays cumulative across streaming-input turns.
 */
export const claudeTokenMeter = () => {
  let total = 0;
  const messages = new Map<string, number>();
  return (message: Schema.Json): Option.Option<TokenCount> => {
    const assistant = decodeAssistant(message);
    if (Option.isSome(assistant)) {
      const { id, usage } = assistant.value.message;
      const consumed =
        usage.input_tokens +
        usage.output_tokens +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0);
      const previous = messages.get(id) ?? 0;
      total += Math.max(0, consumed - previous);
      messages.set(id, Math.max(previous, consumed));
      return Option.some(TokenCount.make(total));
    }
    const result = decodeResult(message);
    if (Option.isNone(result)) return Option.none();
    const consumed = Object.values(result.value.modelUsage).reduce(
      (sum, usage) =>
        sum +
        usage.inputTokens +
        usage.outputTokens +
        usage.cacheReadInputTokens +
        usage.cacheCreationInputTokens,
      0,
    );
    total = Math.max(total, consumed);
    return Option.some(TokenCount.make(total));
  };
};

/** Codex's thread meter is cumulative across turns on the same thread. */
export const CodexTokenUsage = Schema.Struct({
  threadId: Schema.NonEmptyString,
  tokenUsage: Schema.Struct({ total: Schema.Struct({ totalTokens: TokenCount }) }),
});
