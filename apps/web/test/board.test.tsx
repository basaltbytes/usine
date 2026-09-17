import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { ChildSessionBudget, ChildSessionCount } from "@usine/core/agent/session";
import { AttemptNumber, AttemptId, AttemptTask } from "@usine/core/attempt";
import { AgentName } from "@usine/core/agent";
import { ItemKey, ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import { LabelLaneSource, LaneName } from "@usine/config/board";
import { GitHubLabelName } from "@usine/config/label";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  AgentFailureView,
  AttemptView,
  BoardTaskView,
  BoardItemLink,
  BoardLaneId,
  BoardView,
  ChildSessionBudgetFailureView,
  FailedAttemptView,
  ProjectView,
  ReadOnlyBoardLaneView,
  RunFailureNeed,
  RunView,
  SucceededAttemptView,
  WritableBoardLaneView,
} from "@usine/orchestrator/operator";
import { GitHubItemKey } from "@usine/orchestrator/polling-triggers";
import { Schema } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { assert, describe, it } from "vitest";
import {
  itemFailure,
  laneUnder,
  orderLanes,
  ProjectBoard,
  runsWithoutCard,
} from "../src/board/board.tsx";
import { TaskHistory } from "../src/components/task-history.tsx";
import { RunLinks } from "../src/components/run-links.tsx";
import { failureMessage, needCopy } from "../src/operator-copy.ts";

const brain = new BrainSpec({
  harness: "codex",
  model: ModelId.make("gpt-5.6-sol"),
  effort: "high",
});

const attempt = (number: number, message: string | null) =>
  new AttemptView({
    task: AttemptTask.make("Review the task"),
    agent: AgentName.make("developer"),
    operatorIntervened: false,
    id: AttemptId.make(`attempt-${number}`),
    number: AttemptNumber.make(number),
    worker: WorkerName.make("local"),
    brain,
    startedAt: `2026-09-01T12:00:0${number}.000Z`,
    outcome:
      message === null
        ? new SucceededAttemptView()
        : new FailedAttemptView({ failure: new AgentFailureView({ message }) }),
  });

const repository = RepositoryName.make("basaltbytes/usine");
const itemKey = Schema.encodeSync(GitHubItemKey)(["github", repository, ItemNumber.make(33)]);

const runOnItem = (state: "Failed" | "Succeeded", attempts: ReadonlyArray<AttemptView>) =>
  new RunView({
    id: RunId.make("run-33"),
    itemKey,
    loop: LoopName.make("review"),
    repository,
    agent: AgentName.make("developer"),
    state,
    loopPaused: false,
    openedAt: "2026-09-01T12:00:00.000Z",
    task: "Review issue 33.",
    attempts,
    resultMessage: null,
    pullRequestUrl: null,
    canApprove: false,
    canRetry: state === "Failed",
    canResolveFailure: state === "Failed",
    canCancel: false,
  });

const itemWithRun = (state: "Failed" | "Succeeded", attempts: ReadonlyArray<AttemptView>) => {
  const run = runOnItem(state, attempts);
  return new BoardTaskView({
    itemKey,
    kind: "issue",
    number: ItemNumber.make(33),
    title: "Board lanes",
    url: "https://github.com/basaltbytes/usine/issues/33",
    items: [
      new BoardItemLink({
        itemKey,
        kind: "issue",
        number: ItemNumber.make(33),
        title: "Board lanes",
        url: "https://github.com/basaltbytes/usine/issues/33",
      }),
    ],
    state: "issue-open",
    labels: [],
    runs: [run],
    run,
    needsYou: state === "Failed",
  });
};

describe("Run links", () => {
  const run = runOnItem("Succeeded", [attempt(1, null)]);

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
    assert.ok(!markup.includes("/pull/"));
    assert.strictEqual((markup.match(/target="_blank"/gu) ?? []).length, 1);
  });

  it("renders nothing for a schedule Run, whose Item is the repository itself", () => {
    const scheduled = new RunView({
      ...run,
      itemKey: ItemKey.make('["github","basaltbytes/usine"]'),
    });
    assert.strictEqual(renderToStaticMarkup(<RunLinks run={scheduled} />), "");
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

  it("shows the newest failure across development and review Runs", () => {
    const card = itemWithRun("Failed", [attempt(1, "old development failure")]);
    const review = new RunView({
      ...runOnItem("Failed", [attempt(1, "new review failure")]),
      id: RunId.make("review-new"),
      openedAt: "2026-09-02T12:00:00.000Z",
    });
    assert.strictEqual(
      itemFailure(new BoardTaskView({ ...card, runs: [...card.runs, review], run: review })),
      "new review failure",
    );
    const resolved = new RunView({ ...review, canResolveFailure: false });
    assert.strictEqual(
      itemFailure(new BoardTaskView({ ...card, runs: [...card.runs, resolved], run: resolved })),
      "old development failure",
    );
    assert.strictEqual(
      itemFailure(new BoardTaskView({ ...card, runs: [resolved], run: resolved })),
      null,
    );
  });

  it("explains an exhausted child-session budget in the drawer and Needs you", () => {
    const failure = new ChildSessionBudgetFailureView({
      maxChildren: ChildSessionBudget.make(4),
      attemptedChildren: ChildSessionCount.make(5),
    });
    const message = "This Attempt used its 4-child session budget; child 5 did not start";
    const repository = RepositoryName.make("basaltbytes/usine");
    const runId = RunId.make("run-33");
    assert.strictEqual(failureMessage(failure), message);
    assert.deepStrictEqual(
      needCopy(
        new RunFailureNeed({
          id: "run-failure:run-33",
          repository,
          runId,
          loop: LoopName.make("review"),
          failure,
        }),
      ),
      {
        title: "ChildSessionBudgetFailure",
        detail: message,
        repository,
        runId,
      },
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
      id: RunId.make("run-schedule"),
      itemKey: ItemKey.make('["github","basaltbytes/usine"]'),
      loop: LoopName.make("nightly"),
      state: "Running",
      canCancel: true,
    });
    const project = new ProjectView({
      repository: RepositoryName.make("basaltbytes/usine"),
      status: "active",
      runs: [cardedRun, scheduled],
      labels: [],
      preflightFindings: [],
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
  it("offers card moves only when another authored label lane is available", () => {
    const card = itemWithRun("Succeeded", [attempt(1, null)]);
    const render = (origin: "authored" | "proposed", names: ReadonlyArray<string>) => {
      const project = new ProjectView({
        repository,
        status: "clear",
        runs: card.runs,
        labels: [],
        preflightFindings: [],
        board: new BoardView({
          failures: [],
          lanes: names.map((name, index) => {
            const label = GitHubLabelName.make(name);
            const fields = {
              id: BoardLaneId.make(`${origin}:${name}`),
              name: LaneName.make(name),
              sources: [new LabelLaneSource({ label })],
              items: index === 0 ? [card] : [],
            };
            return origin === "authored"
              ? new WritableBoardLaneView({ ...fields, origin: "authored", labels: [label] })
              : new ReadOnlyBoardLaneView({ ...fields, origin: "proposed" });
          }),
        }),
      });
      return renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
          <ProjectBoard project={project} disabled={false} openRun={() => {}} />
        </QueryClientProvider>,
      );
    };
    const proposed = render("proposed", ["ready", "review"]);
    const singleAuthored = render("authored", ["ready"]);
    for (const readOnly of [proposed, singleAuthored]) {
      assert.ok(!readOnly.includes("Move issue #33 to a lane"));
      // Read-only cards are content, without an inert interactive control around them.
      assert.ok(!readOnly.includes('role="button"'));
    }
    assert.ok(proposed.includes("repos[].lanes"));
    assert.ok(proposed.includes("usine.yaml"));
    const authored = render("authored", ["ready", "review"]);
    assert.ok(authored.includes("Move issue #33 to a lane"));
    assert.ok(authored.includes('role="button"'));
  });

  const lane = (id: string, items: ReadonlyArray<BoardTaskView>) =>
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
});

describe("Task history", () => {
  it("renders each stage with its saved Attempt count and a Run action", () => {
    const development = new RunView({
      ...runOnItem("Succeeded", [attempt(1, null)]),
      id: RunId.make("development"),
      loop: LoopName.make("develop"),
    });
    const review = new RunView({
      ...runOnItem("Failed", [attempt(1, "first"), attempt(2, "latest")]),
      id: RunId.make("review"),
    });
    const markup = renderToStaticMarkup(
      <TaskHistory runs={[development, review]} openRun={() => {}} />,
    );
    assert.ok(markup.includes("2 Runs · 3 Attempts"));
    assert.ok(markup.includes("Open develop Run: Succeeded"));
    assert.ok(markup.includes("Open review Run: Failed"));
    assert.ok(markup.indexOf("Open develop") < markup.indexOf("Open review"));
  });
});
