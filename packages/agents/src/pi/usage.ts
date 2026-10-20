import { TokenCount, UsdAmount } from "@usine/core/agent/session";
import { flow, Option, Schema } from "effect";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Dollars = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const PiUsage = Schema.Struct({
  role: Schema.Literal("assistant"),
  usage: Schema.Struct({
    input: Count,
    output: Count,
    cacheWrite: Count,
    cost: Schema.optionalKey(Schema.Struct({ total: Dollars })),
  }),
});

/** What a session used: its `TokenCount` and the dollars its harness priced that at, when it does. */
export interface SessionUsage {
  readonly totalTokens: TokenCount;
  readonly costUsd: Option.Option<UsdAmount>;
}

/**
 * Pi reports usage per completed assistant message with cache reads and writes
 * split out. The message's consumption is its output plus uncached input, where
 * a cache write is new context and a cache read is not. Its price is the
 * dollar total Pi computed from its model catalog, when it reports one.
 */
export const piMessageUsage = flow(
  Schema.decodeUnknownOption(PiUsage),
  Option.map(({ usage }): SessionUsage => ({
    totalTokens: TokenCount.make(usage.output + usage.input + usage.cacheWrite),
    costUsd: Option.map(Option.fromNullishOr(usage.cost), ({ total }) => UsdAmount.make(total)),
  })),
);

/** Adds one message's usage to a session's running total; a price counts once any message has one. */
export const addUsage = (total: SessionUsage, message: SessionUsage): SessionUsage => ({
  totalTokens: TokenCount.make(total.totalTokens + message.totalTokens),
  costUsd: Option.isNone(message.costUsd)
    ? total.costUsd
    : Option.some(UsdAmount.make(Option.getOrElse(total.costUsd, () => 0) + message.costUsd.value)),
});

const ClaudeAssistantUsage = Schema.Struct({
  type: Schema.Literal("assistant"),
  message: Schema.Struct({
    id: Schema.NonEmptyString,
    usage: Schema.Struct({
      input_tokens: Count,
      output_tokens: Count,
      cache_creation_input_tokens: Schema.optionalKey(Schema.NullOr(Count)),
    }),
  }),
});
const ClaudeModelUsage = Schema.Struct({
  inputTokens: Count,
  outputTokens: Count,
  cacheCreationInputTokens: Count,
  costUSD: Schema.optionalKey(Dollars),
});
const ClaudeResultUsage = Schema.Struct({
  type: Schema.Literal("result"),
  modelUsage: Schema.Record(Schema.String, ClaudeModelUsage),
});
const decodeAssistant = Schema.decodeUnknownOption(ClaudeAssistantUsage);
const decodeResult = Schema.decodeUnknownOption(ClaudeResultUsage);

/**
 * Tracks Claude's live message usage and reconciles its cumulative query meter at each result.
 * The Agent SDK's `input_tokens` and `inputTokens` already exclude cache reads and
 * cache writes, so consumption is output plus input plus cache creation.
 * Repeated blocks with the same message id count only their additional tokens.
 * The SDK's result.usage is per-turn and excludes auxiliary work; modelUsage
 * includes that work and stays cumulative across streaming-input turns. Its
 * `costUSD` is the SDK's estimate from its bundled prices, so the price only
 * changes at a result and carries over between them.
 */
export const claudeTokenMeter = () => {
  let total = 0;
  let cost = Option.none<UsdAmount>();
  const messages = new Map<string, number>();
  return (message: Schema.Json): Option.Option<SessionUsage> => {
    const assistant = decodeAssistant(message);
    if (Option.isSome(assistant)) {
      const { id, usage } = assistant.value.message;
      const consumed =
        usage.output_tokens + usage.input_tokens + (usage.cache_creation_input_tokens ?? 0);
      const previous = messages.get(id) ?? 0;
      total += Math.max(0, consumed - previous);
      messages.set(id, Math.max(previous, consumed));
      return Option.some({ totalTokens: TokenCount.make(total), costUsd: cost });
    }
    const result = decodeResult(message);
    if (Option.isNone(result)) return Option.none();
    const models = Object.values(result.value.modelUsage);
    const consumed = models.reduce(
      (sum, usage) => sum + usage.outputTokens + usage.inputTokens + usage.cacheCreationInputTokens,
      0,
    );
    total = Math.max(total, consumed);
    const priced = models.flatMap(({ costUSD }) => (costUSD === undefined ? [] : [costUSD]));
    if (priced.length > 0)
      cost = Option.some(UsdAmount.make(priced.reduce((sum, value) => sum + value, 0)));
    return Option.some({ totalTokens: TokenCount.make(total), costUsd: cost });
  };
};

/** Codex's thread meter is cumulative across turns; `inputTokens` includes the cached portion. */
export const CodexTokenUsage = Schema.Struct({
  threadId: Schema.NonEmptyString,
  tokenUsage: Schema.Struct({
    total: Schema.Struct({ inputTokens: Count, cachedInputTokens: Count, outputTokens: Count }),
  }),
});
export type CodexTokenUsage = typeof CodexTokenUsage.Type;

/**
 * A Codex thread's cumulative consumption: output plus uncached input. The
 * thread's `totalTokens` re-counts the whole context on every turn, cached or
 * not, so it measures conversation length rather than work.
 */
export const codexThreadTokens = (total: CodexTokenUsage["tokenUsage"]["total"]): TokenCount =>
  TokenCount.make(total.outputTokens + Math.max(0, total.inputTokens - total.cachedInputTokens));
