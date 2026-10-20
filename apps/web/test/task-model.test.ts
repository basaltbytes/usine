import { LoopName } from "@usine/core/loop";
import {
  BoardTaskView,
  BoardView,
  ClosedUnchangedView,
  ProjectView,
  QueuedForWorkerView,
  ReadOnlyBoardLaneView,
  ReadyOverview,
  RunView,
  StalledItemView,
  WritableBoardLaneView,
} from "@usine/orchestrator/operator";
import { Option } from "effect";
import { assert, describe, it } from "vitest";
import {
  attemptsDuration,
  itemStateLine,
  type TaskRow,
  taskCounts,
  taskDuration,
  taskLoops,
  taskRows,
  taskTotals,
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

/** `overview` with each Task `change` returns in place of the Task. */
const changeTasks = (
  overview: ReadyOverview,
  change: (task: BoardTaskView) => BoardTaskView,
): ReadyOverview =>
  new ReadyOverview({
    ...overview,
    projects: overview.projects.map(
      (project) =>
        new ProjectView({
          ...project,
          board: new BoardView({
            ...project.board,
            lanes: project.board.lanes.map((lane) =>
              lane._tag === "WritableBoardLane"
                ? new WritableBoardLaneView({ ...lane, items: lane.items.map(change) })
                : new ReadOnlyBoardLaneView({ ...lane, items: lane.items.map(change) }),
            ),
          }),
        }),
    ),
  });

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

describe("Tasks list model", () => {
  const lanes = (overview = boardOverview()) => {
    const [project] = overview.projects;
    assert(project !== undefined);
    return project.board.lanes;
  };
  const taskOf = (number: number, overview = boardOverview()) => {
    const found = lanes(overview)
      .flatMap(({ items }) => items)
      .find((task) => task.items.some((item) => item.number === number));
    assert(found !== undefined);
    return found;
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

  it("orders a Task whose waiting Run was canceled just now by the cancel, not by when the Run opened", () => {
    // #18's Run waited three days and was canceled a minute ago, before any Attempt began.
    const canceled = changeTasks(boardOverviewResolved(), (task) =>
      task.number === 18
        ? new BoardTaskView({
            ...task,
            runs: task.runs.map(
              (run) =>
                new RunView({
                  ...run,
                  openedAt: minutesAgo(3 * 1440),
                  closedAt: minutesAgo(1),
                  attempts: [],
                }),
            ),
          })
        : task,
    );
    // #28's review ended 80m ago, earlier than the cancel.
    assert.deepStrictEqual(order(taskRows(lanes(canceled), [])).slice(3), [
      [18, "Ended"],
      [28, "Ended"],
      [6, "Done"],
    ]);
  });

  it("explains a queued Run with the stall that names it, not an older stall on another Item", () => {
    // #9's plan Run succeeded on the issue; the implement Run on its pull request #31 is queued.
    const queued = changeTasks(boardOverview(), (task) =>
      task.number === 31
        ? new BoardTaskView({
            ...task,
            runs: task.runs.map((run) =>
              run.state === "Running"
                ? new RunView({ ...run, state: "Queued", attempts: [], canCancel: true })
                : run,
            ),
          })
        : task,
    );
    const redesign = taskOf(31, queued);
    const [plan, implement] = redesign.runs;
    const [issue, pullRequest] = redesign.items;
    assert(plan && implement && issue && pullRequest);
    const stall = (loop: string, item: typeof issue, reason: StalledItemView["reason"]) =>
      new StalledItemView({
        repository: implement.repository,
        loop: LoopName.make(loop),
        item,
        reason,
      });
    // The desk lists the closed, unchanged plan Run before the Run waiting for a worker.
    const stalled = [
      stall("plan", issue, new ClosedUnchangedView({ run: plan })),
      stall("implement", pullRequest, new QueuedForWorkerView({ run: implement })),
    ];
    const row = taskRows(lanes(queued), stalled).find(({ task }) => task.number === 31);
    assert(row?.status._tag === "Stalled");
    assert.strictEqual(row.status.stall.reason._tag, "QueuedForWorker");
    assert.strictEqual(row.status.run.id, implement.id);
    // Ordered by the queued Run's opening, 12m ago, so it comes after #44, queued 2m ago.
    assert.deepStrictEqual(order(taskRows(lanes(queued), stalled)).slice(0, 3), [
      [7, "AwaitingApproval"],
      [44, "Queued"],
      [31, "Stalled"],
    ]);
  });

  it("adds up the listed Tasks' runs, time, tokens, and priced dollars", () => {
    const now = Date.now();
    const redesign = taskOf(31);
    // 30 min of plan, 5 min of the first implement Attempt, and the live one for 6 min.
    assert.strictEqual(Math.round(taskDuration(redesign.usage, now) / 60_000), 41);
    const totals = taskTotals(taskRows(lanes(), boardStalled()), now);
    assert.strictEqual(totals.runs, 7);
    // #9 41 min, #28 15 min, #18 10 min, #5 30 min.
    assert.strictEqual(Math.round(totals.durationMillis / 60_000), 96);
    assert.strictEqual(totals.unmeasured, 0);
    assert.strictEqual(totals.tokens, 27_300 + 12_000 + 48_000);
    assert(totals.cost !== null);
    assert.closeTo(totals.cost.usd, 5.5, 1e-9);
    assert.isTrue(totals.cost.estimate);
  });
});
