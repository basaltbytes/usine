import { TokenCount, UsdAmount } from "@usine/core/agent/session";
import { flow, Option, Schema } from "effect";
import type { CodexTokenUsage } from "../protocol/codex.ts";

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

/** A session's token count and, if the harness reports one, its cost in dollars. */
export interface SessionUsage {
  readonly totalTokens: TokenCount;
  readonly costUsd: Option.Option<UsdAmount>;
}

/**
 * Returns the usage of one completed Pi assistant message: output plus uncached input, where cache
 * writes count and cache reads do not, and the dollar cost if Pi reports one.
 */
export const piMessageUsage = flow(
  Schema.decodeUnknownOption(PiUsage),
  Option.map(({ usage }): SessionUsage => ({
    totalTokens: TokenCount.make(usage.output + usage.input + usage.cacheWrite),
    costUsd: Option.map(Option.fromNullishOr(usage.cost), ({ total }) => UsdAmount.make(total)),
  })),
);

/** Adds a message's usage to a session total; the cost is `Some` once any message has a cost. */
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
 * Returns a Claude token meter: live message usage between results, reconciled with the cumulative
 * `modelUsage` at each result. Consumption is output plus input plus cache creation, because the
 * SDK's input counts exclude cache reads and writes; repeated blocks with one message ID count only
 * their added tokens. The cost is the SDK's `costUSD` estimate and changes only at a result.
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

/**
 * Returns a Codex thread's consumption: output plus uncached input. The thread's `totalTokens` counts
 * the whole context on every turn, so it is not used.
 */
export const codexThreadTokens = (total: CodexTokenUsage["tokenUsage"]["total"]): TokenCount =>
  TokenCount.make(total.outputTokens + Math.max(0, total.inputTokens - total.cachedInputTokens));
