import { LoopName } from "@usine/core/loop";
import { RunId } from "@usine/core/run";
import {
  AwaitingPollView,
  BoardTaskView,
  ClosedUnchangedView,
  HeldForOperatorView,
  LoopPausedView,
  QueuedForWorkerView,
  RunFailedView,
  RunView,
  StalledItemView,
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
  totalsFigures,
} from "../src/task/model.ts";
import {
  boardOverview,
  boardOverviewResolved,
  boardOverviewUnpriced,
  boardOverviewUntimed,
  boardStalled,
  changeTasks,
} from "./board-fixture.ts";
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
  const lastRunOf = (task: BoardTaskView) => {
    const run = task.runs.at(-1);
    assert(run !== undefined);
    return run;
  };
  /** The desk's stall of the Loop of the Task's last Run on its first Item, for `reason`. */
  const stallOf = (task: BoardTaskView, reason: StalledItemView["reason"]) => {
    const [item] = task.items;
    const { repository, loop } = lastRunOf(task);
    assert(item !== undefined);
    return new StalledItemView({ repository, loop, item, reason });
  };
  /** `overview` with #18's Run, which waited three days, canceled a minute ago before any Attempt
   * began. */
  const canceledJustNow = (overview: ReturnType<typeof boardOverview>) =>
    changeTasks(overview, (task) =>
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

  it("lists only the Tasks with Runs, in flight first: running, waiting, then pending, queued, and stalled, each by when its Run opened", () => {
    const rows = taskRows(lanes(), boardStalled());
    // #31 opened 12m ago and runs; #7 opened 3m ago and waits; #44 queued 2m ago, and #28 failed
    // 95m ago and waits on the operator. #18 was canceled a day ago and is unchanged since, so it
    // is not in flight and goes before #6, merged two days ago. #12, #15, #40, and #50 never had a
    // Run.
    assert.deepStrictEqual(order(rows), [
      [31, "Running"],
      [7, "AwaitingApproval"],
      [44, "Queued"],
      [28, "Stalled"],
      [18, "Idle"],
      [6, "Done"],
    ]);
    assert.strictEqual(taskCounts(rows), "4 in flight, 1 done");
    assert.deepStrictEqual(rows[0] && taskLoops(rows[0].task), [
      { loop: LoopName.make("plan"), state: "Succeeded" },
      { loop: LoopName.make("implement"), state: "Running" },
    ]);
  });

  it("puts every Task in flight before the others, then orders the others by when the last Run ended", () => {
    // #18's Run was canceled a minute ago and the Item is unchanged since, after #28's failed
    // review opened 95m ago; that failure still waits on the operator, so #28 comes first.
    const canceled = canceledJustNow(boardOverview());
    const dropped = taskOf(18, canceled);
    const stalled = boardStalled().map((stall) =>
      stall.item.number === 18
        ? stallOf(dropped, new ClosedUnchangedView({ run: lastRunOf(dropped) }))
        : stall,
    );
    assert.deepStrictEqual(order(taskRows(lanes(canceled), stalled)).slice(3), [
      [28, "Stalled"],
      [18, "Idle"],
      [6, "Done"],
    ]);

    // Without the desk's stall, #28's failed review needs the operator; it ended 80m ago, after
    // #18's Run was canceled a day ago.
    const attention = taskRows(lanes(), withoutPinned);
    assert.deepStrictEqual(order(attention).slice(3), [
      [28, "NeedsAttention"],
      [18, "Idle"],
      [6, "Done"],
    ]);
    assert.strictEqual(taskCounts(attention), "3 in flight, 1 needs attention, 1 done");

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
    const canceled = canceledJustNow(boardOverviewResolved());
    // #28's review ended 80m ago, earlier than the cancel.
    assert.deepStrictEqual(order(taskRows(lanes(canceled), [])).slice(3), [
      [18, "Ended"],
      [28, "Ended"],
      [6, "Done"],
    ]);
  });

  it("keeps a Task in flight only while its stall waits on the operator, and counts an idle one as needing attention only while the operator is needed", () => {
    const statusOf = (
      number: number,
      reason: StalledItemView["reason"],
      overview = boardOverview(),
    ) =>
      taskRows(lanes(overview), [stallOf(taskOf(number, overview), reason)]).find(
        ({ task }) => task.number === number,
      )?.status._tag;
    // #18's Run was canceled on the Item's state, which is unchanged since; or the next poll acts on
    // the Item; or the Loop is paused. Nothing is in flight.
    assert.strictEqual(
      statusOf(18, new ClosedUnchangedView({ run: lastRunOf(taskOf(18)) })),
      "Idle",
    );
    assert.strictEqual(statusOf(18, new AwaitingPollView()), "Idle");
    assert.strictEqual(statusOf(18, new LoopPausedView()), "Idle");
    // #28's failed review, or the Agent's question it ended on, holds the Loop on the operator
    // until the operator resolves it.
    const pinned = lastRunOf(taskOf(28));
    assert.strictEqual(statusOf(28, new RunFailedView({ run: pinned })), "Stalled");
    assert.strictEqual(statusOf(28, new HeldForOperatorView({ run: pinned })), "Stalled");
    const resolved = boardOverviewResolved();
    const failure = new RunFailedView({ run: lastRunOf(taskOf(28, resolved)) });
    assert.strictEqual(statusOf(28, failure, resolved), "Idle");

    // An earlier failure on #18 waits on the operator, so the heading counts it as needing
    // attention; its status stays the stall's.
    const attention = changeTasks(boardOverview(), (task) =>
      task.number === 18 ? new BoardTaskView({ ...task, needsYou: true }) : task,
    );
    const rows = taskRows(lanes(attention), boardStalled());
    assert.strictEqual(rows.find(({ task }) => task.number === 18)?.status._tag, "Idle");
    assert.strictEqual(taskCounts(rows), "4 in flight, 1 needs attention, 1 done");
  });

  it("keeps a Task in flight on any of its failures that waits on the operator, though the desk lists a resolved one first", () => {
    /** `overview` with an audit Run on #28 that failed before its review did, its failure
     * resolved. */
    const withAudit = (overview: ReturnType<typeof boardOverview>) =>
      changeTasks(overview, (task) => {
        if (task.number !== 28) return task;
        const review = lastRunOf(task);
        const audit = new RunView({
          ...review,
          id: RunId.make("run-pinned-audit"),
          loop: LoopName.make("audit"),
          openedAt: minutesAgo(200),
          closedAt: minutesAgo(190),
          attempts: [],
          canResolveFailure: false,
        });
        return new BoardTaskView({ ...task, runs: [audit, ...task.runs] });
      });
    /** The desk's list for `overview`, with #28's failures in the desk's order: same Item, so by
     * Loop name, the audit first. */
    const deskOf = (overview: ReturnType<typeof boardOverview>) => {
      const pinned = taskOf(28, overview);
      const [item] = pinned.items;
      assert(item !== undefined);
      const failures = pinned.runs.map(
        (run) =>
          new StalledItemView({
            repository: run.repository,
            loop: run.loop,
            item,
            reason: new RunFailedView({ run }),
          }),
      );
      assert.deepStrictEqual(
        failures.map(({ loop }) => loop),
        [LoopName.make("audit"), LoopName.make("review")],
      );
      return boardStalled().flatMap((stall) => (stall.item.number === 28 ? failures : [stall]));
    };

    // The review's failure still waits on the operator, so #28 stays in flight on it.
    const mixed = withAudit(boardOverview());
    const rows = taskRows(lanes(mixed), deskOf(mixed));
    assert.deepStrictEqual(order(rows), [
      [31, "Running"],
      [7, "AwaitingApproval"],
      [44, "Queued"],
      [28, "Stalled"],
      [18, "Idle"],
      [6, "Done"],
    ]);
    const pinned = rows[3]?.status;
    assert(pinned?._tag === "Stalled");
    assert.strictEqual(pinned.stall.loop, LoopName.make("review"));
    assert.strictEqual(pinned.run.id, RunId.make("run-pinned"));
    assert.strictEqual(taskCounts(rows), "4 in flight, 1 done");

    // Once the review's failure is resolved too, nothing about #28 waits on the operator: it is
    // idle on the desk's first failure, the audit's, and the heading leaves it out.
    const resolved = withAudit(boardOverviewResolved());
    const settled = taskRows(lanes(resolved), deskOf(resolved));
    const idle = settled.find(({ task }) => task.number === 28)?.status;
    assert(idle?._tag === "Idle");
    assert.strictEqual(idle.stall.loop, LoopName.make("audit"));
    assert.strictEqual(taskCounts(settled), "3 in flight, 1 done");
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

  /** The line under the Tasks list's heading for `overview`, a `*` after each lower bound. */
  const totalsLine = (overview: ReturnType<typeof boardOverview>) =>
    totalsFigures(taskTotals(taskRows(lanes(overview), boardStalled()), Date.now()))
      .map(({ figure, words, lowerBound }) => `${figure}${lowerBound === null ? "" : "*"} ${words}`)
      .join(", ");

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
    assert(totals.usd !== null);
    assert.closeTo(totals.usd, 5.5, 1e-9);
    assert.isFalse(totals.unpriced);
    assert.strictEqual(
      totalsLine(boardOverview()),
      "7 runs, 1 h 36 min elapsed, 87.3K tokens, $5.50 estimated",
    );
  });

  it("keeps the priced dollars and marks only the cost a lower bound while a Run has no price yet", () => {
    const totals = taskTotals(taskRows(lanes(boardOverviewUnpriced()), boardStalled()), Date.now());
    assert.strictEqual(totals.tokens, 27_500 + 12_000 + 48_000);
    assert(totals.usd !== null);
    assert.closeTo(totals.usd, 13.45, 1e-9);
    assert.isTrue(totals.unpriced);
    assert.strictEqual(
      totalsLine(boardOverviewUnpriced()),
      "7 runs, 1 h 36 min elapsed, 87.5K tokens, $13.45* estimated",
    );
  });

  it("leaves out an Attempt with no recorded end and marks only the time a lower bound", () => {
    // #18's 10 min are unknown.
    assert.strictEqual(
      totalsLine(boardOverviewUntimed()),
      "7 runs, 1 h 26 min* elapsed, 87.3K tokens, $5.50 estimated",
    );
  });
});
