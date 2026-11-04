import { HandedOff } from "@usine/core/run/state";
import { CardFace } from "./face";
import { administratorPermissions } from "@usine/core/access";
import { PermissionsContext } from "~/lib/permissions";
import { CiHandoff } from "@usine/core/ci";
import { CommitSha } from "@usine/core/repository";
import { RunLine } from "./run-line";
import { boardTaskRuns, boardRunSummary, MachineQuotaWait } from "@usine/orchestrator/operator";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { ChildSessionBudget, ChildSessionCount } from "@usine/core/agent/session";
import { AttemptNumber, AttemptId } from "@usine/core/attempt";
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
  AttemptSummaryView,
  BoardTaskView,
  BoardItemLink,
  BoardLaneId,
  BoardView,
  ChildSessionBudgetFailureView,
  ClosedUnchangedView,
  SuppressedForOperatorView,
  LoopPausedView,
  LoopView,
  QuestionFailureView,
  StalledItemView,
  FailedAttemptView,
  ProjectView,
  ReadOnlyBoardLaneView,
  RunFailureNeed,
  RunSummaryView,
  SucceededAttemptView,
  WritableBoardLaneView,
  LocalWorkerAccess,
} from "@usine/orchestrator/operator";
import { GitHubItemKey } from "@usine/orchestrator/polling-triggers";
import { Schema } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { assert, describe, it } from "vitest";
import { ProjectBoard } from "~/features/projects/board.page";
import { laneUnder, orderLanes, runsWithoutCard } from "~/features/projects/lib/board";
import { cardLabels, currentRun, itemFailure, runLineSince } from "~/lib/projects/card";
import { foldsByDefault } from "~/features/projects/components/column";
import { laneFlows } from "~/features/projects/components/flow";
import { elapsedLabel, timestampLabel } from "~/lib/strings";
import { needCopy } from "~/lib/needs-you/strings";
import { failureMessage } from "~/lib/runs/strings";
import { WithRouter } from "~/lib/testing/memory-router";
import { taskUsageOf } from "~/lib/projects/fixture";

const brain = BrainSpec.make({
  harness: "codex",
  model: ModelId.make("gpt-5.6-sol"),
  effort: "high",
});

const attempt = (number: number, message: string | null) =>
  AttemptSummaryView.make({
    agent: AgentName.make("developer"),
    operatorIntervened: false,
    id: AttemptId.make(`attempt-${number}`),
    number: AttemptNumber.make(number),
    worker: WorkerName.make("local"),
    workerAccess: LocalWorkerAccess.make(),
    brain,
    startedAt: `2026-09-01T12:00:0${number}.000Z`,
    outcome:
      message === null
        ? SucceededAttemptView.make()
        : FailedAttemptView.make({ failure: AgentFailureView.make({ message }) }),
    endedAt: `2026-09-01T12:30:0${number}.000Z`,
    salvage: null,
  });

const repository = RepositoryName.make("basaltbytes/usine");
const itemKey = Schema.encodeSync(GitHubItemKey)(["github", repository, ItemNumber.make(33)]);
const issueLink = (number: number, title: string) =>
  BoardItemLink.make({
    itemKey: Schema.encodeSync(GitHubItemKey)(["github", repository, ItemNumber.make(number)]),
    kind: "issue",
    number: ItemNumber.make(number),
    title,
    url: `https://github.com/basaltbytes/usine/issues/${number}`,
    state: "issue-open",
  });

const runOnItem = (state: "Failed" | "Succeeded", attempts: ReadonlyArray<AttemptSummaryView>) =>
  RunSummaryView.make({
    agentBrain: brain,
    id: RunId.make("run-33"),
    itemKey,
    loop: LoopName.make("review"),
    repository,
    agent: AgentName.make("developer"),
    state,
    loopPaused: false,
    openedAt: "2026-09-01T12:00:00.000Z",
    closedAt: attempts.at(-1)?.endedAt ?? "2026-09-01T12:00:00.000Z",
    attempts,
    approval: null,
    runAgain: null,
    pullRequestUrl: null,
    canApprove: false,
    canRetry: state === "Failed",
    canResolveFailure: state === "Failed",
    canCancel: false,
    canRunAgain: false,
  });

const itemWithRun = (
  state: "Failed" | "Succeeded",
  attempts: ReadonlyArray<AttemptSummaryView>,
) => {
  const run = runOnItem(state, attempts);
  const items = [issueLink(33, "Board lanes")];
  return BoardTaskView.make({
    repository,
    itemKey,
    kind: "issue",
    number: ItemNumber.make(33),
    title: "Board lanes",
    url: "https://github.com/basaltbytes/usine/issues/33",
    items,
    state: "issue-open",
    labels: [],
    pullRequest: null,
    ...boardRunSummary([run], run, items),
    run,
    needsYou: state === "Failed",
    conflicting: false,
    loops: [LoopName.make("review")],
    usage: taskUsageOf([run]),
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
    const review = RunSummaryView.make({
      ...runOnItem("Failed", [attempt(1, "new review failure")]),
      id: RunId.make("review-new"),
      openedAt: "2026-09-02T12:00:00.000Z",
    });
    assert.strictEqual(
      itemFailure(
        BoardTaskView.make({
          ...card,
          ...boardRunSummary([...boardTaskRuns(card), review], review, card.items),
          run: review,
        }),
      ),
      "new review failure",
    );
    const resolved = RunSummaryView.make({ ...review, canResolveFailure: false });
    assert.strictEqual(
      itemFailure(
        BoardTaskView.make({
          ...card,
          ...boardRunSummary([...boardTaskRuns(card), resolved], resolved, card.items),
          run: resolved,
        }),
      ),
      "old development failure",
    );
    assert.strictEqual(
      itemFailure(
        BoardTaskView.make({
          ...card,
          ...boardRunSummary([resolved], resolved, card.items),
          run: resolved,
        }),
      ),
      null,
    );
  });

  it("leaves out a failure on a closed issue, as Needs attention does", () => {
    const card = itemWithRun("Failed", [attempt(1, "Checks failed")]);
    const [issue] = card.items;
    assert(issue !== undefined);
    const closed = BoardTaskView.make({
      ...card,
      state: "issue-closed",
      items: [BoardItemLink.make({ ...issue, state: "issue-closed" })],
      needsYou: false,
    });
    assert.strictEqual(itemFailure(closed), null);
    assert.isNull(currentRun(closed));
  });

  it("explains an exhausted child-session budget in the drawer and Needs attention", () => {
    const failure = ChildSessionBudgetFailureView.make({
      maxChildren: ChildSessionBudget.make(4),
      attemptedChildren: ChildSessionCount.make(5),
    });
    const message = "Child session budget of 4 used; child 5 did not start";
    const repository = RepositoryName.make("basaltbytes/usine");
    const runId = RunId.make("run-33");
    assert.strictEqual(failureMessage(failure), message);
    assert.deepStrictEqual(
      needCopy(
        RunFailureNeed.make({
          id: "run-failure:run-33",
          repository,
          runId,
          loop: LoopName.make("review"),
          failure,
        }),
      ),
      {
        title: "review: child session budget exhausted",
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
    const cardedRun = boardTaskRuns(carded)[0];
    assert(cardedRun !== undefined);
    const scheduled = RunSummaryView.make({
      ...cardedRun,
      id: RunId.make("run-schedule"),
      itemKey: ItemKey.make('["github","basaltbytes/usine"]'),
      loop: LoopName.make("nightly"),
      state: "Running",
      canCancel: true,
    });
    const project = ProjectView.make({
      repository: RepositoryName.make("basaltbytes/usine"),
      status: "active",
      runs: [cardedRun, scheduled],
      labels: [],
      preflightFindings: [],
      board: BoardView.make({
        failures: [],
        lanes: [
          ReadOnlyBoardLaneView.make({
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
    const paginated = ProjectView.make({
      ...project,
      board: BoardView.make({
        ...project.board,
        cardedItemKeys: carded.items.map(({ itemKey }) => itemKey),
        lanes: project.board.lanes.map((lane) => ({ ...lane, items: [], totalItems: 1 })),
      }),
    });
    assert.deepStrictEqual(
      runsWithoutCard(paginated).map(({ id }) => id),
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
    ReadOnlyBoardLaneView.make({
      id: BoardLaneId.make(id),
      name: LaneName.make(id),
      sources: states.map((state) => StateLaneSource.make({ state })),
      origin,
      items: [],
    });
  const writable = (id: string) =>
    WritableBoardLaneView.make({
      id: BoardLaneId.make(id),
      name: LaneName.make(id),
      sources: [LabelLaneSource.make({ label: GitHubLabelName.make(id) })],
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
  const waiting = RunSummaryView.make({
    ...runOnItem("Succeeded", []),
    state: "Waiting",
    loop: LoopName.make("start-dev"),
  });
  const lane = (name: string, items: ReadonlyArray<BoardTaskView>) =>
    WritableBoardLaneView.make({
      id: BoardLaneId.make(name),
      name: LaneName.make(name),
      sources: [LabelLaneSource.make({ label: GitHubLabelName.make(name) })],
      labels: [GitHubLabelName.make(name)],
      origin: "authored",
      items,
    });
  const loop = (name: string, paused: boolean) =>
    LoopView.make({
      name: LoopName.make(name),
      trigger: "issue",
      agent: AgentName.make("developer"),
      paused,
    });

  it("names the Loops whose trigger matches a Task of the left lane, in the instance's order, with or without an open Run", () => {
    const flows = laneFlows(
      [
        lane("ready", [
          BoardTaskView.make({
            ...card,
            loops: [LoopName.make("start-dev"), LoopName.make("triage")],
          }),
        ]),
        lane("review", [
          BoardTaskView.make({
            ...card,
            loops: [],
            ...boardRunSummary([waiting], waiting, card.items),
            run: waiting,
          }),
        ]),
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
    // A Loop running on a Task its trigger no longer matches is not listed for the lane.
    assert.deepStrictEqual(flows.get(BoardLaneId.make("review"))?.loops, []);
    assert.isFalse(flows.has(BoardLaneId.make("merge")));
  });
});

describe("Board card stall note", () => {
  const question = AttemptSummaryView.make({
    ...attempt(1, "unused"),
    outcome: FailedAttemptView.make({
      failure: QuestionFailureView.make({ question: "Which lanes stay on the Board?" }),
    }),
  });
  const suppressingRun = runOnItem("Failed", [question]);
  const suppressed = itemWithRun("Failed", [question]);
  const canceledLink = issueLink(18, "Cache the label catalog");
  const canceledRun = RunSummaryView.make({
    ...runOnItem("Succeeded", [attempt(1, null)]),
    id: RunId.make("run-18"),
    itemKey: canceledLink.itemKey,
    loop: LoopName.make("start-dev"),
    state: "Canceled",
    canRunAgain: true,
  });
  const canceled = BoardTaskView.make({
    ...suppressed,
    ...canceledLink,
    items: [canceledLink],
    ...boardRunSummary([canceledRun], canceledRun, [canceledLink]),
    run: canceledRun,
    needsYou: false,
  });
  const pausedLink = issueLink(19, "Review the harvest of PR comments");
  const paused = BoardTaskView.make({
    ...suppressed,
    ...pausedLink,
    items: [pausedLink],
    ...boardRunSummary([], null, [pausedLink]),
    run: null,
    needsYou: false,
  });
  const render = (disabled: boolean) =>
    renderToStaticMarkup(
      <PermissionsContext.Provider value={administratorPermissions}>
        <QueryClientProvider client={new QueryClient()}>
          <WithRouter>
            <ProjectBoard
              project={ProjectView.make({
                repository,
                status: "needs-you",
                runs: [],
                labels: [],
                preflightFindings: [],
                board: BoardView.make({
                  failures: [],
                  lanes: [
                    ReadOnlyBoardLaneView.make({
                      id: BoardLaneId.make("authored:Backlog"),
                      name: LaneName.make("Backlog"),
                      sources: [],
                      origin: "authored",
                      items: [suppressed, canceled, paused],
                    }),
                  ],
                }),
              })}
              loops={[]}
              stalled={[
                StalledItemView.make({
                  repository,
                  loop: LoopName.make("review"),
                  item: issueLink(33, "Board lanes"),
                  reason: SuppressedForOperatorView.make({ run: suppressingRun }),
                }),
                StalledItemView.make({
                  repository,
                  loop: LoopName.make("start-dev"),
                  item: canceledLink,
                  reason: ClosedUnchangedView.make({ run: canceledRun }),
                }),
                StalledItemView.make({
                  repository,
                  loop: LoopName.make("review-fix"),
                  item: pausedLink,
                  reason: LoopPausedView.make(),
                }),
              ]}
              disabled={disabled}
              openRun={() => {}}
            />
          </WithRouter>
        </QueryClientProvider>
      </PermissionsContext.Provider>,
    );

  it("answers a suppressing Run's question from its failure note, and runs a canceled one again from the reason", () => {
    const markup = render(false);
    assert.include(markup, "Which lanes stay on the Board?");
    assert.include(markup, "Mark answered");
    assert.notInclude(markup, ">Retry<");
    assert.match(markup, /start-dev <\/span>Canceled \d+d ago, unchanged since</u);
    assert.include(markup, ">Run again<");
    // The paused Loop's fragment already contains the Loop name, so it is not prefixed.
    assert.include(markup, ">review-fix paused<");
    assert.notInclude(markup, "review-fix </span>");
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
      const project = ProjectView.make({
        repository,
        status: "clear",
        runs: boardTaskRuns(card),
        labels: [],
        preflightFindings: [],
        board: BoardView.make({
          failures: [],
          lanes: names.map((name, index) => {
            const label = GitHubLabelName.make(name);
            const fields = {
              id: BoardLaneId.make(`${origin}:${name}`),
              name: LaneName.make(name),
              sources: [LabelLaneSource.make({ label })],
              items: index === 0 ? [card] : [],
            };
            return origin === "authored"
              ? WritableBoardLaneView.make({ ...fields, origin: "authored", labels: [label] })
              : ReadOnlyBoardLaneView.make({ ...fields, origin: "proposed" });
          }),
        }),
      });
      return renderToStaticMarkup(
        <PermissionsContext.Provider value={administratorPermissions}>
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
          </QueryClientProvider>
        </PermissionsContext.Provider>,
      );
    };
    const proposed = render("proposed", ["ready", "review"]);
    const singleAuthored = render("authored", ["ready"]);
    for (const readOnly of [proposed, singleAuthored]) {
      // Read-only cards have no drag control around them.
      assert.ok(!readOnly.includes('role="button"'));
      assert.ok(readOnly.includes("Actions for issue #33"));
    }
    assert.ok(proposed.includes("Configuration &gt; Projects"));
    const authored = render("authored", ["ready", "review"]);
    assert.ok(authored.includes('role="button"'));
    assert.ok(authored.includes('aria-roledescription="sortable"'));
  });

  const lane = (id: string, items: ReadonlyArray<BoardTaskView>) =>
    ReadOnlyBoardLaneView.make({
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
    const pullRequest = BoardItemLink.make({
      itemKey: prKey,
      kind: "pr",
      number: ItemNumber.make(40),
      title: "Fix the Board lanes",
      url: "https://github.com/basaltbytes/usine/pull/40",
      state: "pr-open",
    });
    // A Task whose current Item is its pull request still links to the issue's number.
    const linked = BoardTaskView.make({
      ...withRun,
      ...pullRequest,
      title: withRun.title,
      items: [...withRun.items, pullRequest],
      ...boardRunSummary([], null, [...withRun.items, pullRequest]),
      run: null,
    });
    const quietKey = Schema.encodeSync(GitHubItemKey)(["github", repository, ItemNumber.make(12)]);
    const quiet = BoardTaskView.make({
      ...withRun,
      itemKey: quietKey,
      number: ItemNumber.make(12),
      items: [
        BoardItemLink.make({
          itemKey: quietKey,
          kind: "issue",
          number: ItemNumber.make(12),
          title: "Document the cycle budget reset",
          url: "https://github.com/basaltbytes/usine/issues/12",
          state: "issue-open",
        }),
      ],
      ...boardRunSummary([], null, []),
      run: null,
      needsYou: false,
    });
    const project = ProjectView.make({
      repository,
      status: "clear",
      runs: [],
      labels: [],
      preflightFindings: [],
      board: BoardView.make({
        failures: [],
        lanes: [
          ReadOnlyBoardLaneView.make({
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
      <PermissionsContext.Provider value={administratorPermissions}>
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
        </QueryClientProvider>
      </PermissionsContext.Provider>,
    );
    const titleLinks = [...markup.matchAll(/<h3[^>]*><a[^>]*href="([^"]+)"/gu)].map(
      ([, href]) => href,
    );
    assert.deepStrictEqual(titleLinks, [
      "/projects/basaltbytes-usine/tasks/33?repository=basaltbytes%2Fusine",
      "/projects/basaltbytes-usine/tasks/33?repository=basaltbytes%2Fusine",
      "/projects/basaltbytes-usine/tasks/12?repository=basaltbytes%2Fusine",
    ]);
  });
});

describe("Board card labels", () => {
  it("leaves out the labels of the card's own lane and keeps the others", () => {
    const ready = GitHubLabelName.make("ready");
    const review = GitHubLabelName.make("review");
    const bug = GitHubLabelName.make("bug");
    const card = BoardTaskView.make({
      ...itemWithRun("Succeeded", [attempt(1, null)]),
      labels: [ready, bug, review],
    });
    const lane = WritableBoardLaneView.make({
      id: BoardLaneId.make("authored:ready"),
      name: LaneName.make("Ready"),
      sources: [LabelLaneSource.make({ label: ready })],
      origin: "authored",
      labels: [ready],
      items: [card],
    });
    assert.deepStrictEqual(cardLabels(card, lane), [bug, review]);
    const unmapped = ReadOnlyBoardLaneView.make({
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
    const shown = (state: RunSummaryView["state"], canResolveFailure = false) =>
      currentRun(
        BoardTaskView.make({
          ...card,
          run: RunSummaryView.make({ ...runOnItem("Failed", [failed]), state, canResolveFailure }),
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
    const live = AttemptSummaryView.make({ ...attempt(2, null), outcome: null, endedAt: null });
    assert.strictEqual(
      runLineSince(RunSummaryView.make({ ...run, state: "Waiting" })),
      run.openedAt,
    );
    assert.strictEqual(
      runLineSince(RunSummaryView.make({ ...run, state: "Running", attempts: [failed, live] })),
      live.startedAt,
    );
    assert.strictEqual(runLineSince(run), failed.endedAt);
    // A retried Run is Running before its next Attempt starts.
    assert.strictEqual(runLineSince(RunSummaryView.make({ ...run, state: "Running" })), null);
    // Attempts that ended before end times were recorded have no end time.
    const unrecorded = AttemptSummaryView.make({ ...failed, endedAt: null });
    assert.strictEqual(runLineSince(RunSummaryView.make({ ...run, attempts: [unrecorded] })), null);
  });
});

it("renders the worker and quota refusal below the board run line", () => {
  const run = RunSummaryView.make({
    ...runOnItem("Failed", []),
    state: "Running",
    closedAt: null,
    machineWait: MachineQuotaWait.make({
      worker: WorkerName.make("pool"),
      message: "shared core limit exceeded",
    }),
  });
  const markup = renderToStaticMarkup(<RunLine run={run} />);
  assert.include(markup, "Waiting for pool: shared core limit exceeded");
});

it("links the waiting board run to its pushed pull request checks", () => {
  const run = RunSummaryView.make({
    ...runOnItem("Succeeded", [attempt(1, null)]),
    state: "AwaitingCi",
    closedAt: null,
    ciWait: CiHandoff.make({
      pullRequest: ItemNumber.make(815),
      head: CommitSha.make("a".repeat(40)),
      fixLoop: LoopName.make("fix"),
      timeoutSeconds: 3600,
      onGreen: [],
    }),
  });
  const markup = renderToStaticMarkup(<RunLine run={run} />);
  assert.include(markup, "Waiting for CI");
  assert.include(markup, "https://github.com/basaltbytes/usine/pull/815/checks");
  assert.strictEqual(runLineSince(run), run.attempts[0]?.endedAt);
});

it("shows the continuing fix status and its link on a neutral handed-off board card", () => {
  const fix = RunSummaryView.make({
    ...runOnItem("Succeeded", []),
    id: RunId.make("fix-run-828"),
    loop: LoopName.make("fix"),
    state: "Running",
    closedAt: null,
    canCancel: true,
  });
  const source = RunSummaryView.make({
    ...runOnItem("Succeeded", []),
    state: "HandedOff",
    handoff: HandedOff.make({
      reason: "CI failed: ci.",
      head: CommitSha.make("a".repeat(40)),
      fixLoop: fix.loop,
      fixRunId: fix.id,
    }),
  });
  const item = BoardTaskView.make({
    ...itemWithRun("Succeeded", []),
    ...boardRunSummary([source, fix], fix, itemWithRun("Succeeded", []).items),
  });
  const lane = ReadOnlyBoardLaneView.make({
    id: BoardLaneId.make("fallback:unmapped"),
    name: LaneName.make("Unmapped"),
    origin: "fallback",
    sources: [],
    items: [item],
  });
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <WithRouter>
        <CardFace
          item={item}
          lane={lane}
          catalog={new Map()}
          stall={null}
          readOnly
          action={null}
          again={null}
          progress={null}
        />
      </WithRouter>
    </QueryClientProvider>,
  );
  assert.strictEqual(currentRun(item)?.id, fix.id);
  assert.include(markup, "Running");
  assert.include(markup, `run=${fix.id}`);
  assert.include(markup, "continues the work");
  assert.notInclude(markup, "text-run-failed");
  assert.notInclude(markup, "Needs attention");
});
