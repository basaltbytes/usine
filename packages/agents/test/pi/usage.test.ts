import { assert, describe, it } from "@effect/vitest";
import { Option, Schema } from "effect";
import {
  addUsage,
  claudeTokenMeter,
  CodexTokenUsage,
  codexThreadTokens,
  piMessageUsage,
} from "../../src/pi/usage.ts";

describe("Claude query tokens", () => {
  it("counts output plus uncached input, reconciling repeated blocks and cumulative results", () => {
    const read = claudeTokenMeter();
    const assistant = (id: string, output: number) =>
      read({
        type: "assistant",
        message: {
          id,
          usage: {
            input_tokens: 10,
            output_tokens: output,
            cache_read_input_tokens: 20_000,
            cache_creation_input_tokens: 5,
          },
        },
      });
    const result = (input: number, output: number) =>
      read({
        type: "result",
        modelUsage: {
          model: {
            inputTokens: input,
            outputTokens: output,
            cacheReadInputTokens: 20_000,
            cacheCreationInputTokens: 5,
          },
        },
      });
    const tokens = (usage: ReturnType<typeof read>) => Option.getOrThrow(usage).totalTokens;
    assert.strictEqual(tokens(assistant("one", 5)), 20);
    assert.strictEqual(tokens(assistant("one", 10)), 25);
    assert.strictEqual(tokens(result(20, 10)), 35);
    assert.strictEqual(tokens(result(20, 10)), 35);
    assert.strictEqual(tokens(assistant("two", 5)), 55);
    assert.strictEqual(tokens(result(50, 30)), 85);
    assert(Option.isNone(read({ type: "result", modelUsage: { model: { inputTokens: -1 } } })));
  });

  it("carries the SDK's estimated price from each result until the next one", () => {
    const read = claudeTokenMeter();
    const assistant = read({
      type: "assistant",
      message: { id: "one", usage: { input_tokens: 10, output_tokens: 5 } },
    });
    assert(Option.isNone(Option.getOrThrow(assistant).costUsd));
    const priced = read({
      type: "result",
      modelUsage: {
        opus: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, costUSD: 0.5 },
        haiku: { inputTokens: 4, outputTokens: 1, cacheCreationInputTokens: 0, costUSD: 0.25 },
      },
    });
    assert.deepStrictEqual(Option.getOrThrow(priced).costUsd, Option.some(0.75));
    const next = read({
      type: "assistant",
      message: { id: "two", usage: { input_tokens: 1, output_tokens: 1 } },
    });
    assert.deepStrictEqual(Option.getOrThrow(next).costUsd, Option.some(0.75));
  });
});

describe("Codex thread tokens", () => {
  it("ignores cached input so a long conversation does not read as consumption", () => {
    const usage = Schema.decodeUnknownSync(CodexTokenUsage)({
      threadId: "thread",
      tokenUsage: {
        total: {
          totalTokens: 2_000_400,
          inputTokens: 2_000_000,
          cachedInputTokens: 1_950_000,
          outputTokens: 400,
          reasoningOutputTokens: 100,
        },
        last: { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 },
      },
    });
    assert.strictEqual(codexThreadTokens(usage.tokenUsage.total), 50_400);
    assert.strictEqual(
      codexThreadTokens({ inputTokens: 10, cachedInputTokens: 30, outputTokens: 7 }),
      7,
    );
  });
});

describe("Pi message tokens", () => {
  it("counts output, input, and cache writes per message and skips cache reads", () => {
    const usage = piMessageUsage({
      role: "assistant",
      usage: { input: 100, output: 40, cacheRead: 9_000, cacheWrite: 60, totalTokens: 9_200 },
    });
    assert.strictEqual(Option.getOrThrow(usage).totalTokens, 200);
    assert(Option.isNone(Option.getOrThrow(usage).costUsd));
    assert(Option.isNone(piMessageUsage({ role: "user", usage: { input: 1 } })));
  });

  it("sums the prices Pi reports per message, once any message has one", () => {
    const message = (total: number) =>
      Option.getOrThrow(
        piMessageUsage({
          role: "assistant",
          usage: {
            input: 10,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
          },
        }),
      );
    const unpriced = Option.getOrThrow(
      piMessageUsage({ role: "assistant", usage: { input: 1, output: 1, cacheWrite: 0 } }),
    );
    const total = [message(0.125), unpriced, message(0.25)].reduce(addUsage);
    assert.strictEqual(total.totalTokens, 42);
    assert.deepStrictEqual(total.costUsd, Option.some(0.375));
  });
});
