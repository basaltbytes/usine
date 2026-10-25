import {
  isSettledItemState,
  LabelLaneSource,
  LaneName,
  StateLaneSource,
} from "@usine/config/board";
import { GitHubLabelName } from "@usine/config/label";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { TokenCount, UsdAmount } from "@usine/core/agent/session";
import { AttemptId, AttemptNumber, AttemptTask } from "@usine/core/attempt";
import { ItemKey, ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import {
  AgentFailureView,
  AttemptView,
  AwaitingApprovalView,
  BoardItemLink,
  BoardLaneId,
  BoardPullRequestView,
  BoardTaskView,
  BoardView,
  CanceledAttemptView,
  ClosedUnchangedView,
  FailedAttemptView,
  LabelView,
  LoopView,
  ProjectView,
  ReadOnlyBoardLaneView,
  ReadyOverview,
  RunFailedView,
  RunView,
  StalledItemView,
  SucceededAttemptView,
  TaskPoolUsageView,
  TaskUsageView,
  UsageCostView,
  WritableBoardLaneView,
  LocalWorkerAccess,
} from "@usine/orchestrator/operator";

// The browser test server handles lane writes only for this repository.
const boardRepository = RepositoryName.make("board-test/repo");

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const link = (
  number: number,
  kind: "issue" | "pr",
  title: string,
  state: BoardItemLink["state"] = kind === "pr" ? "pr-open" : "issue-open",
) =>
  new BoardItemLink({
    itemKey: ItemKey.make(`${boardRepository}:${number}`),
    kind,
    number: ItemNumber.make(number),
    title,
    url: `https://github.com/${boardRepository}/${kind === "pr" ? "pull" : "issues"}/${number}`,
    state,
  });

const attempt = (
  number: number,
  startedAt: string,
  failure: string | null | "running" | "canceled",
  endedAt: string | null = null,
) =>
  new AttemptView({
    task: AttemptTask.make("Implement the issue"),
    agent: AgentName.make("developer"),
    operatorIntervened: false,
    id: AttemptId.make(`attempt-${number}-${startedAt}`),
    number: AttemptNumber.make(number),
    worker: WorkerName.make("local"),
    workerAccess: new LocalWorkerAccess(),
    brain: new BrainSpec({ harness: "codex", model: ModelId.make("gpt-5.6-sol"), effort: "high" }),
    startedAt,
    outcome:
      failure === "running"
        ? null
        : failure === "canceled"
          ? new CanceledAttemptView()
          : failure === null
            ? new SucceededAttemptView()
            : new FailedAttemptView({ failure: new AgentFailureView({ message: failure }) }),
    endedAt,
    salvage: null,
  });

const isClosed = (state: RunView["state"]) =>
  state === "Succeeded" || state === "Failed" || state === "Canceled";

/** Returns a Run opened `minutes` ago; a closed Run closed when its last Attempt ended, else when it opened. */
const run = (
  id: string,
  item: BoardItemLink,
  loop: string,
  state: RunView["state"],
  minutes: number,
  attempts: ReadonlyArray<AttemptView>,
) =>
  new RunView({
    id: RunId.make(id),
    itemKey: item.itemKey,
    loop: LoopName.make(loop),
    repository: boardRepository,
    agent: AgentName.make(loop === "review" ? "reviewer" : "developer"),
    state,
    loopPaused: loop === "review",
    openedAt: minutesAgo(minutes),
    closedAt: isClosed(state) ? (attempts.at(-1)?.endedAt ?? minutesAgo(minutes)) : null,
    task: `Work on #${item.number}.`,
    attempts,
    approval: null,
    runAgain: null,
    resultMessage: null,
    pullRequestUrl: null,
    canApprove: state === "Waiting",
    canRetry: state === "Failed",
    canResolveFailure: state === "Failed",
    canCancel: state === "Waiting" || state === "Queued" || state === "Running",
    canRunAgain: state === "Succeeded" || state === "Canceled",
  });

/** Returns one billing pool's tokens, priced dollars, and whether some usage has no price. */
const pool = (
  name: TaskPoolUsageView["pool"],
  tokens: number,
  usd: number | null = null,
  unpriced = false,
): TaskPoolUsageView =>
  new TaskPoolUsageView({
    pool: name,
    tokens: TokenCount.make(tokens),
    cost:
      usd === null
        ? null
        : new UsageCostView({ usd: UsdAmount.make(usd), estimate: name === "claudePlan" }),
    unpriced,
  });

/** Returns a Task's usage as the server computes it: its Runs' Attempt time and billing pools. */
export const taskUsageOf = (
  runs: ReadonlyArray<RunView>,
  pools: ReadonlyArray<TaskPoolUsageView> = [],
): TaskUsageView => {
  const attempts = runs.flatMap((candidate) => candidate.attempts);
  const priced = pools.flatMap(({ cost }) => (cost === null ? [] : [cost]));
  return new TaskUsageView({
    durationMillis: attempts.reduce(
      (sum, { startedAt, endedAt, outcome }) =>
        outcome === null || endedAt === null
          ? sum
          : sum + Date.parse(endedAt) - Date.parse(startedAt),
      0,
    ),
    runningSince: attempts.flatMap(({ startedAt, outcome }) =>
      outcome === null ? [startedAt] : [],
    ),
    unmeasured: attempts.filter(({ endedAt, outcome }) => outcome !== null && endedAt === null)
      .length,
    tokens: TokenCount.make(pools.reduce((sum, { tokens }) => sum + tokens, 0)),
    pools,
    cost:
      priced.length === 0
        ? null
        : new UsageCostView({
            usd: UsdAmount.make(priced.reduce((sum, { usd }) => sum + usd, 0)),
            estimate: priced.some(({ estimate }) => estimate),
          }),
  });
};

const task = (
  members: readonly [BoardItemLink, ...ReadonlyArray<BoardItemLink>],
  labels: ReadonlyArray<string>,
  runs: ReadonlyArray<RunView> = [],
  extra: {
    readonly conflicting?: boolean;
    readonly state?: BoardTaskView["state"];
    readonly loops?: ReadonlyArray<string>;
    /** The billing pools of the Task's Runs, summed. */
    readonly pools?: ReadonlyArray<TaskPoolUsageView>;
  } = {},
) => {
  const current = members.at(-1) ?? members[0];
  const state = extra.state ?? (current.kind === "pr" ? "pr-open" : "issue-open");
  // As the server does, a failed Run on a closed or merged Item doesn't need the operator.
  const needsYou = (run: RunView) =>
    run.canApprove ||
    (run.canResolveFailure &&
      !members.some(({ itemKey, state }) => itemKey === run.itemKey && isSettledItemState(state)));
  const preferred = [...runs].reverse().find(needsYou) ?? runs.at(-1);
  return new BoardTaskView({
    ...current,
    title: members[0].title,
    state,
    labels: labels.map((label) => GitHubLabelName.make(label)),
    items: members,
    // If the Task has a pull request, the current Item is the newest one.
    pullRequest:
      current.kind === "pr" && (state === "pr-open" || state === "pr-merged")
        ? new BoardPullRequestView({ number: current.number, url: current.url, state })
        : null,
    runs,
    run: preferred ?? null,
    needsYou: runs.some(needsYou),
    conflicting: extra.conflicting ?? false,
    loops: (extra.loops ?? []).map((loop) => LoopName.make(loop)),
    usage: taskUsageOf(runs, extra.pools),
  });
};

const writable = (name: string, label: string, items: ReadonlyArray<BoardTaskView>) =>
  new WritableBoardLaneView({
    id: BoardLaneId.make(`authored:${label}`),
    name: LaneName.make(name),
    sources: [new LabelLaneSource({ label: GitHubLabelName.make(label) })],
    labels: [GitHubLabelName.make(label)],
    origin: "authored",
    items,
  });

const redesign = link(9, "issue", "Redesign the Board columns and cards");
const redesignPr = link(31, "pr", "feat(web): redesign the Board columns and cards");
const salvage = link(
  7,
  "issue",
  "Retry salvage pushes when the Worker loses its network mid-Attempt",
);
const pinned = link(28, "pr", "Pin GitHub Actions to commit SHAs and add Dependabot for them");
const shipped = link(5, "issue", "Show the salvage branch on failed Attempts", "issue-closed");
const shippedPr = link(
  6,
  "pr",
  "feat(web): show the salvage branch on failed Attempts",
  "pr-merged",
);
const dropped = link(18, "issue", "Cache the label catalog per repository");
const flaky = link(
  15,
  "issue",
  "Reader restore test is flaky on narrow viewports when the sidebar is collapsed and the transcript history spans several earlier pages",
);
const bump = link(40, "pr", "Bump vite from 7.1.3 to 7.1.4");
const node = link(44, "pr", "Pin the Node version of the release workflow");
const backlog = link(50, "issue", "Investigate the reader's scroll restore on Safari");

const salvageRun = run("run-salvage", salvage, "implement", "Waiting", 3, []);
const droppedRun = run("run-dropped", dropped, "implement", "Canceled", 1440, [
  attempt(1, minutesAgo(1440), "canceled", minutesAgo(1430)),
]);
const pinnedRun = run("run-pinned", pinned, "review", "Failed", 95, [
  attempt(1, minutesAgo(95), "The required check lint failed on the pinned commit", minutesAgo(80)),
]);

/**
 * Returns a Board with every card variant: lane-only and overflowing labels, a linked PR, and open,
 * waiting, failed, canceled, and finished Runs; an empty Merge lane; a dependabot pull request that
 * no Loop matches and one with an open Run; and, at the end, Done with an issue and its merged PR,
 * and Unmapped with an issue.
 */
const boardProject = () =>
  new ProjectView({
    repository: boardRepository,
    status: "needs-you",
    runs: [],
    labels: [
      new LabelView({ name: GitHubLabelName.make("bug"), color: "d73a4a", description: null }),
      new LabelView({ name: GitHubLabelName.make("priority"), color: "fbca04", description: null }),
      new LabelView({ name: GitHubLabelName.make("ui"), color: "a2eeef", description: null }),
      new LabelView({ name: GitHubLabelName.make("ci"), color: "0e8a16", description: null }),
      new LabelView({ name: GitHubLabelName.make("docs"), color: "0075ca", description: null }),
      new LabelView({ name: GitHubLabelName.make("backlog"), color: "c5def5", description: null }),
      new LabelView({
        name: GitHubLabelName.make("ready-for-agent"),
        color: "1d76db",
        description: "An agent may start work",
      }),
      new LabelView({
        name: GitHubLabelName.make("in-progress"),
        color: "5319e7",
        description: null,
      }),
      new LabelView({ name: GitHubLabelName.make("review"), color: "d93f0b", description: null }),
      new LabelView({
        name: GitHubLabelName.make("ready-to-merge"),
        color: "0e8a16",
        description: null,
      }),
    ],
    preflightFindings: [],
    board: new BoardView({
      failures: [],
      lanes: [
        writable("Backlog", "backlog", [
          task([link(12, "issue", "Document the cycle budget reset")], ["backlog", "docs"]),
          task([flaky], ["backlog", "bug", "priority", "ci", "flaky"]),
          task([dropped], ["backlog"], [droppedRun]),
        ]),
        writable("Ready", "ready-for-agent", [
          task([salvage], ["ready-for-agent", "bug"], [salvageRun], { loops: ["implement"] }),
        ]),
        writable("In progress", "in-progress", [
          task(
            [redesign, redesignPr],
            ["in-progress", "ui"],
            [
              run("run-redesign-plan", redesign, "plan", "Succeeded", 180, [
                attempt(1, minutesAgo(180), null, minutesAgo(150)),
              ]),
              run("run-redesign", redesignPr, "implement", "Running", 12, [
                attempt(1, minutesAgo(12), "The Worker restarted", minutesAgo(7)),
                attempt(2, minutesAgo(6), "running"),
              ]),
            ],
            // The plan Run is priced; the implement Run is on the unpriced ChatGPT plan.
            {
              pools: [
                pool("apiKeys", 1_500, 0.75),
                pool("claudePlan", 20_000, 1.25),
                pool("chatgptPlan", 5_800),
              ],
            },
          ),
        ]),
        writable("Review", "review", [
          task([pinned], ["review"], [pinnedRun], {
            conflicting: true,
            loops: ["review"],
            pools: [pool("apiKeys", 12_000, 0.4)],
          }),
        ]),
        writable("Merge", "ready-to-merge", []),
        new ReadOnlyBoardLaneView({
          id: BoardLaneId.make("authored:pull-requests"),
          name: LaneName.make("Pull requests"),
          sources: [new StateLaneSource({ state: "pr-open" })],
          origin: "authored",
          items: [
            task([bump], []),
            task([node], [], [run("run-node", node, "rebase", "Queued", 2, [])]),
          ],
        }),
        new ReadOnlyBoardLaneView({
          id: BoardLaneId.make("authored:done"),
          name: LaneName.make("Done"),
          sources: [
            new StateLaneSource({ state: "issue-closed" }),
            new StateLaneSource({ state: "pr-merged" }),
          ],
          origin: "authored",
          items: [
            task(
              [shipped, shippedPr],
              [],
              [
                run("run-shipped", shipped, "implement", "Succeeded", 2 * 1440, [
                  attempt(1, minutesAgo(2 * 1440), null, minutesAgo(2 * 1440 - 30)),
                ]),
              ],
              { state: "pr-merged", pools: [pool("claudePlan", 48_000, 3.1)] },
            ),
          ],
        }),
        new ReadOnlyBoardLaneView({
          id: BoardLaneId.make("fallback:unmapped"),
          name: LaneName.make("Unmapped"),
          sources: [],
          origin: "fallback",
          items: [task([backlog], [])],
        }),
      ],
    }),
  });

const loop = (name: string, paused: boolean) =>
  new LoopView({
    name: LoopName.make(name),
    trigger: name === "implement" ? "issue" : "pr",
    agent: AgentName.make(name === "review" ? "reviewer" : "developer"),
    paused,
  });

export const boardOverview = () =>
  new ReadyOverview({
    projects: [boardProject()],
    loops: [loop("implement", false), loop("review", true), loop("rebase", false)],
    needsYou: [],
  });

/** Returns `overview` with each Task replaced by the result of `change`. */
export const changeTasks = (
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

/** Returns the Board after the operator resolved the failed review of pull request #28, so it
 * needs nothing from the operator. */
export const boardOverviewResolved = () =>
  changeTasks(boardOverview(), (task) => {
    if (task.itemKey !== pinned.itemKey) return task;
    const runs = task.runs.map((run) => new RunView({ ...run, canResolveFailure: false }));
    return new BoardTaskView({ ...task, runs, run: null, needsYou: false });
  });

/**
 * Returns the Board with #9's implement Run on the Claude plan instead of the ChatGPT plan. Its
 * Attempt reported 6,000 tokens but no price yet, so the Claude plan's $9.20 and the Task's $9.95
 * are lower bounds.
 */
export const boardOverviewUnpriced = () =>
  changeTasks(boardOverview(), (task) =>
    task.itemKey !== redesignPr.itemKey
      ? task
      : new BoardTaskView({
          ...task,
          usage: taskUsageOf(task.runs, [
            pool("apiKeys", 1_500, 0.75),
            pool("claudePlan", 26_000, 9.2, true),
          ]),
        }),
  );

/** Returns the Board with #18's canceled Attempt ended before end times were recorded, so the
 * Task's Attempt time is unknown. */
export const boardOverviewUntimed = () =>
  changeTasks(boardOverview(), (task) => {
    if (task.itemKey !== dropped.itemKey) return task;
    const untimed = run("run-dropped", dropped, "implement", "Canceled", 1440, [
      attempt(1, minutesAgo(1440), "canceled"),
    ]);
    return new BoardTaskView({
      ...task,
      runs: [untimed],
      run: untimed,
      usage: taskUsageOf([untimed]),
    });
  });

/** The package in the title of each Task that ran in `boardOverviewDocumented`, by originating Item. */
const documentedPackages = new Map([
  [9, "core"],
  [7, "agents"],
  [44, "engine"],
  [28, "orchestrator"],
  [18, "github"],
  [5, "config"],
]);

/**
 * Returns the Board with each Task that ran titled like `Document the public API of
 * @usine/orchestrator in TSDoc`, so titles differ only in the package name near the end. The
 * merged Task (#5) has wide figures: its Run finished 28 minutes ago after 1 h 21 min of Attempts,
 * and $12.62 on the Claude plan with a session not priced yet.
 */
export const boardOverviewDocumented = () =>
  changeTasks(boardOverview(), (task) => {
    const [origin, ...others] = task.items;
    const name = origin === undefined ? undefined : documentedPackages.get(origin.number);
    if (origin === undefined || name === undefined) return task;
    const title = `Document the public API of @usine/${name} in TSDoc`;
    const items = [new BoardItemLink({ ...origin, title }), ...others];
    if (task.itemKey !== shippedPr.itemKey) return new BoardTaskView({ ...task, title, items });
    const finished = run("run-shipped", shipped, "implement", "Succeeded", 109, [
      attempt(1, minutesAgo(109), null, minutesAgo(28)),
    ]);
    return new BoardTaskView({
      ...task,
      title,
      items,
      runs: [finished],
      run: finished,
      usage: taskUsageOf([finished], [pool("claudePlan", 1_284_000, 12.62, true)]),
    });
  });

/**
 * Returns `boardOverviewDocumented` with #9's running Run on the `dependency_updates` Loop, so its
 * status, `Running dependency_updates`, has a word wider than the Status column.
 */
export const boardOverviewDocumentedLongLoop = () =>
  changeTasks(boardOverviewDocumented(), (task) => {
    if (task.itemKey !== redesignPr.itemKey) return task;
    const runs = task.runs.map((run) =>
      run.state === "Running"
        ? new RunView({ ...run, loop: LoopName.make("dependency_updates") })
        : run,
    );
    return new BoardTaskView({
      ...task,
      runs,
      run: runs.find(({ id }) => id === task.run?.id) ?? null,
    });
  });

const reviewing = link(46, "pr", "Keep a running card in the lane its Run was triggered from");
const starting = link(47, "issue", "Move a running card to the lane of its current labels");

/**
 * Returns the Board while `review` runs on #46 and `implement` runs on #47. The review Loop removed
 * its trigger label `review`, so #46 has only `ci`, and the server keeps the card in the Review
 * lane until the Run ends. The implement Loop swapped `ready-for-agent` for `in-progress`, so the
 * server places #47 in the In progress lane.
 */
export const boardOverviewReviewing = () => {
  const running = new RunView({
    ...run("run-reviewing", reviewing, "review", "Running", 2, [
      attempt(1, minutesAgo(2), "running"),
    ]),
    loopPaused: false,
  });
  const held = task([reviewing], ["ci"], [running]);
  const started = task(
    [starting],
    ["in-progress", "bug"],
    [
      run("run-starting", starting, "implement", "Running", 1, [
        attempt(1, minutesAgo(1), "running"),
      ]),
    ],
  );
  const added = new Map([
    ["Review", held],
    ["In progress", started],
  ]);
  const overview = boardOverview();
  return new ReadyOverview({
    ...overview,
    projects: overview.projects.map(
      (project) =>
        new ProjectView({
          ...project,
          board: new BoardView({
            ...project.board,
            lanes: project.board.lanes.map((lane) => {
              const card = added.get(lane.name);
              return lane._tag === "WritableBoardLane" && card !== undefined
                ? new WritableBoardLaneView({ ...lane, items: [card, ...lane.items] })
                : lane;
            }),
          }),
        }),
    ),
  });
};

const stalled = (loopName: string, item: BoardItemLink, reason: StalledItemView["reason"]) =>
  new StalledItemView({
    repository: boardRepository,
    loop: LoopName.make(loopName),
    item,
    reason,
  });

/** Returns the desk's stalled Items for the Board's Items, in desk order. */
export const boardStalled = () => [
  stalled("implement", salvage, new AwaitingApprovalView({ run: salvageRun })),
  stalled("review", pinned, new RunFailedView({ run: pinnedRun })),
  stalled("implement", dropped, new ClosedUnchangedView({ run: droppedRun })),
];
