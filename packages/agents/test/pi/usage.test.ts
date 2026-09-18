import { assert, describe, it } from "@effect/vitest";
import { Option, Schema } from "effect";
import {
  claudeTokenMeter,
  CodexTokenUsage,
  codexThreadTokens,
  piMessageTokens,
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
    assert.strictEqual(Option.getOrThrow(assistant("one", 5)), 20);
    assert.strictEqual(Option.getOrThrow(assistant("one", 10)), 25);
    assert.strictEqual(Option.getOrThrow(result(20, 10)), 35);
    assert.strictEqual(Option.getOrThrow(result(20, 10)), 35);
    assert.strictEqual(Option.getOrThrow(assistant("two", 5)), 55);
    assert.strictEqual(Option.getOrThrow(result(50, 30)), 85);
    assert(Option.isNone(read({ type: "result", modelUsage: { model: { inputTokens: -1 } } })));
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
    const tokens = piMessageTokens({
      role: "assistant",
      usage: { input: 100, output: 40, cacheRead: 9_000, cacheWrite: 60, totalTokens: 9_200 },
    });
    assert.strictEqual(Option.getOrThrow(tokens), 200);
    assert(Option.isNone(piMessageTokens({ role: "user", usage: { input: 1 } })));
  });
});
