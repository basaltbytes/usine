import { assert, describe, it } from "@effect/vitest";
import { supportedThinkingLevels } from "../../src/pi/thinking.ts";

describe("Pi thinking level support", () => {
  it("offers only off to a model without reasoning", () => {
    assert.deepStrictEqual(supportedThinkingLevels({ reasoning: false }), ["off"]);
  });

  it("passes unmapped levels through and requires an explicit mapping for xhigh and max", () => {
    assert.deepStrictEqual(
      supportedThinkingLevels({
        reasoning: true,
        thinkingLevelMap: { xhigh: "xhigh", max: "max", minimal: "low" },
      }),
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    );
    assert.deepStrictEqual(
      supportedThinkingLevels({ reasoning: true, thinkingLevelMap: { medium: "medium" } }),
      ["off", "minimal", "low", "medium", "high"],
    );
  });

  it("drops a level the registry maps to null", () => {
    assert.deepStrictEqual(
      supportedThinkingLevels({
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: null, medium: "medium", xhigh: "xhigh" },
      }),
      ["low", "medium", "high", "xhigh"],
    );
  });
});
