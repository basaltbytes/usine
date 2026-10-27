import { assert, describe, it } from "vitest";
import { labelTextColor, luminance } from "~/components/label-badge";

describe("label colors on the dark theme", () => {
  it("keeps light GitHub colors as they are and lifts dark ones toward white", () => {
    assert.strictEqual(labelTextColor("f9e2af"), "#f9e2af");
    const lifted = labelTextColor("0e8a16");
    assert.notStrictEqual(lifted, "#0e8a16");
    assert.match(lifted, /^rgb\(\d+ \d+ \d+\)$/);
    assert.ok(luminance("0e8a16") < luminance("f9e2af"));
  });
});
