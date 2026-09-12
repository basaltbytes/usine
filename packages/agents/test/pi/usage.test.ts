import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import { claudeTokenMeter } from "../../src/pi/usage.ts";

describe("Claude query tokens", () => {
  it("reconciles repeated message blocks and cumulative results across operator turns", () => {
    const read = claudeTokenMeter();
    const assistant = (id: string, output: number) =>
      read({
        type: "assistant",
        message: {
          id,
          usage: {
            input_tokens: 10,
            output_tokens: output,
            cache_read_input_tokens: 20,
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
            cacheReadInputTokens: 20,
            cacheCreationInputTokens: 5,
          },
        },
      });
    assert.strictEqual(Option.getOrThrow(assistant("one", 5)), 40);
    assert.strictEqual(Option.getOrThrow(assistant("one", 10)), 45);
    assert.strictEqual(Option.getOrThrow(result(20, 10)), 55);
    assert.strictEqual(Option.getOrThrow(result(20, 10)), 55);
    assert.strictEqual(Option.getOrThrow(assistant("two", 5)), 95);
    assert.strictEqual(Option.getOrThrow(result(50, 30)), 105);
    assert(Option.isNone(read({ type: "result", modelUsage: { model: { inputTokens: -1 } } })));
  });
});
