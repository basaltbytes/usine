import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
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
    assert.strictEqual(Schema.decodeUnknownSync(CycleBudgetAsk)(ask).completedCycles, 3);
    for (const invalid of [0, -1, 1.5])
      assert.throws(() => Schema.decodeUnknownSync(CycleLimit)(invalid));
    for (const invalid of [
      { ...count, completed: 4 },
      { ...count, extra: true },
    ]) {
      assert.throws(() => Schema.decodeUnknownSync(LoopCycleCount)(invalid));
    }
    for (const invalid of [
      { ...ask, counts: [] },
      { ...ask, counts: [count, count] },
      { ...ask, loop: "fix" },
      { ...ask, limit: 4 },
      { ...ask, extra: true },
    ]) {
      assert.throws(() => Schema.decodeUnknownSync(CycleBudgetAsk)(invalid));
    }
  });
});
