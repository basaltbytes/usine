import { LabelLaneSource, LaneName, StateLaneSource } from "@usine/config/board";
import { GitHubLabelName } from "@usine/config/label";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AttemptId, AttemptNumber, AttemptTask } from "@usine/core/attempt";
import { ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { OperatorLogin } from "@usine/core/operator";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { RunAgain } from "@usine/core/run/again";
import { ApprovalSource } from "@usine/core/run/approval";
import { WorkerName } from "@usine/core/worker";
import {
  AgentFailureView,
  ApprovalView,
  AttemptView,
  BoardItemLink,
  BoardLaneId,
  BoardTaskView,
  BoardView,
  CanceledAttemptView,
  FailedAttemptView,
  LabelView,
  ProjectView,
  ReadOnlyBoardLaneView,
  ReadyOverview,
  RunView,
  SucceededAttemptView,
  TaskCommentView,
  TaskItemView,
  TaskLaneView,
  TaskView,
  WritableBoardLaneView,
  LocalWorkerAccess,
} from "@usine/orchestrator/operator";
import { GitHubItemKey } from "@usine/orchestrator/polling-triggers";
import { Option, Schema } from "effect";

export const taskRepository = RepositoryName.make("basaltbytes/usine");

const keyOf = (number: number) =>
  Schema.encodeSync(GitHubItemKey)(["github", taskRepository, ItemNumber.make(number)]);

const item = (
  number: number,
  kind: "issue" | "pr",
  title: string,
  state: TaskItemView["state"],
  labels: ReadonlyArray<string> = [],
  conflicting = false,
) =>
  new TaskItemView({
    itemKey: keyOf(number),
    kind,
    number: ItemNumber.make(number),
    title,
    url: `https://github.com/${taskRepository}/${kind === "pr" ? "pull" : "issues"}/${number}`,
    state,
    labels: labels.map((label) => GitHubLabelName.make(label)),
    conflicting,
  });

const brain = new BrainSpec({
  harness: "codex",
  model: ModelId.make("gpt-5.6-sol"),
  effort: "high",
});

const attempt = (
  runId: string,
  number: number,
  startedAt: string,
  outcome: AttemptView["outcome"],
  endedAt: string | null,
) =>
  new AttemptView({
    id: AttemptId.make(`${runId}/${number}`),
    number: AttemptNumber.make(number),
    worker: WorkerName.make("local"),
    workerAccess: new LocalWorkerAccess(),
    brain,
    task: AttemptTask.make("Do the work."),
    agent: AgentName.make("developer"),
    operatorIntervened: false,
    startedAt,
    outcome,
    endedAt,
    salvage: null,
  });

const run = (
  id: string,
  number: number,
  loop: string,
  state: RunView["state"],
  openedAt: string,
  attempts: ReadonlyArray<AttemptView>,
  extra: Partial<
    Pick<RunView, "approval" | "runAgain" | "pullRequestUrl" | "canResolveFailure">
  > = {},
) =>
  new RunView({
    id: RunId.make(id),
    itemKey: keyOf(number),
    loop: LoopName.make(loop),
    repository: taskRepository,
    agent: AgentName.make(loop === "review-pr" ? "reviewer" : "developer"),
    state,
    loopPaused: false,
    openedAt,
    task: "Do the work.",
    attempts,
    approval: extra.approval ?? null,
    runAgain: extra.runAgain ?? null,
    resultMessage: null,
    pullRequestUrl: extra.pullRequestUrl ?? null,
    canApprove: state === "Waiting",
    canRetry: state === "Failed",
    canResolveFailure: extra.canResolveFailure ?? state === "Failed",
    canCancel: state === "Waiting" || state === "Queued" || state === "Running",
    canRunAgain: state === "Succeeded" || state === "Canceled",
  });

const issue = item(40, "issue", "Rework the conversation reader", "issue-open", ["bug"]);
const merged = item(41, "pr", "Plan the reader rework", "pr-merged");
const conflicting = item(
  42,
  "pr",
  "Fix the flaky reader test",
  "pr-open",
  ["ready-for-review", "ui"],
  true,
);

/** Issue #40 with a merged and an open, conflicting pull request, and a Run of every outcome. */
export const fullTask = () =>
  new TaskView({
    repository: taskRepository,
    number: ItemNumber.make(40),
    title: issue.title,
    current: conflicting.itemKey,
    lane: new TaskLaneView({
      id: BoardLaneId.make("authored:In review"),
      name: LaneName.make("In review"),
    }),
    needsYou: true,
    items: [issue, merged, conflicting],
    runs: [
      run("run-approve", 42, "fix-ci", "Waiting", "2026-10-06T09:00:00.000Z", []),
      run(
        "run-again",
        42,
        "fix-ci",
        "Running",
        "2026-10-06T08:58:00.000Z",
        [attempt("run-again", 1, "2026-10-06T08:59:00.000Z", null, null)],
        {
          runAgain: new RunAgain({
            from: RunId.make("run-canceled"),
            requestedBy: Option.some(OperatorLogin.make("PhilDL")),
          }),
        },
      ),
      run("run-canceled", 42, "fix-ci", "Canceled", "2026-10-05T09:00:00.000Z", [
        attempt(
          "run-canceled",
          1,
          "2026-10-05T09:00:00.000Z",
          new CanceledAttemptView(),
          "2026-10-05T09:05:00.000Z",
        ),
      ]),
      run(
        "run-review",
        41,
        "review-pr",
        "Succeeded",
        "2026-10-04T09:00:00.000Z",
        [
          attempt(
            "run-review",
            1,
            "2026-10-04T09:00:00.000Z",
            new SucceededAttemptView(),
            "2026-10-04T09:12:00.000Z",
          ),
        ],
        {
          approval: new ApprovalView({
            approvedAt: "2026-10-04T08:58:00.000Z",
            source: new ApprovalSource({
              channel: "github-ask",
              approver: Option.some(OperatorLogin.make("PhilDL")),
            }),
          }),
        },
      ),
      run("run-dev", 40, "start-dev", "Failed", "2026-10-03T09:00:00.000Z", [
        attempt(
          "run-dev",
          1,
          "2026-10-03T09:00:00.000Z",
          new FailedAttemptView({
            failure: new AgentFailureView({ message: "The lint check failed" }),
          }),
          "2026-10-03T09:30:00.000Z",
        ),
        attempt(
          "run-dev",
          2,
          "2026-10-03T10:00:00.000Z",
          new FailedAttemptView({
            failure: new AgentFailureView({ message: "The required check lint failed again" }),
          }),
          "2026-10-03T10:30:00.000Z",
        ),
      ]),
      run(
        "run-plan",
        40,
        "plan",
        "Succeeded",
        "2026-10-02T09:00:00.000Z",
        [
          attempt(
            "run-plan",
            1,
            "2026-10-02T09:00:00.000Z",
            new SucceededAttemptView(),
            "2026-10-02T09:20:00.000Z",
          ),
        ],
        { pullRequestUrl: merged.url },
      ),
    ],
    comments: [
      new TaskCommentView({
        runId: RunId.make("run-review"),
        kind: "review",
        url: `${merged.url}#pullrequestreview-7`,
        postedAt: "2026-10-04T09:05:00.000Z",
        attemptEndedAt: "2026-10-04T09:12:00.000Z",
      }),
      new TaskCommentView({
        runId: RunId.make("run-plan"),
        kind: "issue-comment",
        url: `${issue.url}#issuecomment-1`,
        postedAt: null,
        attemptEndedAt: "2026-10-02T09:20:00.000Z",
      }),
    ],
  });

const quiet = item(12, "issue", "Document the cycle budget reset", "issue-open", ["backlog"]);

/** Issue #12 alone in the Backlog: no Run, no pull request, nothing posted. */
export const quietTask = () =>
  new TaskView({
    repository: taskRepository,
    number: ItemNumber.make(12),
    title: quiet.title,
    current: quiet.itemKey,
    lane: new TaskLaneView({
      id: BoardLaneId.make("authored:Backlog"),
      name: LaneName.make("Backlog"),
    }),
    needsYou: false,
    items: [quiet],
    runs: [],
    comments: [],
  });

const card = (task: TaskView) => {
  const current = task.items.find(({ itemKey }) => itemKey === task.current) ?? task.items[0];
  return new BoardTaskView({
    itemKey: current.itemKey,
    kind: current.kind,
    number: current.number,
    title: task.title,
    url: current.url,
    state: current.state,
    updatedAt: "2026-10-20T09:00:00Z",
    labels: current.labels,
    items: task.items.map(
      ({ itemKey, kind, number, title, url }) =>
        new BoardItemLink({ itemKey, kind, number, title, url }),
    ),
    pullRequest: null,
    runs: [...task.runs].reverse(),
    run: task.runs[0] ?? null,
    needsYou: task.needsYou,
    conflicting: current.conflicting,
    loops: [],
  });
};

const writable = (name: string, label: string, tasks: ReadonlyArray<TaskView>) =>
  new WritableBoardLaneView({
    id: BoardLaneId.make(`authored:${name}`),
    name: LaneName.make(name),
    sources: [new LabelLaneSource({ label: GitHubLabelName.make(label) })],
    labels: [GitHubLabelName.make(label)],
    origin: "authored",
    items: tasks.map(card),
  });

/** The overview whose Board places both Tasks, with Ready as another lane a move can target. */
export const taskOverview = () =>
  new ReadyOverview({
    loops: [],
    needsYou: [],
    projects: [
      new ProjectView({
        repository: taskRepository,
        status: "needs-you",
        runs: [],
        labels: [
          new LabelView({ name: GitHubLabelName.make("bug"), color: "d73a4a", description: null }),
          new LabelView({ name: GitHubLabelName.make("ui"), color: "a2eeef", description: null }),
          new LabelView({
            name: GitHubLabelName.make("ready-for-review"),
            color: "d93f0b",
            description: null,
          }),
        ],
        preflightFindings: [],
        board: new BoardView({
          failures: [],
          lanes: [
            writable("Backlog", "backlog", [quietTask()]),
            writable("Ready", "ready-for-agent", []),
            writable("In review", "ready-for-review", [fullTask()]),
            new ReadOnlyBoardLaneView({
              id: BoardLaneId.make("authored:Done"),
              name: LaneName.make("Done"),
              sources: [new StateLaneSource({ state: "issue-closed" })],
              origin: "authored",
              items: [],
            }),
          ],
        }),
      }),
    ],
  });
