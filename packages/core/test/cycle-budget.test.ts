import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { CycleBudgetAsk, CycleLimit, LoopCycleCount } from "../src/cycle-budget.ts";

describe("cycle budget boundaries", () => {
  it.effect("rejects impossible counts and inconsistent or unknown Ask fields", () =>
    Effect.gen(function* () {
      const count = { loop: "review", admitted: 3, completed: 3 };
      const ask = {
        id: "ask-1",
        itemKey: "item-1",
        repository: "acme/demo",
        loop: "review",
        limit: 3,
        counts: [count],
      };
      const legacy = yield* Schema.decodeUnknownEffect(CycleBudgetAsk)(ask);
      assert.strictEqual(legacy.completedCycles, 3);
      assert.strictEqual(legacy.blockedLoop, "review");
      assert.deepStrictEqual(legacy.blocks, []);
      for (const invalid of [0, -1, 1.5])
        assert.strictEqual(
          (yield* Effect.flip(Schema.decodeEffect(CycleLimit)(invalid)))._tag,
          "SchemaError",
        );
      for (const invalid of [
        { ...count, completed: 4 },
        { ...count, extra: true },
      ]) {
        assert.strictEqual(
          (yield* Effect.flip(Schema.decodeEffect(LoopCycleCount)(invalid)))._tag,
          "SchemaError",
        );
      }
      for (const invalid of [
        { ...ask, counts: [] },
        { ...ask, counts: [count, count] },
        { ...ask, loop: "fix" },
        { ...ask, limit: 4 },
        {
          ...ask,
          blocks: [
            { loop: "fix", eventId: "event-1" },
            { loop: "fix", eventId: "event-2" },
          ],
        },
        { ...ask, blocks: [{ loop: "fix", eventId: 1 }] },
        { ...ask, extra: true },
      ]) {
        assert.strictEqual(
          (yield* Effect.flip(Schema.decodeUnknownEffect(CycleBudgetAsk)(invalid)))._tag,
          "SchemaError",
        );
      }
    }),
  );
});
