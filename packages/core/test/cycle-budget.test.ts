import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { CycleBudgetAsk, CycleLimit, LoopCycleCount } from "../src/cycle-budget.ts";

describe("cycle budget boundaries", () => {
  it("rejects impossible counts and inconsistent or unknown Ask fields", () => {
    const count = { loop: "review", admitted: 3, completed: 3 };
    const ask = {
      id: "ask-1",
      itemKey: "item-1",
      repository: "acme/demo",
      loop: "review",
      limit: 3,
      counts: [count],
    };
    const legacy = Effect.runSync(Schema.decodeUnknownEffect(CycleBudgetAsk)(ask));
    assert.strictEqual(legacy.completedCycles, 3);
    assert.strictEqual(legacy.blockedLoop, "review");
    assert.deepStrictEqual(legacy.blocks, []);
    for (const invalid of [0, -1, 1.5])
      assert.throws(() => Effect.runSync(Schema.decodeEffect(CycleLimit)(invalid)));
    for (const invalid of [
      { ...count, completed: 4 },
      { ...count, extra: true },
    ]) {
      assert.throws(() => Effect.runSync(Schema.decodeEffect(LoopCycleCount)(invalid)));
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
      assert.throws(() => Effect.runSync(Schema.decodeUnknownEffect(CycleBudgetAsk)(invalid)));
    }
  });
});
