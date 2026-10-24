import { AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { ProviderRetries } from "@usine/core/agent/session";
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
  WorkerSilentView,
  WorkerSlotsView,
  WorkerView,
  LocalWorkerAccess,
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
      stalled("start-dev", queued, new QueuedForWorkerView({ run: queuedRun })),
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
