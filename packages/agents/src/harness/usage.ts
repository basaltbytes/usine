import { TokenBreakdown, TokenCount, UsdAmount } from "@usine/core/agent/session";
import { flow, Option, Schema } from "effect";
import type { CodexTokenUsage } from "../protocol/codex.ts";
import { UsageCount } from "../protocol/count.ts";

const Dollars = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const PiUsage = Schema.Struct({
  role: Schema.Literal("assistant"),
  usage: Schema.Struct({
    input: UsageCount,
    output: UsageCount,
    cacheWrite: UsageCount,
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
  parent_tool_use_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  message: Schema.Struct({
    id: Schema.NonEmptyString,
    usage: Schema.Struct({
      input_tokens: UsageCount,
      output_tokens: UsageCount,
      cache_creation_input_tokens: Schema.optionalKey(Schema.NullOr(UsageCount)),
    }),
  }),
});
const ClaudeModelUsage = Schema.Struct({
  inputTokens: UsageCount,
  outputTokens: UsageCount,
  cacheCreationInputTokens: UsageCount,
  costUSD: Schema.optionalKey(Dollars),
});
const ClaudeResultUsage = Schema.Struct({
  type: Schema.Literal("result"),
  modelUsage: Schema.Record(Schema.String, ClaudeModelUsage),
});
const decodeAssistant = Schema.decodeUnknownOption(ClaudeAssistantUsage);
const decodeResult = Schema.decodeUnknownOption(ClaudeResultUsage);

/** A Claude process's cumulative usage. */
export interface ProcessUsage extends SessionUsage {
  /** Tokens counted per assistant message ID that can recur or remain uncheckpointed. */
  readonly messages?: Readonly<Record<string, TokenCount>>;
}

/**
 * Returns a Claude token meter: live message usage between results, reconciled with the cumulative
 * `modelUsage` at each result. Consumption is output plus input plus cache creation, because the
 * SDK's input counts exclude cache reads and writes; repeated blocks with one message ID count only
 * their added tokens, including blocks replayed after the `seed` was saved. The cost is the SDK's
 * `costUSD` estimate and changes only at a result. `covered` reports that the output checkpoint
 * covers every message read so far. Superseded message IDs are then omitted from saved usage;
 * the latest ID per parent tool remains until a later message in that stream or the turn result.
 */
export const claudeTokenMeter = (seed: ProcessUsage = NO_USAGE) => {
  let total: number = seed.totalTokens;
  let cost = seed.costUsd;
  const replayable = new Map(Object.entries(seed.messages ?? {}));
  const messages = new Map<string, number>(replayable);
  const active = new Map<string | null, string>();
  const superseded = new Set<string>();
  const usage = (): ProcessUsage => {
    const counted = { totalTokens: TokenCount.make(total), costUsd: cost };
    if (replayable.size === 0) return counted;
    return { ...counted, messages: Object.fromEntries(replayable) };
  };
  return {
    read: (message: Schema.Json): Option.Option<ProcessUsage> => {
      const assistant = decodeAssistant(message);
      if (Option.isSome(assistant)) {
        const { id, usage: tokens } = assistant.value.message;
        const parent = assistant.value.parent_tool_use_id ?? null;
        const previousId = active.get(parent);
        if (previousId !== undefined && previousId !== id) superseded.add(previousId);
        active.set(parent, id);
        const consumed =
          tokens.output_tokens + tokens.input_tokens + (tokens.cache_creation_input_tokens ?? 0);
        const previous = messages.get(id) ?? 0;
        total += Math.max(0, consumed - previous);
        messages.set(id, Math.max(previous, consumed));
        replayable.set(id, TokenCount.make(Math.max(previous, consumed)));
        return Option.some(usage());
      }
      const result = decodeResult(message);
      if (Option.isNone(result)) return Option.none();
      for (const id of replayable.keys()) superseded.add(id);
      active.clear();
      const models = Object.values(result.value.modelUsage);
      const consumed = models.reduce(
        (sum, model) =>
          sum + model.outputTokens + model.inputTokens + model.cacheCreationInputTokens,
        0,
      );
      total = Math.max(total, consumed);
      const priced = models.flatMap(({ costUSD }) => (costUSD === undefined ? [] : [costUSD]));
      if (priced.length > 0)
        cost = Option.some(UsdAmount.make(priced.reduce((sum, value) => sum + value, 0)));
      return Option.some(usage());
    },
    covered: () => {
      for (const id of superseded) replayable.delete(id);
      superseded.clear();
    },
  };
};

const NO_USAGE: SessionUsage = { totalTokens: TokenCount.make(0), costUsd: Option.none() };

/**
 * Returns a Claude token meter for a session that another process can resume. `read` returns the
 * session's usage: the current process's, as `claudeTokenMeter` reads it, plus the earlier
 * processes'. `restart` starts on a new process and returns the usage checkpoint to persist.
 * `covered` works as in `claudeTokenMeter`.
 */
export const claudeSessionMeter = (
  seed: SessionUsage & { readonly processUsage?: Option.Option<ProcessUsage> } = NO_USAGE,
  retained = false,
) => {
  let current: ProcessUsage = retained
    ? Option.getOrElse(seed.processUsage ?? Option.none(), () => seed)
    : NO_USAGE;
  let earlier: SessionUsage = {
    totalTokens: TokenCount.make(Math.max(0, seed.totalTokens - current.totalTokens)),
    costUsd: Option.map(seed.costUsd, (cost) =>
      UsdAmount.make(Math.max(0, cost - Option.getOrElse(current.costUsd, () => 0))),
    ),
  };
  let meter = claudeTokenMeter(current);
  return {
    read: (
      message: Schema.Json,
    ): Option.Option<SessionUsage & { readonly processUsage: Option.Option<ProcessUsage> }> =>
      Option.map(meter.read(message), (usage) => {
        current = usage;
        return { ...addUsage(earlier, usage), processUsage: Option.some(usage) };
      }),
    restart: () => {
      earlier = addUsage(earlier, current);
      current = NO_USAGE;
      meter = claudeTokenMeter();
      return { ...earlier, processUsage: Option.some(current) };
    },
    covered: () => meter.covered(),
  };
};

/**
 * Returns a Codex thread's consumption: output plus uncached input. The thread's `totalTokens` counts
 * the whole context on every turn, so it is not used.
 */
export const codexThreadTokens = (total: CodexTokenUsage["tokenUsage"]["total"]): TokenCount =>
  TokenCount.make(total.outputTokens + Math.max(0, total.inputTokens - total.cachedInputTokens));

/** Returns a Codex thread's tokens per billing rate. */
export const codexTokenBreakdown = (total: CodexTokenUsage["tokenUsage"]["total"]) =>
  TokenBreakdown.make({
    input: Math.max(0, total.inputTokens - total.cachedInputTokens - total.cacheWriteInputTokens),
    cachedInput: total.cachedInputTokens,
    cacheWrite: total.cacheWriteInputTokens,
    output: total.outputTokens,
  });
