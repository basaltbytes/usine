import { LoopName } from "@usine/core/loop";
import { Option } from "effect";
import { assert, describe, it } from "vitest";
import {
  attemptsDuration,
  itemStateLine,
  type TaskRow,
  taskCounts,
  taskLoops,
  taskRows,
} from "../src/task/model.ts";
import { boardOverview, boardOverviewResolved, boardStalled } from "./board-fixture.ts";
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
  const lanes = (overview = boardOverview()) => {
    const [project] = overview.projects;
    assert(project !== undefined);
    return project.board.lanes;
  };
  const order = (rows: ReadonlyArray<TaskRow>) =>
    rows.map(({ task, status }) => [task.number, status._tag]);
  const withoutPinned = boardStalled().filter(({ item }) => item.number !== 28);

  it("lists only the Tasks with Runs, in flight first: running, waiting, then pending, queued, and stalled, each by when its Run opened", () => {
    const rows = taskRows(lanes(), boardStalled());
    // #31 opened 12m ago and runs; #7 opened 3m ago and waits; #44 queued 2m ago, #28 failed 95m
    // ago and #18 was canceled a day ago; #6 is merged. #12, #15, #40, and #50 never had a Run.
    assert.deepStrictEqual(order(rows), [
      [31, "Running"],
      [7, "AwaitingApproval"],
      [44, "Queued"],
      [28, "Stalled"],
      [18, "Stalled"],
      [6, "Done"],
    ]);
    assert.strictEqual(taskCounts(rows), "5 in flight, 1 done");
    assert.deepStrictEqual(rows[0] && taskLoops(rows[0].task), [
      { loop: LoopName.make("plan"), state: "Succeeded" },
      { loop: LoopName.make("implement"), state: "Running" },
    ]);
  });

  it("puts every Task in flight before the others, then orders the others by when the last Run ended", () => {
    // Without the desk's stall, #28's failed review needs the operator; it ended 80m ago, after
    // #18's canceled Run opened, and still follows it.
    const attention = taskRows(lanes(), withoutPinned);
    assert.deepStrictEqual(order(attention).slice(3), [
      [18, "Stalled"],
      [28, "NeedsAttention"],
      [6, "Done"],
    ]);
    assert.strictEqual(taskCounts(attention), "4 in flight, 1 needs attention, 1 done");

    // Once the failure is resolved and nothing is stalled, the last Run's outcome stands.
    const ended = taskRows(lanes(boardOverviewResolved()), []);
    assert.deepStrictEqual(order(ended).slice(3), [
      [28, "Ended"],
      [18, "Ended"],
      [6, "Done"],
    ]);
    const failed = ended[3]?.status;
    assert.strictEqual(failed?._tag === "Ended" && failed.run.state, "Failed");
    assert.strictEqual(taskCounts(ended), "3 in flight, 1 done");
  });
});
