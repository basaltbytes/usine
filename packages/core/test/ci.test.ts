import { jsonKey } from "../src/json-key.ts";
import { assert, it } from "@effect/vitest";
import { Option, Result } from "effect";
import { ciHandoff } from "../src/ci.ts";

const handoff = {
  pull_request: 815,
  head: "a".repeat(40),
  fix_loop: "widgets/fix",
  timeout_seconds: 3600,
  on_green: [{ item: 815, add: [], remove: ["agent-in-progress"] }],
};
it("decodes a strict CI handoff and preserves ordinary final answers", () => {
  const parsed = ciHandoff(`[usine:awaiting-ci]\n${jsonKey(handoff)}`);
  assert(Result.isSuccess(parsed) && Option.isSome(parsed.success));
  assert.strictEqual(parsed.success.value.fixLoop, "widgets/fix");
  assert.deepStrictEqual(parsed.success.value.onGreen[0]?.add, []);
  assert.deepStrictEqual(ciHandoff("Done"), Result.succeed(Option.none()));
  for (const value of [
    { ...handoff, extra: true },
    { ...handoff, head: "bad" },
    { ...handoff, timeout_seconds: 0 },
    { ...handoff, on_green: [{ item: 1, add: [], remove: [], extra: true }] },
  ]) {
    assert(Result.isFailure(ciHandoff(`[usine:awaiting-ci]\n${jsonKey(value)}`)));
  }
  assert(Result.isFailure(ciHandoff("[usine:awaiting-ci]\ninvalid json")));
});
