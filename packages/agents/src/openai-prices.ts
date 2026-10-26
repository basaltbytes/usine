import { type TokenBreakdown, UsdAmount } from "@usine/core/agent/session";
import { Option } from "effect";

/** OpenAI's rates for one model, in US dollars per million tokens. */
interface OpenAiRates {
  readonly input: number;
  readonly cachedInput: number;
  /** Absent if the model bills cache writes at the input rate. */
  readonly cacheWrite?: number;
  readonly output: number;
}

// Standard tier, short context (up to 272K input tokens, the Codex context window), read from
// https://developers.openai.com/api/docs/pricing on 2026-10-26. `cacheWrite` is the 30-minute write
// rate, which applies when a request sets no cache retention, as Codex does.
const RATES: ReadonlyMap<string, OpenAiRates> = new Map([
  ["gpt-6-astra", { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 }],
  ["gpt-6.1-sol", { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 }],
  ["gpt-6-sol", { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 }],
  ["gpt-6-luna", { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 }],
  ["gpt-5.6-sol", { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20 }],
  ["gpt-5.6-terra", { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 12 }],
  ["gpt-5.6-luna", { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 1.2 }],
  ["gpt-5.5", { input: 5, cachedInput: 0.5, output: 30 }],
  ["gpt-5.4", { input: 2.5, cachedInput: 0.25, output: 15 }],
  ["gpt-5.4-mini", { input: 0.75, cachedInput: 0.075, output: 4.5 }],
  ["gpt-5.2", { input: 1.75, cachedInput: 0.175, output: 14 }],
]);

/**
 * Returns the price of `tokens` at OpenAI's rates for `model`, a model ID as the Codex app-server
 * reports it, or `None` if the table has no rates for the model.
 */
export const openAiPrice = (model: string, tokens: TokenBreakdown): Option.Option<UsdAmount> =>
  Option.map(Option.fromNullishOr(RATES.get(model)), (rates) =>
    UsdAmount.make(
      (tokens.input * rates.input +
        tokens.cachedInput * rates.cachedInput +
        tokens.cacheWrite * (rates.cacheWrite ?? rates.input) +
        tokens.output * rates.output) /
        1_000_000,
    ),
  );
