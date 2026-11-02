import { CommitSha } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { HandedOff } from "@usine/core/run/state";
import { LoopName } from "@usine/core/loop";
import {
  boardTaskRuns,
  boardRunSummary,
  BoardTaskView,
  RunSummaryView,
} from "@usine/orchestrator/operator";
import { renderToStaticMarkup } from "react-dom/server";
import { assert, it } from "vitest";
import { boardOverview } from "~/lib/projects/fixture";
import { WithRouter } from "~/lib/testing/memory-router";
import { taskCounts, taskRows } from "~/lib/tasks/model";
import { Status } from "./status";

it("keeps a handed-off task in flight with the fix run status and link", () => {
  const lane = boardOverview().projects[0]?.board.lanes.find(({ items }) =>
    items.some(({ runCount }) => runCount > 0),
  );
  const task = lane?.items.find(({ runCount }) => runCount > 0);
  const base = task === undefined ? undefined : boardTaskRuns(task)[0];
  assert(lane !== undefined && task !== undefined && base !== undefined);
  const fix = new RunSummaryView({
    ...base,
    id: RunId.make("fix-run-828"),
    loop: LoopName.make("fix"),
    state: "Running",
    closedAt: null,
    canCancel: true,
    canResolveFailure: false,
    canApprove: false,
  });
  const source = new RunSummaryView({
    ...base,
    state: "HandedOff",
    canCancel: false,
    canResolveFailure: false,
    canApprove: false,
    handoff: new HandedOff({
      reason: "CI failed: ci.",
      head: CommitSha.make("a".repeat(40)),
      fixLoop: fix.loop,
      fixRunId: fix.id,
    }),
  });
  const item = new BoardTaskView({
    ...task,
    ...boardRunSummary([source, fix], fix, task.items),
    run: fix,
    needsYou: false,
  });
  const rows = taskRows([{ ...lane, items: [item] }], []);
  const row = rows[0];
  assert(row !== undefined);
  assert.strictEqual(row.status._tag, "Running");
  assert.strictEqual(taskCounts(rows), "1 in flight");
  const markup = renderToStaticMarkup(
    <WithRouter>
      <Status row={row} now={Date.now()} />
    </WithRouter>,
  );
  assert.include(markup, "Running fix");
  assert.include(markup, `run=${fix.id}`);
  assert.notInclude(markup, "text-run-failed");
  assert.notInclude(markup, "Needs attention");
});
