import { AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { ProviderRetries, TokenCount, UsdAmount } from "@usine/core/agent/session";
import { AttemptId, AttemptNumber, AttemptTask } from "@usine/core/attempt";
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
  AttemptView,
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
  RunView,
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
  FirstPassView,
  LoopStatisticsView,
  NeedsAttentionPeriodView,
  NeedsAttentionView,
  OutcomeCountsView,
  PoolTokensView,
  StatisticsView,
  type StatisticsWindow,
  ThroughputPeriodView,
  UsageSummaryView,
  WorkerQueueWaitView,
  WorkerUtilizationView,
} from "@usine/orchestrator/operator";
import { GitHubItemKey } from "@usine/orchestrator/polling-triggers";
import { Schema } from "effect";

const deskRepository = RepositoryName.make("basaltbytes/usine");

const brain = new BrainSpec({
  harness: "claude",
  model: ModelId.make("claude-opus-4-7"),
  effort: "high",
});

const links = new Map<string, BoardItemLink>();

const link = (number: number, title: string) => {
  const item = new BoardItemLink({
    itemKey: Schema.encodeSync(GitHubItemKey)(["github", deskRepository, ItemNumber.make(number)]),
    kind: "issue",
    number: ItemNumber.make(number),
    title,
    url: `https://github.com/${deskRepository}/issues/${number}`,
    state: "issue-open",
  });
  links.set(item.itemKey, item);
  return item;
};

type Outcome = AttemptView["outcome"];

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
    new AttemptView({
      id: AttemptId.make(`${id}-1`),
      number: AttemptNumber.make(1),
      worker: WorkerName.make(worker),
      workerAccess: new LocalWorkerAccess(),
      brain,
      task: AttemptTask.make("Implement the issue."),
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
    state: RunView["state"],
    opened: number,
    attempts: ReadonlyArray<AttemptView>,
    pullRequest: number | null = null,
  ) =>
    new RunView({
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
      task: "Implement the issue.",
      attempts,
      approval: null,
      runAgain: null,
      resultMessage: null,
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
      new FailedAttemptView({
        failure: new QuestionFailureView({
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
      new FailedAttemptView({
        failure: new AgentFailureView({ message: "Claude Code is not logged in on Worker local" }),
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
        new CanceledAttemptView(),
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
      new FailedAttemptView({
        failure: new InfraFailureView({ message: "Lost the parent task" }),
      }),
      "local",
      10,
    ),
  ]);
  const ask = new CycleBudgetAsk({
    id: CycleBudgetAskId.make("event-budget-355"),
    itemKey: budget.itemKey,
    repository: deskRepository,
    loop: LoopName.make("start-dev"),
    limit: CycleLimit.make(3),
    counts: [
      new LoopCycleCount({
        loop: LoopName.make("start-dev"),
        admitted: CycleCount.make(3),
        completed: CycleCount.make(3),
      }),
    ],
  });
  const stalled = (loop: string, item: BoardItemLink, reason: StalledItemView["reason"]) =>
    new StalledItemView({ repository: deskRepository, loop: LoopName.make(loop), item, reason });

  const outcomes = [
    run(
      "run-done-399",
      link(399, "Desk API with typed stall reasons"),
      "start-dev",
      "Succeeded",
      95,
      [attempt("run-done-399", 94, new SucceededAttemptView(), "hz-worker-1", 52)],
      402,
    ),
    run(
      "run-review-396",
      link(396, "Reviewer pass on the harvest"),
      "review-fix",
      "Succeeded",
      160,
      [attempt("run-review-396", 159, new SucceededAttemptView(), "local", 120)],
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
          new FailedAttemptView({
            failure: new BlockedFailureView({ message: "Main fails its gate before any change." }),
          }),
          "local",
          262,
        ),
      ],
    ),
  ];

  const desk = new DeskView({
    running: [
      new RunningAttemptView({
        run: runningDesk,
        attempt: runningDesk.attempts[0] ?? attempt("missing", 0, null),
        item: desk403,
        lastActivityAt: ago(1),
        warnings: [],
      }),
      new RunningAttemptView({
        run: runningBoard,
        attempt: runningBoard.attempts[0] ?? attempt("missing", 0, null),
        item: board388,
        lastActivityAt: ago(14),
        warnings: [
          new WorkerSilentView({ worker: WorkerName.make("local"), lastAnsweredAt: ago(13) }),
          new ProviderRetryingView({
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
      stalled("start-dev", approval, new AwaitingApprovalView({ run: waitingRun })),
      stalled("start-dev", question, new SuppressedForOperatorView({ run: questionRun })),
      stalled("start-dev", budget, new CycleBudgetUsedUpView({ ask })),
      stalled("start-dev", failed, new RunFailedView({ run: failedRun })),
      ...canceledRuns.map((canceledRun, index) =>
        stalled(
          "start-dev",
          canceled[index] ?? approval,
          new ClosedUnchangedView({ run: canceledRun }),
        ),
      ),
      stalled("review-fix", paused, new LoopPausedView()),
      stalled(
        "start-dev",
        unstopped,
        new WaitingForStopView({
          run: retryingRun,
          stop: new UnconfirmedStopView({
            runId: retryingRun.id,
            attemptNumber: AttemptNumber.make(1),
            worker: WorkerName.make("local"),
          }),
        }),
      ),
      stalled("start-dev", queued, new QueuedForWorkerView({ run: queuedRun, ahead: 2 })),
      stalled("start-dev", fresh, new AwaitingPollView()),
    ],
    lastOutcomes: [...outcomes, ...canceledRuns].map(
      (closed) =>
        new ClosedRunView({
          run: closed,
          item: links.get(closed.itemKey) ?? null,
          closedAt: closed.attempts.at(-1)?.endedAt ?? closed.openedAt,
        }),
    ),
    workers: [
      new WorkerView({
        name: WorkerName.make("local"),
        slots: new WorkerSlotsView({ capacity: 2, leased: 1 }),
        preflight: new PassedCheckView({ checkedAt: ago(420) }),
      }),
      new WorkerView({
        name: WorkerName.make("hz-worker-1"),
        slots: new WorkerSlotsView({ capacity: 1, leased: 1 }),
        preflight: new FailedCheckView({
          checkedAt: ago(400),
          capability: "harness-login",
          message: "Codex is not logged in on Worker hz-worker-1",
        }),
      }),
    ],
    polls: [new RepositoryPollView({ repository: deskRepository, polledAt: ago(2) })],
  });

  const overview = new ReadyOverview({
    projects: [
      new ProjectView({
        repository: deskRepository,
        status: "needs-you",
        runs: [runningDesk, runningBoard, waitingRun, questionRun, failedRun, ...canceledRuns],
        board: new BoardView({ lanes: [], failures: [] }),
        labels: [],
        preflightFindings: [],
      }),
    ],
    loops: [
      new LoopView({
        name: LoopName.make("start-dev"),
        trigger: "issue",
        agent: AgentName.make("developer"),
        paused: false,
      }),
      new LoopView({
        name: LoopName.make("review-fix"),
        trigger: "pr",
        agent: AgentName.make("reviewer"),
        paused: true,
      }),
    ],
    needsYou: [
      new ApprovalNeed({
        id: "approval:run-approval-410",
        repository: deskRepository,
        runId: waitingRun.id,
        loop: waitingRun.loop,
        item: approval,
      }),
      new RunFailureNeed({
        id: "run-failure:run-question-367",
        repository: deskRepository,
        runId: questionRun.id,
        loop: questionRun.loop,
        failure: new QuestionFailureView({
          question: "Should Done and Unmapped stay lanes or become filters?",
        }),
      }),
      new CycleBudgetNeed({
        id: `cycle-budget:${ask.id}`,
        ask,
        itemLabel: `${deskRepository}#355`,
        itemUrl: budget.url,
      }),
    ],
  });

  const empty = new DeskView({
    running: [],
    notMoving: [],
    lastOutcomes: [],
    workers: desk.workers.map(
      (worker) =>
        new WorkerView({
          ...worker,
          slots: new WorkerSlotsView({ capacity: worker.slots.capacity, leased: 0 }),
        }),
    ),
    polls: desk.polls,
  });

  return { desk, empty, overview };
};

const MINUTE = 60_000;
const DAY = 86_400_000;

const durations = (count: number, median: number, p90: number, mean: number) =>
  new DurationSummaryView({
    count,
    meanMillis: Math.round(mean * MINUTE),
    medianMillis: Math.round(median * MINUTE),
    p90Millis: Math.round(p90 * MINUTE),
  });

const outcomes = (succeeded: number, failed: number, canceled: number) =>
  new OutcomeCountsView({ succeeded, failed, canceled });

const usage = (measured: number, claudePlan: number, chatgptPlan: number, priced: number) =>
  new UsageSummaryView({
    measured,
    tokens: TokenCount.make(claudePlan + chatgptPlan),
    meanTokens: TokenCount.make(Math.round((claudePlan + chatgptPlan) / measured)),
    pools: [
      new PoolTokensView({ pool: "claudePlan", tokens: TokenCount.make(claudePlan) }),
      new PoolTokensView({ pool: "chatgptPlan", tokens: TokenCount.make(chatgptPlan) }),
    ],
    cost:
      priced === 0
        ? null
        : new CostSummaryView({
            usd: UsdAmount.make(priced * 3.1),
            meanUsd: UsdAmount.make(3.1),
            estimate: true,
            priced,
          }),
  });

/** Returns the statistics of `window` with no closed Run; periods end on the UTC day of `now`. */
export const emptyStatisticsFixture = (now: number, window: StatisticsWindow) => {
  const today = now - (now % DAY);
  return new StatisticsView({
    window,
    from: new Date(today).toISOString(),
    to: new Date(now).toISOString(),
    bucket: "day",
    runs: outcomes(0, 0, 0),
    runTime: null,
    attemptTime: null,
    unmeasuredAttempts: 0,
    usage: new UsageSummaryView({
      measured: 0,
      tokens: TokenCount.make(0),
      meanTokens: null,
      pools: [],
      cost: null,
    }),
    throughput: [
      new ThroughputPeriodView({
        start: new Date(today).toISOString().slice(0, 10),
        ...outcomes(0, 0, 0),
      }),
    ],
    firstPass: new FirstPassView({ merged: 0, firstPass: 0 }),
    leadTime: null,
    loops: [],
    agents: [],
    brains: [],
    queueWait: [],
    attemptsPerRun: [],
    utilization: [
      new WorkerUtilizationView({
        worker: WorkerName.make("local"),
        slots: 2,
        occupiedMillis: 0,
        share: 0,
      }),
    ],
    needsAttention: new NeedsAttentionView({
      approvals: 0,
      failures: 0,
      periods: [],
      approvalWait: null,
      retryWait: null,
    }),
  });
};

/**
 * Returns the statistics of the desk's Loops, Agents, and Workers over the 7 or 30 days that end
 * on the UTC day of `now`; the 30-day figures are three times the 7-day ones.
 */
export const statisticsFixture = (now: number, window: "7d" | "30d") => {
  const days = window === "7d" ? 7 : 30;
  const scale = window === "7d" ? 1 : 3;
  const from = now - (now % DAY) - (days - 1) * DAY;
  const periods = Array.from({ length: days }, (_, index) =>
    new Date(from + index * DAY).toISOString().slice(0, 10),
  );
  const busiest = days - 3;
  const developer = {
    outcomes: outcomes(6 * scale, 2 * scale, scale),
    time: durations(9 * scale, 39, 70, 41),
    usage: usage(9 * scale, 3_000_000 * scale, 0, 6 * scale),
  };
  const reviewer = {
    outcomes: outcomes(3 * scale, 0, 0),
    time: durations(3 * scale, 5, 9, 6),
    usage: usage(3 * scale, 600_000 * scale, 600_000 * scale, 2 * scale),
  };
  return new StatisticsView({
    window,
    from: new Date(from).toISOString(),
    to: new Date(now).toISOString(),
    bucket: "day",
    runs: outcomes(9 * scale, 2 * scale, scale),
    runTime: durations(12 * scale, 18, 64, 26),
    attemptTime: durations(14 * scale, 14, 52, 19),
    unmeasuredAttempts: 0,
    usage: usage(12 * scale, 3_600_000 * scale, 600_000 * scale, 8 * scale),
    throughput: periods.map(
      (start, index) =>
        new ThroughputPeriodView({
          start,
          ...(index === busiest
            ? outcomes(5 * scale, 2 * scale, 0)
            : index > busiest
              ? outcomes(2 * scale, 0, index === days - 1 ? scale : 0)
              : outcomes(0, 0, 0)),
        }),
    ),
    firstPass: new FirstPassView({ merged: 4 * scale, firstPass: 3 * scale }),
    leadTime: durations(4 * scale, 130, 300, 180),
    loops: [
      new LoopStatisticsView({ loop: LoopName.make("start-dev"), ...developer }),
      new LoopStatisticsView({ loop: LoopName.make("review-fix"), ...reviewer }),
    ],
    agents: [
      new AgentStatisticsView({ agent: AgentName.make("developer"), ...developer }),
      new AgentStatisticsView({ agent: AgentName.make("reviewer"), ...reviewer }),
    ],
    brains: [
      new BrainStatisticsView({
        brain,
        outcomes: outcomes(9 * scale, 4 * scale, scale),
        time: durations(14 * scale, 14, 52, 19),
        usage: usage(14 * scale, 3_600_000 * scale, 600_000 * scale, 8 * scale),
      }),
    ],
    queueWait: [
      new WorkerQueueWaitView({
        worker: WorkerName.make("hz-worker-1"),
        wait: durations(4, 2, 9, 3),
      }),
      new WorkerQueueWaitView({
        worker: WorkerName.make("local"),
        wait: durations(10, 0.1, 1, 0.5),
      }),
    ],
    attemptsPerRun: [
      new AttemptCountView({ attempts: 1, runs: 10 * scale }),
      new AttemptCountView({ attempts: 2, runs: scale }),
      new AttemptCountView({ attempts: 3, runs: scale }),
    ],
    utilization: [
      new WorkerUtilizationView({
        worker: WorkerName.make("local"),
        slots: 2,
        occupiedMillis: 900 * MINUTE,
        share: 0.38,
      }),
      new WorkerUtilizationView({
        worker: WorkerName.make("hz-worker-1"),
        slots: 1,
        occupiedMillis: 180 * MINUTE,
        share: 0.12,
      }),
    ],
    needsAttention: new NeedsAttentionView({
      approvals: 3 * scale,
      failures: 2 * scale,
      periods: periods.map(
        (start, index) =>
          new NeedsAttentionPeriodView({
            start,
            approvals: index === busiest ? 3 * scale : 0,
            failures: index === days - 1 ? 2 * scale : 0,
          }),
      ),
      approvalWait: durations(3 * scale, 14, 120, 40),
      retryWait: null,
    }),
  });
};
