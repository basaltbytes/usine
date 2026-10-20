import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { ChildSessionBudget, ChildSessionCount } from "@usine/core/agent/session";
import { AttemptNumber, AttemptId, AttemptTask } from "@usine/core/attempt";
import { AgentName } from "@usine/core/agent";
import { ItemKey, ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import {
  LabelLaneSource,
  type LaneItemState,
  LaneName,
  StateLaneSource,
} from "@usine/config/board";
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
  ClosedUnchangedView,
  HeldForOperatorView,
  LoopView,
  QuestionFailureView,
  StalledItemView,
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
import { laneUnder, orderLanes, ProjectBoard, runsWithoutCard } from "../src/board/board.tsx";
import { cardLabels, currentRun, itemFailure, runLineSince } from "../src/board/card.tsx";
import { foldsByDefault } from "../src/board/column.tsx";
import { laneFlows } from "../src/board/flow.tsx";
import { elapsedLabel, failureMessage, needCopy, timestampLabel } from "../src/operator-copy.ts";
import { WithRouter } from "./memory-router.tsx";

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
    endedAt: `2026-09-01T12:30:0${number}.000Z`,
    salvage: null,
  });

const repository = RepositoryName.make("basaltbytes/usine");
const itemKey = Schema.encodeSync(GitHubItemKey)(["github", repository, ItemNumber.make(33)]);
const issueLink = (number: number, title: string) =>
  new BoardItemLink({
    itemKey: Schema.encodeSync(GitHubItemKey)(["github", repository, ItemNumber.make(number)]),
    kind: "issue",
    number: ItemNumber.make(number),
    title,
    url: `https://github.com/basaltbytes/usine/issues/${number}`,
  });

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
    approval: null,
    runAgain: null,
    resultMessage: null,
    pullRequestUrl: null,
    canApprove: false,
    canRetry: state === "Failed",
    canResolveFailure: state === "Failed",
    canCancel: false,
    canRunAgain: false,
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
    updatedAt: "2026-10-20T09:00:00Z",
    labels: [],
    pullRequest: null,
    runs: [run],
    run,
    needsYou: state === "Failed",
    conflicting: false,
    loops: [LoopName.make("review")],
  });
};

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

  it("explains an exhausted child-session budget in the drawer and Needs attention", () => {
    const failure = new ChildSessionBudgetFailureView({
      maxChildren: ChildSessionBudget.make(4),
      attemptedChildren: ChildSessionCount.make(5),
    });
    const message = "Child session budget of 4 used; child 5 did not start";
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
  const readOnly = (
    id: string,
    origin: "authored" | "proposed" | "fallback",
    states: ReadonlyArray<LaneItemState> = [],
  ) =>
    new ReadOnlyBoardLaneView({
      id: BoardLaneId.make(id),
      name: LaneName.make(id),
      sources: states.map((state) => new StateLaneSource({ state })),
      origin,
      items: [],
    });
  const writable = (id: string) =>
    new WritableBoardLaneView({
      id: BoardLaneId.make(id),
      name: LaneName.make(id),
      sources: [new LabelLaneSource({ label: GitHubLabelName.make(id) })],
      labels: [GitHubLabelName.make(id)],
      origin: "authored",
      items: [],
    });

  it("puts the lanes that accept moves first, then the read-only lanes, and the fallback lane last", () => {
    assert.deepStrictEqual(
      orderLanes([
        readOnly("unmapped", "fallback"),
        readOnly("pull-requests", "authored", ["pr-open"]),
        writable("ready"),
        readOnly("done", "authored", ["issue-closed", "pr-merged"]),
        writable("review"),
      ]).map(({ id }) => id),
      ["ready", "review", "pull-requests", "done", "unmapped"],
    );
  });

  it("folds the fallback lane and lanes of closed Items until the operator opens them", () => {
    assert.isTrue(foldsByDefault(readOnly("unmapped", "fallback")));
    assert.isTrue(foldsByDefault(readOnly("done", "authored", ["issue-closed", "pr-merged"])));
    assert.isFalse(foldsByDefault(readOnly("pull-requests", "authored", ["pr-open", "pr-merged"])));
    assert.isFalse(foldsByDefault(readOnly("backlog", "authored")));
    assert.isFalse(foldsByDefault(writable("ready")));
  });
});

describe("Board flow arrows", () => {
  const card = itemWithRun("Succeeded", [attempt(1, null)]);
  const waiting = new RunView({
    ...runOnItem("Succeeded", []),
    state: "Waiting",
    loop: LoopName.make("start-dev"),
  });
  const lane = (name: string, items: ReadonlyArray<BoardTaskView>) =>
    new WritableBoardLaneView({
      id: BoardLaneId.make(name),
      name: LaneName.make(name),
      sources: [new LabelLaneSource({ label: GitHubLabelName.make(name) })],
      labels: [GitHubLabelName.make(name)],
      origin: "authored",
      items,
    });
  const loop = (name: string, paused: boolean) =>
    new LoopView({
      name: LoopName.make(name),
      trigger: "issue",
      agent: AgentName.make("developer"),
      paused,
    });

  it("names the Loops whose trigger matches a Task of the left lane, in the instance's order, with or without an open Run", () => {
    const flows = laneFlows(
      [
        lane("ready", [
          new BoardTaskView({
            ...card,
            loops: [LoopName.make("start-dev"), LoopName.make("triage")],
          }),
        ]),
        lane("review", [new BoardTaskView({ ...card, loops: [], runs: [waiting], run: waiting })]),
        lane("merge", []),
      ],
      [loop("triage", true), loop("start-dev", false), loop("review", false)],
    );
    const ready = flows.get(BoardLaneId.make("ready"));
    assert.deepStrictEqual(ready?.loops, [
      { name: LoopName.make("triage"), paused: true },
      { name: LoopName.make("start-dev"), paused: false },
    ]);
    assert.strictEqual(ready?.tone, "idle");
    assert.strictEqual(ready?.next.name, "review");
    // A Loop at work on a Task its trigger no longer matches does not watch the lane.
    assert.deepStrictEqual(flows.get(BoardLaneId.make("review"))?.loops, []);
    assert.isFalse(flows.has(BoardLaneId.make("merge")));
  });
});

describe("Board card stall note", () => {
  const question = new AttemptView({
    ...attempt(1, "unused"),
    outcome: new FailedAttemptView({
      failure: new QuestionFailureView({ question: "Which lanes stay on the Board?" }),
    }),
  });
  const heldRun = runOnItem("Failed", [question]);
  const held = itemWithRun("Failed", [question]);
  const canceledLink = issueLink(18, "Cache the label catalog");
  const canceledRun = new RunView({
    ...runOnItem("Succeeded", [attempt(1, null)]),
    id: RunId.make("run-18"),
    itemKey: canceledLink.itemKey,
    loop: LoopName.make("start-dev"),
    state: "Canceled",
    canRunAgain: true,
  });
  const canceled = new BoardTaskView({
    ...held,
    ...canceledLink,
    items: [canceledLink],
    runs: [canceledRun],
    run: canceledRun,
    needsYou: false,
  });
  const render = (disabled: boolean) =>
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <WithRouter>
          <ProjectBoard
            project={
              new ProjectView({
                repository,
                status: "needs-you",
                runs: [],
                labels: [],
                preflightFindings: [],
                board: new BoardView({
                  failures: [],
                  lanes: [
                    new ReadOnlyBoardLaneView({
                      id: BoardLaneId.make("authored:Backlog"),
                      name: LaneName.make("Backlog"),
                      sources: [],
                      origin: "authored",
                      items: [held, canceled],
                    }),
                  ],
                }),
              })
            }
            loops={[]}
            stalled={[
              new StalledItemView({
                repository,
                loop: LoopName.make("review"),
                item: issueLink(33, "Board lanes"),
                reason: new HeldForOperatorView({ run: heldRun }),
              }),
              new StalledItemView({
                repository,
                loop: LoopName.make("start-dev"),
                item: canceledLink,
                reason: new ClosedUnchangedView({ run: canceledRun }),
              }),
            ]}
            disabled={disabled}
            openRun={() => {}}
          />
        </WithRouter>
      </QueryClientProvider>,
    );

  it("answers a held Run's question from its failure note, and runs a canceled one again from the reason", () => {
    const markup = render(false);
    assert.include(markup, "Which lanes stay on the Board?");
    assert.include(markup, "Mark answered");
    assert.notInclude(markup, ">Retry<");
    assert.match(markup, /start-dev <\/span>Canceled \d+d ago, unchanged since</u);
    assert.include(markup, ">Run again<");
  });

  it("names the reason but offers no action while the factory needs setup", () => {
    const markup = render(true);
    assert.include(markup, "unchanged since");
    assert.notInclude(markup, ">Run again<");
    assert.notInclude(markup, "Mark answered");
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
          <WithRouter>
            <ProjectBoard
              project={project}
              loops={[]}
              stalled={[]}
              disabled={false}
              openRun={() => {}}
            />
          </WithRouter>
        </QueryClientProvider>,
      );
    };
    const proposed = render("proposed", ["ready", "review"]);
    const singleAuthored = render("authored", ["ready"]);
    for (const readOnly of [proposed, singleAuthored]) {
      // Read-only cards are content, without an inert drag control around them.
      assert.ok(!readOnly.includes('role="button"'));
      assert.ok(readOnly.includes("Actions for issue #33"));
    }
    assert.ok(proposed.includes("repos[].lanes"));
    assert.ok(proposed.includes("usine.yaml"));
    const authored = render("authored", ["ready", "review"]);
    assert.ok(authored.includes('role="button"'));
    assert.ok(authored.includes('aria-roledescription="sortable"'));
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

describe("Board card link", () => {
  it("opens the Task page under its originating Item, with or without a current Run", () => {
    const withRun = itemWithRun("Failed", [attempt(1, "Checks failed")]);
    const prKey = Schema.encodeSync(GitHubItemKey)(["github", repository, ItemNumber.make(40)]);
    const pullRequest = new BoardItemLink({
      itemKey: prKey,
      kind: "pr",
      number: ItemNumber.make(40),
      title: "Fix the Board lanes",
      url: "https://github.com/basaltbytes/usine/pull/40",
    });
    // A Task whose pull request is its current Item still opens under the issue's number.
    const linked = new BoardTaskView({
      ...withRun,
      ...pullRequest,
      title: withRun.title,
      items: [...withRun.items, pullRequest],
      runs: [],
      run: null,
    });
    const quietKey = Schema.encodeSync(GitHubItemKey)(["github", repository, ItemNumber.make(12)]);
    const quiet = new BoardTaskView({
      ...withRun,
      itemKey: quietKey,
      number: ItemNumber.make(12),
      items: [
        new BoardItemLink({
          itemKey: quietKey,
          kind: "issue",
          number: ItemNumber.make(12),
          title: "Document the cycle budget reset",
          url: "https://github.com/basaltbytes/usine/issues/12",
        }),
      ],
      runs: [],
      run: null,
      needsYou: false,
    });
    const project = new ProjectView({
      repository,
      status: "clear",
      runs: [],
      labels: [],
      preflightFindings: [],
      board: new BoardView({
        failures: [],
        lanes: [
          new ReadOnlyBoardLaneView({
            id: BoardLaneId.make("authored:Backlog"),
            name: LaneName.make("Backlog"),
            sources: [],
            origin: "authored",
            items: [withRun, linked, quiet],
          }),
        ],
      }),
    });
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <WithRouter>
          <ProjectBoard
            project={project}
            loops={[]}
            stalled={[]}
            disabled={false}
            openRun={() => {}}
          />
        </WithRouter>
      </QueryClientProvider>,
    );
    const titleLinks = [...markup.matchAll(/<h3[^>]*><a[^>]*href="([^"]+)"/gu)].map(
      ([, href]) => href,
    );
    assert.deepStrictEqual(titleLinks, [
      "/projects/basaltbytes/usine/tasks/33",
      "/projects/basaltbytes/usine/tasks/33",
      "/projects/basaltbytes/usine/tasks/12",
    ]);
  });
});

describe("Board card labels", () => {
  it("leaves out the labels of the card's own lane and keeps the others", () => {
    const ready = GitHubLabelName.make("ready");
    const review = GitHubLabelName.make("review");
    const bug = GitHubLabelName.make("bug");
    const card = new BoardTaskView({
      ...itemWithRun("Succeeded", [attempt(1, null)]),
      labels: [ready, bug, review],
    });
    const lane = new WritableBoardLaneView({
      id: BoardLaneId.make("authored:ready"),
      name: LaneName.make("Ready"),
      sources: [new LabelLaneSource({ label: ready })],
      origin: "authored",
      labels: [ready],
      items: [card],
    });
    assert.deepStrictEqual(cardLabels(card, lane), [bug, review]);
    const unmapped = new ReadOnlyBoardLaneView({
      id: BoardLaneId.make("fallback:unmapped"),
      name: LaneName.make("Unmapped"),
      sources: [],
      origin: "fallback",
      items: [card],
    });
    assert.deepStrictEqual(cardLabels(card, unmapped), [ready, bug, review]);
  });
});

describe("Elapsed time", () => {
  it("names the largest whole unit since the instant", () => {
    const since = "2026-09-01T12:00:00.000Z";
    const at = (milliseconds: number) => Date.parse(since) + milliseconds;
    assert.strictEqual(elapsedLabel(since, at(59_000)), "now");
    assert.strictEqual(elapsedLabel(since, at(12 * 60_000)), "12m");
    assert.strictEqual(elapsedLabel(since, at(3 * 3_600_000 + 59 * 60_000)), "3h");
    assert.strictEqual(elapsedLabel(since, at(2 * 86_400_000)), "2d");
    assert.strictEqual(elapsedLabel(since, at(-5_000)), "now");
  });

  it("names a local date and minute in tooltips", () => {
    const local = (...parts: [number, number, number, number, number]) =>
      new Date(...parts).toISOString();
    assert.strictEqual(timestampLabel(local(2026, 9, 18, 17, 27)), "2026-10-18 17:27");
    assert.strictEqual(timestampLabel(local(2026, 0, 5, 9, 3)), "2026-01-05 09:03");
  });
});

describe("Board card Run line", () => {
  const failed = attempt(1, "Checks failed");

  it("shows an open Run or a failure that still needs the operator, and no closed Run", () => {
    const card = itemWithRun("Failed", [failed]);
    const shown = (state: RunView["state"], canResolveFailure = false) =>
      currentRun(
        new BoardTaskView({
          ...card,
          run: new RunView({ ...runOnItem("Failed", [failed]), state, canResolveFailure }),
        }),
      )?.state ?? null;
    assert.strictEqual(shown("Failed", true), "Failed");
    assert.strictEqual(shown("Failed"), null);
    assert.strictEqual(shown("Waiting"), "Waiting");
    assert.strictEqual(shown("Queued"), "Queued");
    assert.strictEqual(shown("Running"), "Running");
    assert.strictEqual(shown("Canceled"), null);
    assert.strictEqual(shown("Succeeded"), null);
  });

  it("counts from the Run's opening, its live Attempt's start, or its last Attempt's end", () => {
    const run = runOnItem("Failed", [failed]);
    const live = new AttemptView({ ...attempt(2, null), outcome: null, endedAt: null });
    assert.strictEqual(runLineSince(new RunView({ ...run, state: "Waiting" })), run.openedAt);
    assert.strictEqual(
      runLineSince(new RunView({ ...run, state: "Running", attempts: [failed, live] })),
      live.startedAt,
    );
    assert.strictEqual(runLineSince(run), failed.endedAt);
    // A retried Run is Running before its next Attempt starts.
    assert.strictEqual(runLineSince(new RunView({ ...run, state: "Running" })), null);
    // Attempts closed before end times were recorded have none.
    const unrecorded = new AttemptView({ ...failed, endedAt: null });
    assert.strictEqual(runLineSince(new RunView({ ...run, attempts: [unrecorded] })), null);
  });
});
