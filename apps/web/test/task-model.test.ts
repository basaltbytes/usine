import { LoopName } from "@usine/core/loop";
import { Option } from "effect";
import { assert, describe, it } from "vitest";
import { attemptsDuration, itemStateLine, taskLoops, taskRows } from "../src/task/model.ts";
import { boardOverview } from "./board-fixture.ts";
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

describe("Tasks list model", () => {
  it("puts the most recently active Task first: its last Run's end or start, else its Item's update", () => {
    const [project] = boardOverview().projects;
    assert(project !== undefined);
    const rows = taskRows(project.board.lanes);
    // #44 queued 2m ago, #7 waiting 3m, #31's live Attempt started 6m, #50 updated 10m, #28 and #18
    // ended 80m and a day ago, #6 two days ago; #40, #15, and #12 were updated a week ago.
    assert.deepStrictEqual(
      rows.map(({ task }) => task.number),
      [44, 7, 31, 50, 28, 18, 6, 40, 15, 12],
    );
    const redesign = rows[2];
    assert.strictEqual(redesign?.lane, "In progress");
    assert.deepStrictEqual(redesign && taskLoops(redesign.task), [
      LoopName.make("plan"),
      LoopName.make("implement"),
    ]);
  });
});
