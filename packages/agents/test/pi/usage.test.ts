import { assert, describe, it } from "@effect/vitest";
import { TokenBreakdown, TokenCount, UsdAmount } from "@usine/core/agent/session";
import { Effect, Option, Schema } from "effect";
import {
  addUsage,
  claudeTokenMeter,
  claudeSessionMeter,
  codexThreadTokens,
  codexTokenBreakdown,
  piMessageUsage,
  type SessionReading,
} from "../../src/harness/usage.ts";
import { CodexTokenUsage } from "../../src/protocol/codex/codex.ts";

/** The session usage of a Claude session meter's reading. */
const sessionUsage = (reading: Option.Option<SessionReading>) => Option.getOrThrow(reading).usage;

describe("Claude query tokens", () => {
  it("restores a retained process's usage separately from earlier processes", () => {
    const result = (input: number, cost: number) => ({
      type: "result",
      modelUsage: {
        model: { inputTokens: input, outputTokens: 0, cacheCreationInputTokens: 0, costUSD: cost },
      },
    });
    const first = claudeSessionMeter();
    first.read(result(100, 1));
    first.restart();
    const saved = sessionUsage(first.read(result(20, 0.2)));
    const retained = claudeSessionMeter(saved, true);
    const updated = sessionUsage(retained.read(result(30, 0.3)));
    assert.strictEqual(updated.totalTokens, 130);
    assert.deepStrictEqual(updated.costUsd, Option.some(1.3));
    retained.restart();
    assert.strictEqual(sessionUsage(retained.read(result(5, 0.1))).totalTokens, 135);
    const replacement = claudeSessionMeter(saved, false);
    assert.strictEqual(sessionUsage(replacement.read(result(5, 0.1))).totalTokens, 125);
    const legacy = claudeSessionMeter(
      { totalTokens: TokenCount.make(100), costUsd: Option.some(UsdAmount.make(1)) },
      true,
    );
    assert.strictEqual(sessionUsage(legacy.read(result(110, 1.1))).totalTokens, 110);
  });

  describe("usage that Claude restores on resume, in the recorded supervisor proportions", () => {
    const models = (input: number, output: number, cost: number) => ({
      "claude-haiku-4-5": {
        inputTokens: input,
        outputTokens: output,
        cacheCreationInputTokens: 0,
        costUSD: cost,
      },
    });
    /** A result whose `modelUsage` counts `total`, of which this process spent `own`. */
    const result = (total: ReturnType<typeof models>, own = total) => ({
      type: "result",
      modelUsage: total,
      model_usage_since_last_result: own,
    });
    // Streamed assistant messages count the output only from the start of each message.
    const assistant = (id: string, input: number) => ({
      type: "assistant",
      message: { id, usage: { input_tokens: input, output_tokens: 1 } },
    });
    const firstTurn = result(models(3387, 204, 0.004407));
    const firstProcess = () => {
      const meter = claudeSessionMeter();
      meter.read(assistant("turn-1", 2464));
      return { meter, saved: sessionUsage(meter.read(firstTurn)) };
    };
    const restoringTurn = result(models(4853, 280, 0.006253), models(1466, 76, 0.001846));

    it("counts once the usage that a replacement process restores", () => {
      const { saved } = firstProcess();
      assert.strictEqual(saved.totalTokens, 3591);
      const replacement = claudeSessionMeter(saved, false);
      assert.strictEqual(
        sessionUsage(replacement.read(assistant("turn-2", 1466))).totalTokens,
        5058,
      );
      const reading = Option.getOrThrow(replacement.read(restoringTurn));
      assert.strictEqual(reading.usage.totalTokens, 5133);
      assert.closeTo(Option.getOrThrow(reading.usage.costUsd), 0.006253, 1e-9);
      assert.deepStrictEqual(
        Option.map(reading.restored, ({ resultTokens, processTokens, restored }) => ({
          resultTokens,
          processTokens,
          restoredTokens: restored.totalTokens,
        })),
        Option.some({
          resultTokens: TokenCount.make(5133),
          processTokens: Option.some(TokenCount.make(1542)),
          restoredTokens: TokenCount.make(3591),
        }),
      );
      const later = Option.getOrThrow(
        replacement.read(result(models(5853, 380, 0.0075), models(1000, 100, 0.00125))),
      );
      assert.strictEqual(later.usage.totalTokens, 6233);
      assert(Option.isNone(later.restored), "only a process's first result settles restored usage");
    });

    it("adds a replacement process that restored nothing, even when it writes more than the replaced usage", () => {
      const { saved } = firstProcess();
      const replacement = claudeSessionMeter(saved, false);
      replacement.read(assistant("turn-2", 1466));
      const reading = Option.getOrThrow(replacement.read(result(models(1466, 3700, 0.02))));
      assert.strictEqual(reading.usage.totalTokens, 8757);
      assert.closeTo(Option.getOrThrow(reading.usage.costUsd), 0.024407, 1e-9);
      assert.deepStrictEqual(
        Option.map(reading.restored, ({ restored }) => restored.totalTokens),
        Option.some(TokenCount.make(0)),
      );
    });

    it("counts once the usage that a process restores after a restart", () => {
      const { meter } = firstProcess();
      meter.restart();
      meter.read(assistant("turn-2", 1466));
      const reading = Option.getOrThrow(meter.read(restoringTurn));
      assert.strictEqual(reading.usage.totalTokens, 5133);
      assert.deepStrictEqual(
        Option.map(reading.restored, ({ restored }) => restored.totalTokens),
        Option.some(TokenCount.make(3591)),
      );
    });

    it("counts once the usage that a replacement restores when it is reattached before its first result", () => {
      const { saved } = firstProcess();
      const replacement = claudeSessionMeter(saved, false);
      const checkpoint = sessionUsage(replacement.read(assistant("turn-2", 1466)));
      assert.strictEqual(checkpoint.totalTokens, 5058);
      assert.deepStrictEqual(
        Option.map(checkpoint.processUsage, ({ awaitsFirstResult }) => awaitsFirstResult),
        Option.some(true),
      );
      const reattached = claudeSessionMeter(checkpoint, true);
      const reading = Option.getOrThrow(reattached.read(restoringTurn));
      assert.strictEqual(reading.usage.totalTokens, 5133);
      assert.deepStrictEqual(
        Option.map(reading.restored, ({ restored }) => restored.totalTokens),
        Option.some(TokenCount.make(3591)),
      );
      assert.deepStrictEqual(
        Option.map(reading.usage.processUsage, ({ awaitsFirstResult }) => awaitsFirstResult),
        Option.some(undefined),
        "a settled process's checkpoint doesn't settle it again",
      );
    });

    it("counts once the usage that a process restores after a restart when it is reattached", () => {
      const fromRestart = firstProcess().meter.restart();
      const reattached = claudeSessionMeter(fromRestart, true);
      const reading = Option.getOrThrow(reattached.read(restoringTurn));
      assert.strictEqual(reading.usage.totalTokens, 5133);
      assert.deepStrictEqual(
        Option.map(reading.restored, ({ restored }) => restored.totalTokens),
        Option.some(TokenCount.make(3591)),
      );

      const { meter } = firstProcess();
      meter.restart();
      const streamed = claudeSessionMeter(
        sessionUsage(meter.read(assistant("turn-2", 1466))),
        true,
      );
      assert.strictEqual(sessionUsage(streamed.read(restoringTurn)).totalTokens, 5133);
    });

    it("keeps a retained process's own usage when it more than doubles", () => {
      const { saved } = firstProcess();
      const retained = claudeSessionMeter(saved, true);
      const reading = Option.getOrThrow(
        retained.read(result(models(8000, 500, 0.01), models(4613, 296, 0.005593))),
      );
      assert.strictEqual(reading.usage.totalTokens, 8500);
      assert(Option.isNone(reading.restored));
    });

    it("counts all of a replacement's result when Claude Code reports no usage of the process alone", () => {
      const { saved } = firstProcess();
      const replacement = claudeSessionMeter(saved, false);
      const reading = Option.getOrThrow(
        replacement.read({ type: "result", modelUsage: models(1466, 76, 0.001846) }),
      );
      assert.strictEqual(reading.usage.totalTokens, 5133);
      assert.deepStrictEqual(
        Option.map(reading.restored, ({ processTokens }) => processTokens),
        Option.some(Option.none()),
      );
    });
  });

  it("does not count a retained process's replayed assistant messages again", () => {
    const assistant = (id: string, output: number) => ({
      type: "assistant",
      message: { id, usage: { input_tokens: 10, output_tokens: output } },
    });
    const first = claudeSessionMeter();
    first.read(assistant("one", 5));
    first.covered();
    first.read(assistant("two", 5));
    first.covered();
    const saved = sessionUsage(first.read(assistant("two", 5)));
    assert(Option.isSome(saved.processUsage));
    assert.deepStrictEqual(saved.processUsage.value.messages, { two: TokenCount.make(15) });
    const retained = claudeSessionMeter(saved, true);
    const replayed = retained.read(assistant("two", 5));
    assert.strictEqual(sessionUsage(replayed).totalTokens, 30);
    assert.strictEqual(sessionUsage(retained.read(assistant("two", 8))).totalTokens, 33);
    const next = retained.read(assistant("three", 1));
    assert.strictEqual(sessionUsage(next).totalTokens, 44);
    retained.read({ type: "result", modelUsage: {} });
    retained.covered();
    const result = sessionUsage(retained.read({ type: "result", modelUsage: {} }));
    assert(Option.isSome(result.processUsage));
    assert.isUndefined(result.processUsage.value.messages);
  });

  it("keeps the latest message of each parent stream when a checkpoint covers interleaved messages", () => {
    const meter = claudeTokenMeter();
    const assistant = (id: string, parent: string | null) =>
      meter.read({
        type: "assistant",
        parent_tool_use_id: parent,
        message: { id, usage: { input_tokens: 10, output_tokens: 5 } },
      });
    assistant("main-1", null);
    assistant("task-1", "tool");
    assistant("main-2", null);
    meter.covered();
    const replayed = Option.getOrThrow(assistant("main-2", null));
    assert.strictEqual(replayed.totalTokens, 45);
    assert.deepStrictEqual(replayed.messages, {
      "task-1": TokenCount.make(15),
      "main-2": TokenCount.make(15),
    });
  });

  it("keeps seeded message IDs in saved usage after a message from another stream", () => {
    const assistant = (id: string, parent: string | null, output: number) => ({
      type: "assistant",
      parent_tool_use_id: parent,
      message: { id, usage: { input_tokens: 0, output_tokens: output } },
    });
    const meter = claudeTokenMeter({
      totalTokens: TokenCount.make(100),
      costUsd: Option.none(),
      messages: { seeded: TokenCount.make(100) },
    });
    const saved = Option.getOrThrow(meter.read(assistant("other", "tool", 10)));
    assert.deepStrictEqual(saved.messages, {
      seeded: TokenCount.make(100),
      other: TokenCount.make(10),
    });
    const reattached = claudeTokenMeter(saved);
    const replayed = Option.getOrThrow(reattached.read(assistant("seeded", null, 100)));
    assert.strictEqual(replayed.totalTokens, 110);
  });

  it("counts output plus uncached input, reconciling repeated blocks and cumulative results", () => {
    const { read } = claudeTokenMeter();
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
    const { read } = claudeTokenMeter();
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
  it.effect("ignores cached input so a long conversation does not read as consumption", () =>
    Effect.gen(function* () {
      const usage = yield* Schema.decodeUnknownEffect(CodexTokenUsage)({
        threadId: "thread",
        tokenUsage: {
          total: {
            totalTokens: 2_000_400,
            inputTokens: 2_000_000,
            cachedInputTokens: 1_950_000,
            cacheWriteInputTokens: 20_000,
            outputTokens: 400,
            reasoningOutputTokens: 100,
          },
          last: { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 },
        },
      });
      assert.strictEqual(codexThreadTokens(usage.tokenUsage.total), 50_400);
      assert.strictEqual(
        codexThreadTokens({
          inputTokens: 10,
          cachedInputTokens: 30,
          cacheWriteInputTokens: 0,
          outputTokens: 7,
        }),
        7,
      );
    }),
  );

  it("splits input into cache reads, cache writes, and the rest", () => {
    assert.deepStrictEqual(
      codexTokenBreakdown({
        inputTokens: 2_000_000,
        cachedInputTokens: 1_950_000,
        cacheWriteInputTokens: 20_000,
        outputTokens: 400,
      }),
      TokenBreakdown.make({
        input: 30000,
        cachedInput: 1950000,
        cacheWrite: 20000,
        output: 400,
      }),
    );
    assert.strictEqual(
      codexTokenBreakdown({
        inputTokens: 10,
        cachedInputTokens: 30,
        cacheWriteInputTokens: 5,
        outputTokens: 7,
      }).input,
      0,
    );
    assert.deepStrictEqual(
      codexTokenBreakdown({ inputTokens: 100, cachedInputTokens: 40, outputTokens: 7 }),
      TokenBreakdown.make({ input: 60, cachedInput: 40, cacheWrite: 0, output: 7 }),
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
