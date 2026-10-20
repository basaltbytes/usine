import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import { ledgerUsage } from "../src/attempt/events.ts";

const usage = (input: number, output: number, total: number) => ({
  input,
  output,
  cacheRead: 9_000,
  cacheWrite: 5,
  totalTokens: input + output + 9_005,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

describe("Parent usage ledger", () => {
  it("sums tokens and the dollars Pi recorded over every model the parent called", () => {
    const ledger = ledgerUsage({
      models: { "openai/gpt-5": usage(100, 20, 0.5), "openai/gpt-5-mini": usage(10, 2, 0.25) },
      tools: {},
    });
    assert.strictEqual(ledger.totalTokens, 142);
    assert.deepStrictEqual(ledger.costUsd, Option.some(0.75));
  });

  it("has no tokens and no price for a parent that called no model", () => {
    for (const empty of [undefined, { models: {}, tools: {} }]) {
      const ledger = ledgerUsage(empty);
      assert.strictEqual(ledger.totalTokens, 0);
      assert(Option.isNone(ledger.costUsd));
    }
  });
});
