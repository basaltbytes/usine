import { Agent, Attempt, Item, Loop, Repository, Run, Worker } from "@usine/core";
import { LaneName } from "@usine/config";
import {
  AgentFailureView,
  AttemptView,
  BoardItemView,
  BoardLaneId,
  BoardView,
  FailedAttemptView,
  ProjectView,
  ReadOnlyBoardLaneView,
  RunView,
  SucceededAttemptView,
} from "@usine/orchestrator";
import { renderToStaticMarkup } from "react-dom/server";
import { assert, describe, it } from "vitest";
import { applyMove, itemFailure, laneUnder, orderLanes, runsWithoutCard } from "../src/board.tsx";
import { RunLinks } from "../src/components/run-links.tsx";

const brain = new Agent.BrainSpec({
  harness: "codex",
  model: Agent.ModelId.make("gpt-5.6-sol"),
  effort: "high",
});

const attempt = (number: number, message: string | null) =>
  new AttemptView({
    id: Attempt.AttemptId.make(`attempt-${number}`),
    number: Attempt.AttemptNumber.make(number),
    worker: Worker.Name.make("local"),
    brain,
    startedAt: `2026-09-01T12:00:0${number}.000Z`,
    outcome:
      message === null
        ? new SucceededAttemptView()
        : new FailedAttemptView({ failure: new AgentFailureView({ message }) }),
  });

const itemWithRun = (state: "Failed" | "Succeeded", attempts: ReadonlyArray<AttemptView>) => {
  const itemKey = Item.ItemKey.make('["github","basaltbytes/usine",33]');
  const run = new RunView({
    id: Run.RunId.make("run-33"),
    itemKey,
    loop: Loop.LoopName.make("review"),
    repository: Repository.Name.make("basaltbytes/usine"),
    agent: Agent.Name.make("developer"),
    state,
    loopPaused: false,
    openedAt: "2026-09-01T12:00:00.000Z",
    task: "Review issue 33.",
    attempts,
    resultMessage: null,
    pullRequestUrl: null,
    canApprove: false,
    canRetry: state === "Failed",
    canCancel: false,
  });
  return new BoardItemView({
    itemKey,
    kind: "issue",
    number: Item.Number.make(33),
    title: "Board lanes",
    url: "https://github.com/basaltbytes/usine/issues/33",
    state: "issue-open",
    labels: [],
    runs: [run],
    run,
    needsYou: state === "Failed",
  });
};

describe("Run links", () => {
  const run = itemWithRun("Succeeded", [attempt(1, null)]).run;
  assert(run !== null);

  it("links the Item and produced PR to GitHub in new tabs", () => {
    const markup = renderToStaticMarkup(
      <RunLinks
        run={
          new RunView({
            ...run,
            pullRequestUrl: "https://github.com/basaltbytes/usine/pull/101",
          })
        }
      />,
    );

    assert.ok(markup.includes("Item #33"));
    assert.ok(markup.includes('href="https://github.com/basaltbytes/usine/issues/33"'));
    assert.ok(markup.includes('href="https://github.com/basaltbytes/usine/pull/101"'));
    assert.strictEqual((markup.match(/target="_blank"/gu) ?? []).length, 2);
  });

  it("omits the produced PR link when the Run has none", () => {
    const markup = renderToStaticMarkup(<RunLinks run={run} />);

    assert.ok(markup.includes('href="https://github.com/basaltbytes/usine/issues/33"'));
    assert.ok(!markup.includes("pull request"));
    assert.strictEqual((markup.match(/target="_blank"/gu) ?? []).length, 1);
  });
});

describe("Board Run failure copy", () => {
  it("hides a failed Attempt after its Run recovers", () => {
    assert.strictEqual(
      itemFailure(itemWithRun("Succeeded", [attempt(1, "obsolete failure"), attempt(2, null)])),
      null,
    );
  });

  it("shows the latest failed Attempt for a currently Failed Run", () => {
    assert.strictEqual(
      itemFailure(
        itemWithRun("Failed", [attempt(1, "old failure"), attempt(2, "current failure")]),
      ),
      "current failure",
    );
  });
});

describe("Runs without a Board card", () => {
  it("lists only the Runs whose Item has no card", () => {
    const carded = itemWithRun("Succeeded", [attempt(1, null)]);
    const cardedRun = carded.runs[0];
    assert(cardedRun !== undefined);
    const scheduled = new RunView({
      ...cardedRun,
      id: Run.RunId.make("run-schedule"),
      itemKey: Item.ItemKey.make('["github","basaltbytes/usine"]'),
      loop: Loop.LoopName.make("nightly"),
      state: "Running",
      canCancel: true,
    });
    const project = new ProjectView({
      repository: Repository.Name.make("basaltbytes/usine"),
      status: "active",
      runs: [cardedRun, scheduled],
      labels: [],
      board: new BoardView({
        failures: [],
        lanes: [
          new ReadOnlyBoardLaneView({
            id: BoardLaneId.make("fallback:unmapped"),
            name: LaneName.make("Unmapped"),
            sources: [],
            origin: "fallback",
            items: [carded],
          }),
        ],
      }),
    });
    assert.deepStrictEqual(
      runsWithoutCard(project).map(({ id }) => id),
      [scheduled.id],
    );
  });
});

describe("Board lane order", () => {
  it("puts the fallback lane first so its cards can be dragged into the authored lanes", () => {
    const lane = (id: string, origin: "authored" | "proposed" | "fallback") =>
      new ReadOnlyBoardLaneView({
        id: BoardLaneId.make(id),
        name: LaneName.make(id),
        sources: [],
        origin,
        items: [],
      });
    assert.deepStrictEqual(
      orderLanes([
        lane("ready", "authored"),
        lane("review", "authored"),
        lane("unmapped", "fallback"),
      ]).map(({ id }) => id),
      ["unmapped", "ready", "review"],
    );
  });
});

describe("Board drag targets", () => {
  const lane = (id: string, items: ReadonlyArray<BoardItemView>) =>
    new ReadOnlyBoardLaneView({
      id: BoardLaneId.make(id),
      name: LaneName.make(id),
      sources: [],
      origin: "authored",
      items,
    });

  it("routes a drop on a card to that card's lane, and a drop on a lane to the lane itself", () => {
    const carded = itemWithRun("Succeeded", [attempt(1, null)]);
    const lanes = [lane("ready", []), lane("review", [carded])];
    assert.strictEqual(laneUnder(carded.itemKey, lanes)?.id, "review");
    assert.strictEqual(laneUnder(BoardLaneId.make("ready"), lanes)?.id, "ready");
    assert.strictEqual(laneUnder(BoardLaneId.make("elsewhere"), lanes), undefined);
  });

  it("shows a pending move in its target lane until the poll catches up", () => {
    const carded = itemWithRun("Succeeded", [attempt(1, null)]);
    const moved = applyMove([lane("ready", []), lane("review", [carded])], {
      itemKey: carded.itemKey,
      toLane: BoardLaneId.make("ready"),
    });
    assert.deepStrictEqual(
      moved.map(({ id, items }) => [id, items.length]),
      [
        ["ready", 1],
        ["review", 0],
      ],
    );
  });
});
