import { Option } from "effect";
import { assert, describe, it } from "vitest";
import { attemptsDuration, itemStateLine } from "../src/task/model.ts";
import { fullTask } from "./task-fixture.ts";

const runOf = (id: string) => {
  const run = fullTask().runs.find((candidate) => candidate.id === id);
  if (run === undefined) throw new Error(`No Run ${id}`);
  return run;
};

describe("Task page model", () => {
  it("adds up the Attempts' spans, counts a live one to now, and gives none it cannot know", () => {
    const now = Date.parse("2026-10-06T09:14:00.000Z");
    assert.deepStrictEqual(attemptsDuration(runOf("run-dev"), now), Option.some(60 * 60_000));
    assert.deepStrictEqual(attemptsDuration(runOf("run-again"), now), Option.some(15 * 60_000));
    assert.isTrue(Option.isNone(attemptsDuration(runOf("run-approve"), now)));
    const [ended] = runOf("run-plan").attempts;
    assert(ended !== undefined);
    assert.isTrue(
      Option.isNone(attemptsDuration({ attempts: [{ ...ended, endedAt: null }] }, now)),
    );
  });

  it("names the current Item's number only when it is not the originating Item", () => {
    const [issue, merged] = fullTask().items;
    assert.strictEqual(itemStateLine(issue, true), "Open issue");
    assert(merged !== undefined);
    assert.strictEqual(itemStateLine(merged, false), "Merged pull request #41");
  });
});
