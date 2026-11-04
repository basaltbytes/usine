import { AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { ProviderRetries, TokenCount, UsdAmount } from "@usine/core/agent/session";
import { AttemptId, AttemptNumber } from "@usine/core/attempt";
import {
  CycleBudgetAsk,
  CycleBudgetAskId,
  CycleCount,
  CycleLimit,
  LoopCycleCount,
} from "@usine/core/cycle-budget";
import { ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import {
  AgentFailureView,
  ApprovalNeed,
  AttemptSummaryView,
  AwaitingApprovalView,
  AwaitingPollView,
  BlockedFailureView,
  BoardItemLink,
  BoardView,
  CanceledAttemptView,
  ClosedRunView,
  ClosedUnchangedView,
  CycleBudgetNeed,
  CycleBudgetUsedUpView,
  DeskView,
  FailedAttemptView,
  InfraFailureView,
  LoopPausedView,
  LoopView,
  FailedCheckView,
  PassedCheckView,
  ProjectView,
  ProviderRetryingView,
  QuestionFailureView,
  QueuedForWorkerView,
  ReadyOverview,
  RepositoryPollView,
  RunFailedView,
  RunFailureNeed,
  RunningAttemptView,
  RunSummaryView,
  StalledItemView,
  SucceededAttemptView,
  SuppressedForOperatorView,
  UnconfirmedStopView,
  WaitingForStopView,
  WorkerSilentView,
  WorkerSlotsView,
  WorkerView,
  LocalWorkerAccess,
  AgentStatisticsView,
  AttemptCountView,
  BrainStatisticsView,
  CostSummaryView,
  DurationSummaryView,
  LoopRunTimeView,
  LoopShareView,
  LoopStatisticsView,
  NeedsAttentionPeriodView,
  NeedsAttentionView,
  OutcomeCountsView,
  PoolTokensView,
  RunStatisticsView,
  StatisticsView,
  type StatisticsWindow,
  TaskDoneView,
  TaskPeriodView,
  TaskTimeView,
  TaskCostView,
  TaskTokensView,
  ThroughputPeriodView,
  UntimedTasksView,
  UsageSummaryView,
  WorkerQueueWaitView,
  WorkerUtilizationView,
} from "@usine/orchestrator/operator";
import { GitHubItemKey } from "@usine/orchestrator/polling-triggers";
import { Effect, Schema } from "effect";

const deskRepository = RepositoryName.make("basaltbytes/usine");

const brain = BrainSpec.make({
  harness: "claude",
  model: ModelId.make("claude-opus-4-7"),
  effort: "high",
});

const links = new Map<string, BoardItemLink>();

const link = (number: number, title: string) => {
  const item = BoardItemLink.make({
    itemKey: Effect.runSync(
      Schema.encodeEffect(GitHubItemKey)(["github", deskRepository, ItemNumber.make(number)]),
    ),
    kind: "issue",
    number: ItemNumber.make(number),
    title,
    url: `https://github.com/${deskRepository}/issues/${number}`,
    state: "issue-open",
  });
  links.set(item.itemKey, item);
  return item;
};

type Outcome = AttemptSummaryView["outcome"];

/**
 * Returns a desk with two running Attempts (one on a silent Worker), a stalled Item for each stall
 * reason, and recently closed Runs; all times are relative to `now`.
 */
export const deskFixture = (now: number) => {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const attempt = (
    id: string,
    started: number,
    outcome: Outcome,
    worker = "local",
    ended: number | null = null,
  ) =>
    AttemptSummaryView.make({
      id: AttemptId.make(`${id}-1`),
      number: AttemptNumber.make(1),
      worker: WorkerName.make(worker),
      workerAccess: LocalWorkerAccess.make(),
      brain,

      agent: AgentName.make("developer"),
      operatorIntervened: false,
      startedAt: ago(started),
      outcome,
      endedAt: ended === null ? null : ago(ended),
      salvage: null,
    });
  const run = (
    id: string,
    item: BoardItemLink,
    loop: string,
    state: RunSummaryView["state"],
    opened: number,
    attempts: ReadonlyArray<AttemptSummaryView>,
    pullRequest: number | null = null,
  ) =>
    RunSummaryView.make({
      agentBrain: brain,
      id: RunId.make(id),
      itemKey: item.itemKey,
      loop: LoopName.make(loop),
      repository: deskRepository,
      agent: AgentName.make(loop === "review-fix" ? "reviewer" : "developer"),
      state,
      loopPaused: loop === "review-fix",
      openedAt: ago(opened),
      closedAt:
        state === "Succeeded" || state === "Failed" || state === "Canceled"
          ? (attempts.at(-1)?.endedAt ?? ago(opened))
          : null,

      attempts,
      approval: null,
      runAgain: null,
      pullRequestUrl:
        pullRequest === null ? null : `https://github.com/${deskRepository}/pull/${pullRequest}`,
      canApprove: state === "Waiting",
      canRetry: state === "Failed",
      canResolveFailure: state === "Failed",
      canCancel:
        state === "Pending" || state === "Waiting" || state === "Queued" || state === "Running",
      canRunAgain: state === "Succeeded" || state === "Canceled",
    });

  const desk403 = link(403, "Operator desk replaces the Projects home");
  const board388 = link(388, "Board cards carry the stall reason");
  const runningDesk = run("run-desk-403", desk403, "start-dev", "Running", 48, [
    attempt("run-desk-403", 47, null, "hz-worker-1"),
  ]);
  const runningBoard = run("run-board-388", board388, "start-dev", "Running", 31, [
    attempt("run-board-388", 30, null),
  ]);

  const approval = link(410, "Group the Run outline by turn");
  const question = link(367, "Which lanes does the Board hide by default?");
  const budget = link(355, "Retry a salvaged Attempt from its branch");
  const failed = link(349, "Harvest review comments on pull requests");
  const canceled = [
    link(345, "Board flow arrows name the Loops that watch each lane"),
    link(400, "Page width per page kind"),
    link(401, "Loop detail shows the parsed file"),
  ];
  const paused = link(392, "Review the harvest of PR comments");
  const queued = link(398, "Mark a gone issue's projection from the re-check");
  const fresh = link(411, "Command palette once there is more than one Project");
  const unstopped = link(415, "Retry after a parent task that may still run");

  const waitingRun = run("run-approval-410", approval, "start-dev", "Waiting", 12, []);
  const questionRun = run("run-question-367", question, "start-dev", "Failed", 180, [
    attempt(
      "run-question-367",
      178,
      FailedAttemptView.make({
        failure: QuestionFailureView.make({
          question: "Should Done and Unmapped stay lanes or become filters?",
        }),
      }),
      "local",
      140,
    ),
  ]);
  const failedRun = run("run-failed-349", failed, "start-dev", "Failed", 240, [
    attempt(
      "run-failed-349",
      238,
      FailedAttemptView.make({
        failure: AgentFailureView.make({ message: "Claude Code is not logged in on Worker local" }),
      }),
      "local",
      231,
    ),
  ]);
  const canceledRuns = canceled.map((item, index) =>
    run(`run-canceled-${item.number}`, item, "start-dev", "Canceled", 600 + index * 20, [
      attempt(
        `run-canceled-${item.number}`,
        598 + index * 20,
        CanceledAttemptView.make(),
        "local",
        590 + index * 20,
      ),
    ]),
  );
  const queuedRun = run("run-queued-398", queued, "start-dev", "Queued", 3, []);
  const retryingRun = run("run-retrying-415", unstopped, "start-dev", "Running", 20, [
    attempt(
      "run-retrying-415",
      19,
      FailedAttemptView.make({
        failure: InfraFailureView.make({ message: "Lost the parent task" }),
      }),
      "local",
      10,
    ),
  ]);
  const ask = CycleBudgetAsk.make({
    id: CycleBudgetAskId.make("event-budget-355"),
    itemKey: budget.itemKey,
    repository: deskRepository,
    loop: LoopName.make("start-dev"),
    limit: CycleLimit.make(3),
    counts: [
      LoopCycleCount.make({
        loop: LoopName.make("start-dev"),
        admitted: CycleCount.make(3),
        completed: CycleCount.make(3),
      }),
    ],
  });
  const stalled = (loop: string, item: BoardItemLink, reason: StalledItemView["reason"]) =>
    StalledItemView.make({ repository: deskRepository, loop: LoopName.make(loop), item, reason });

  const outcomes = [
    run(
      "run-done-399",
      link(399, "Desk API with typed stall reasons"),
      "start-dev",
      "Succeeded",
      95,
      [attempt("run-done-399", 94, SucceededAttemptView.make(), "hz-worker-1", 52)],
      402,
    ),
    run(
      "run-review-396",
      link(396, "Reviewer pass on the harvest"),
      "review-fix",
      "Succeeded",
      160,
      [attempt("run-review-396", 159, SucceededAttemptView.make(), "local", 120)],
      397,
    ),
    run(
      "run-blocked-393",
      link(393, "Gateway reload keeps attachments"),
      "start-dev",
      "Failed",
      300,
      [
        attempt(
          "run-blocked-393",
          299,
          FailedAttemptView.make({
            failure: BlockedFailureView.make({ message: "Main fails its gate before any change." }),
          }),
          "local",
          262,
        ),
      ],
    ),
  ];

  const desk = DeskView.make({
    running: [
      RunningAttemptView.make({
        run: runningDesk,
        attempt: runningDesk.attempts[0] ?? attempt("missing", 0, null),
        item: desk403,
        lastActivityAt: ago(1),
        warnings: [],
      }),
      RunningAttemptView.make({
        run: runningBoard,
        attempt: runningBoard.attempts[0] ?? attempt("missing", 0, null),
        item: board388,
        lastActivityAt: ago(14),
        warnings: [
          WorkerSilentView.make({ worker: WorkerName.make("local"), lastAnsweredAt: ago(13) }),
          ProviderRetryingView.make({
            agent: AgentName.make("researcher"),
            message:
              "Reconnecting... waiting for network (Connection failed: error sending request)",
            retries: ProviderRetries.make(27),
            since: ago(12),
          }),
        ],
      }),
    ],
    notMoving: [
      stalled("start-dev", approval, AwaitingApprovalView.make({ run: waitingRun })),
      stalled("start-dev", question, SuppressedForOperatorView.make({ run: questionRun })),
      stalled("start-dev", budget, CycleBudgetUsedUpView.make({ ask })),
      stalled("start-dev", failed, RunFailedView.make({ run: failedRun })),
      ...canceledRuns.map((canceledRun, index) =>
        stalled(
          "start-dev",
          canceled[index] ?? approval,
          ClosedUnchangedView.make({ run: canceledRun }),
        ),
      ),
      stalled("review-fix", paused, LoopPausedView.make()),
      stalled(
        "start-dev",
        unstopped,
        WaitingForStopView.make({
          run: retryingRun,
          stop: UnconfirmedStopView.make({
            runId: retryingRun.id,
            attemptNumber: AttemptNumber.make(1),
            worker: WorkerName.make("local"),
          }),
        }),
      ),
      stalled("start-dev", queued, QueuedForWorkerView.make({ run: queuedRun, ahead: 2 })),
      stalled("start-dev", fresh, AwaitingPollView.make()),
    ],
    lastOutcomes: [...outcomes, ...canceledRuns].map((closed) =>
      ClosedRunView.make({
        run: closed,
        item: links.get(closed.itemKey) ?? null,
        closedAt: closed.attempts.at(-1)?.endedAt ?? closed.openedAt,
      }),
    ),
    workers: [
      WorkerView.make({
        name: WorkerName.make("local"),
        slots: WorkerSlotsView.make({ capacity: 2, leased: 1 }),
        preflight: PassedCheckView.make({ checkedAt: ago(420) }),
      }),
      WorkerView.make({
        name: WorkerName.make("hz-worker-1"),
        slots: WorkerSlotsView.make({ capacity: 1, leased: 1 }),
        preflight: FailedCheckView.make({
          checkedAt: ago(400),
          capability: "harness-login",
          message: "Codex is not logged in on Worker hz-worker-1",
        }),
      }),
    ],
    polls: [RepositoryPollView.make({ repository: deskRepository, polledAt: ago(2) })],
  });

  const overview = ReadyOverview.make({
    projects: [
      ProjectView.make({
        repository: deskRepository,
        status: "needs-you",
        runs: [runningDesk, runningBoard, waitingRun, questionRun, failedRun, ...canceledRuns],
        board: BoardView.make({ lanes: [], failures: [] }),
        labels: [],
        preflightFindings: [],
      }),
    ],
    loops: [
      LoopView.make({
        name: LoopName.make("start-dev"),
        trigger: "issue",
        agent: AgentName.make("developer"),
        paused: false,
      }),
      LoopView.make({
        name: LoopName.make("review-fix"),
        trigger: "pr",
        agent: AgentName.make("reviewer"),
        paused: true,
      }),
    ],
    needsYou: [
      ApprovalNeed.make({
        id: "approval:run-approval-410",
        repository: deskRepository,
        runId: waitingRun.id,
        loop: waitingRun.loop,
        item: approval,
      }),
      RunFailureNeed.make({
        id: "run-failure:run-question-367",
        repository: deskRepository,
        runId: questionRun.id,
        loop: questionRun.loop,
        failure: QuestionFailureView.make({
          question: "Should Done and Unmapped stay lanes or become filters?",
        }),
      }),
      CycleBudgetNeed.make({
        id: `cycle-budget:${ask.id}`,
        ask,
        itemLabel: `${deskRepository}#355`,
        itemUrl: budget.url,
      }),
    ],
  });

  const empty = DeskView.make({
    running: [],
    notMoving: [],
    lastOutcomes: [],
    workers: desk.workers.map((worker) =>
      WorkerView.make({
        ...worker,
        slots: WorkerSlotsView.make({ capacity: worker.slots.capacity, leased: 0 }),
      }),
    ),
    polls: desk.polls,
  });

  return { desk, empty, overview };
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 86_400_000;
const startDev = LoopName.make("start-dev");
const reviewFix = LoopName.make("review-fix");

const utcDay = (epochMillis: number) => new Date(epochMillis).toISOString().slice(0, 10);

/** Returns `durations` in hours as tasks merged at noon UTC on the given days after `from`. */
const tasksDone = (
  from: number,
  merges: ReadonlyArray<readonly [day: number, hours: number]>,
): ReadonlyArray<TaskDoneView> =>
  merges.map(([day, hours], index) =>
    TaskDoneView.make({
      repository: deskRepository,
      number: ItemNumber.make(500 + index),
      mergedAt: new Date(from + day * DAY + 12 * HOUR).toISOString(),
      durationMillis: Math.round(hours * HOUR),
    }),
  );

/** Returns one period per day from `from` to `now`, each counting the tasks merged that day. */
const dailyPeriods = (from: number, days: number, tasks: ReadonlyArray<TaskDoneView>) =>
  Array.from({ length: days }, (_, index) => {
    const start = utcDay(from + index * DAY);
    const members = tasks.filter(({ mergedAt }) => mergedAt.startsWith(start));
    return TaskPeriodView.make({
      start,
      tasks: members.length,
      medianMillis: members[0]?.durationMillis ?? null,
      firstTimeRight: Math.max(0, members.length - 1),
      operatorActions: members.length * 2,
    });
  });

/** Returns the tasks done of `window` with nothing merged; periods end on the UTC day of `now`. */
export const emptyStatisticsFixture = (now: number, window: StatisticsWindow) => {
  const today = now - (now % DAY);
  return StatisticsView.make({
    window,
    from: new Date(today).toISOString(),
    to: new Date(now).toISOString(),
    bucket: "day",
    loops: [],
    tasks: [],
    medianMillis: null,
    periods: dailyPeriods(today, 1, []),
    firstTimeRight: 0,
    operatorActions: 0,
    time: null,
    tokens: null,
    untimed: null,
    unmetered: 0,
  });
};

/**
 * Returns the tasks done over the 7 or 30 days that end on the UTC day of `now`: 4 or 12 tasks,
 * three quarters first time right, and in 30 days three tasks that lack timing.
 */
export const statisticsFixture = (now: number, window: "7d" | "30d") => {
  const days = window === "7d" ? 7 : 30;
  const from = now - (now % DAY) - (days - 1) * DAY;
  const tasks = tasksDone(
    from,
    window === "7d"
      ? [
          [1, 1.5],
          [3, 2],
          [4, 26],
          [6, 0.4],
        ]
      : [
          [2, 3],
          [5, 1.2],
          [8, 2.2],
          [11, 0.3],
          [13, 9],
          [16, 2],
          [19, 52],
          [22, 4.5],
          [24, 1.5],
          [26, 2],
          [27, 26],
          [29, 0.4],
        ],
  );
  return StatisticsView.make({
    window,
    from: new Date(from).toISOString(),
    to: new Date(now).toISOString(),
    bucket: "day",
    loops: [startDev, reviewFix],
    tasks,
    medianMillis: (window === "7d" ? 1.75 : 2.1) * HOUR,
    periods: dailyPeriods(from, days, tasks),
    firstTimeRight: (tasks.length * 3) / 4,
    operatorActions: (tasks.length * 3) / 2,
    time: TaskTimeView.make({
      tasks: window === "7d" ? 4 : 9,
      loops: [
        LoopShareView.make({ loop: startDev, share: 0.32 }),
        LoopShareView.make({ loop: reviewFix, share: 0.08 }),
      ],
      waiting: 0.6,
      runs: [
        LoopRunTimeView.make({ loop: startDev, runs: 9, medianMillis: 39 * MINUTE }),
        LoopRunTimeView.make({ loop: reviewFix, runs: 14, medianMillis: 4.2 * MINUTE }),
      ],
    }),
    tokens: TaskTokensView.make({
      tasks: tasks.length,
      medianTokens: TokenCount.make(620000),
      loops: [
        LoopShareView.make({ loop: startDev, share: 0.7 }),
        LoopShareView.make({ loop: reviewFix, share: 0.3 }),
      ],
      cost:
        window === "7d"
          ? null
          : TaskCostView.make({
              tasks: tasks.length - 2,
              medianUsd: UsdAmount.make(3.1),
              estimate: true,
            }),
    }),
    untimed:
      window === "7d" ? null : UntimedTasksView.make({ tasks: 3, before: utcDay(from + 12 * DAY) }),
    unmetered: 0,
  });
};

/** Returns 20 weeks of tasks done, which the section shows as weekly columns. */
export const weeklyStatisticsFixture = (now: number) => {
  const today = now - (now % DAY);
  const monday = today - ((new Date(today).getUTCDay() + 6) % 7) * DAY;
  const from = monday - 19 * 7 * DAY;
  const tasks = tasksDone(
    from,
    Array.from({ length: 40 }, (_, index) => [index * 3.4, 1 + (index % 6) * 3] as const),
  );
  return StatisticsView.make({
    window: "all",
    from: new Date(from).toISOString(),
    to: new Date(now).toISOString(),
    bucket: "week",
    loops: [startDev],
    tasks,
    medianMillis: 7 * HOUR,
    periods: Array.from({ length: 20 }, (_, index) =>
      TaskPeriodView.make({
        start: utcDay(from + index * 7 * DAY),
        tasks: 2,
        medianMillis: (2 + (index % 4)) * HOUR,
        firstTimeRight: 1,
        operatorActions: 3,
      }),
    ),
    firstTimeRight: 20,
    operatorActions: 60,
    time: null,
    tokens: null,
    untimed: null,
    unmetered: 0,
  });
};

const durations = (count: number, median: number) =>
  DurationSummaryView.make({ count, medianMillis: Math.round(median * MINUTE) });

const outcomes = (succeeded: number, failed: number, canceled: number) =>
  OutcomeCountsView.make({ succeeded, failed, canceled });

const usage = (measured: number, claudePlan: number, chatgptPlan: number, priced: number) =>
  UsageSummaryView.make({
    measured,
    tokens: TokenCount.make(claudePlan + chatgptPlan),
    meanTokens: TokenCount.make(Math.round((claudePlan + chatgptPlan) / measured)),
    pools: [
      PoolTokensView.make({ pool: "claudePlan", tokens: TokenCount.make(claudePlan) }),
      PoolTokensView.make({ pool: "chatgptPlan", tokens: TokenCount.make(chatgptPlan) }),
    ],
    cost:
      priced === 0
        ? null
        : CostSummaryView.make({
            usd: UsdAmount.make(priced * 3.1),
            meanUsd: UsdAmount.make(3.1),
            estimate: true,
            priced,
          }),
  });

/**
 * Returns the run statistics of the desk's Loops, Agents, and Workers over the 7 or 30 days that
 * end on the UTC day of `now`; the 30-day counts are three times the 7-day ones.
 */
export const runStatisticsFixture = (now: number, window: "7d" | "30d") => {
  const days = window === "7d" ? 7 : 30;
  const scale = window === "7d" ? 1 : 3;
  const from = now - (now % DAY) - (days - 1) * DAY;
  const periods = Array.from({ length: days }, (_, index) => utcDay(from + index * DAY));
  const busiest = days - 3;
  const developer = {
    outcomes: outcomes(6 * scale, 2 * scale, scale),
    time: durations(9 * scale, 39),
    usage: usage(9 * scale, 3_000_000 * scale, 0, 6 * scale),
  };
  const reviewer = {
    outcomes: outcomes(3 * scale, 0, 0),
    time: durations(3 * scale, 5),
    usage: usage(3 * scale, 600_000 * scale, 600_000 * scale, 2 * scale),
  };
  return RunStatisticsView.make({
    window,
    from: new Date(from).toISOString(),
    to: new Date(now).toISOString(),
    bucket: "day",
    runs: outcomes(9 * scale, 2 * scale, scale),
    runTime: durations(12 * scale, 18),
    attemptTime: durations(14 * scale, 14),
    unmeasuredAttempts: 0,
    throughput: periods.map((start, index) =>
      ThroughputPeriodView.make({
        start,
        ...(index === busiest
          ? outcomes(5 * scale, 2 * scale, 0)
          : index > busiest
            ? outcomes(2 * scale, 0, index === days - 1 ? scale : 0)
            : outcomes(0, 0, 0)),
      }),
    ),
    loops: [
      LoopStatisticsView.make({ loop: startDev, ...developer }),
      LoopStatisticsView.make({ loop: reviewFix, ...reviewer }),
    ],
    agents: [
      AgentStatisticsView.make({ agent: AgentName.make("developer"), ...developer }),
      AgentStatisticsView.make({ agent: AgentName.make("reviewer"), ...reviewer }),
    ],
    brains: [
      BrainStatisticsView.make({
        brain,
        outcomes: outcomes(9 * scale, 4 * scale, scale),
        time: durations(14 * scale, 14),
        usage: usage(14 * scale, 3600000 * scale, 600000 * scale, 8 * scale),
      }),
    ],
    queueWait: [
      WorkerQueueWaitView.make({ worker: WorkerName.make("hz-worker-1"), wait: durations(4, 2) }),
      WorkerQueueWaitView.make({ worker: WorkerName.make("local"), wait: durations(10, 0.1) }),
    ],
    attemptsPerRun: [
      AttemptCountView.make({ attempts: 1, runs: 10 * scale }),
      AttemptCountView.make({ attempts: 2, runs: scale }),
      AttemptCountView.make({ attempts: 3, runs: scale }),
    ],
    utilization: [
      WorkerUtilizationView.make({
        worker: WorkerName.make("local"),
        slots: 2,
        occupiedMillis: 900 * MINUTE,
        share: 0.38,
      }),
      WorkerUtilizationView.make({
        worker: WorkerName.make("hz-worker-1"),
        slots: 1,
        occupiedMillis: 180 * MINUTE,
        share: 0.12,
      }),
    ],
    needsAttention: NeedsAttentionView.make({
      approvals: 3 * scale,
      failures: 2 * scale,
      periods: periods.map((start, index) =>
        NeedsAttentionPeriodView.make({
          start,
          approvals: index === busiest ? 3 * scale : 0,
          failures: index === days - 1 ? 2 * scale : 0,
        }),
      ),
      approvalWait: durations(3 * scale, 14),
      retryWait: durations(scale, 45),
      resolutionWait: durations(scale, 15),
      failureWait: durations(2 * scale, 30),
    }),
  });
};

/** Returns the run statistics of `window` with no closed Run. */
export const emptyRunStatisticsFixture = (now: number, window: StatisticsWindow) => {
  const today = now - (now % DAY);
  return RunStatisticsView.make({
    window,
    from: new Date(today).toISOString(),
    to: new Date(now).toISOString(),
    bucket: "day",
    runs: outcomes(0, 0, 0),
    runTime: null,
    attemptTime: null,
    unmeasuredAttempts: 0,
    throughput: [ThroughputPeriodView.make({ start: utcDay(today), ...outcomes(0, 0, 0) })],
    loops: [],
    agents: [],
    brains: [],
    queueWait: [],
    attemptsPerRun: [],
    utilization: [
      WorkerUtilizationView.make({
        worker: WorkerName.make("local"),
        slots: 2,
        occupiedMillis: 0,
        share: 0,
      }),
    ],
    needsAttention: NeedsAttentionView.make({
      approvals: 0,
      failures: 0,
      periods: [],
      approvalWait: null,
      retryWait: null,
      resolutionWait: null,
      failureWait: null,
    }),
  });
};
