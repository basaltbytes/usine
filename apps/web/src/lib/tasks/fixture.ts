import { RunSummaryView, AttemptSummaryView } from "@usine/orchestrator/operator";
import { LabelLaneSource, LaneName, StateLaneSource } from "@usine/config/board";
import { GitHubLabelName } from "@usine/core/label";
import { AgentName } from "@usine/core/agent";
import { Harness, BrainSpec, ModelId } from "@usine/core/agent/brain";
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
  boardRunSummary,
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
import { taskUsageOf } from "~/lib/projects/fixture";

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
  TaskItemView.make({
    itemKey: keyOf(number),
    kind,
    number: ItemNumber.make(number),
    title,
    url: `https://github.com/${taskRepository}/${kind === "pr" ? "pull" : "issues"}/${number}`,
    state,
    labels: labels.map((label) => GitHubLabelName.make(label)),
    conflicting,
  });

const brain = BrainSpec.make({
  harness: Harness.make("codex"),
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
  AttemptView.make({
    id: AttemptId.make(`${runId}/${number}`),
    number: AttemptNumber.make(number),
    worker: WorkerName.make("local"),
    workerAccess: LocalWorkerAccess.make(),
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
  RunView.make({
    agentBrain: brain,
    id: RunId.make(id),
    itemKey: keyOf(number),
    loop: LoopName.make(loop),
    repository: taskRepository,
    agent: AgentName.make(loop === "review-pr" ? "reviewer" : "developer"),
    state,
    loopPaused: false,
    openedAt,
    closedAt:
      state === "Succeeded" || state === "Failed" || state === "Canceled"
        ? (attempts.at(-1)?.endedAt ?? openedAt)
        : null,
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

/** Returns issue #40 with a merged pull request, an open conflicting pull request, and a Run of every outcome. */
export const fullTask = () =>
  TaskView.make({
    repository: taskRepository,
    number: ItemNumber.make(40),
    title: issue.title,
    current: conflicting.itemKey,
    lane: TaskLaneView.make({
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
          runAgain: RunAgain.make({
            from: RunId.make("run-canceled"),
            requestedBy: Option.some(OperatorLogin.make("PhilDL")),
          }),
        },
      ),
      run(
        "run-canceled",
        42,
        "fix-ci",
        "Canceled",
        "2026-10-05T09:00:00.000Z",
        [
          attempt(
            "run-canceled",
            1,
            "2026-10-05T09:00:00.000Z",
            CanceledAttemptView.make(),
            "2026-10-05T09:05:00.000Z",
          ),
        ],
        { pullRequestUrl: conflicting.url },
      ),
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
            SucceededAttemptView.make(),
            "2026-10-04T09:12:00.000Z",
          ),
        ],
        {
          approval: ApprovalView.make({
            approvedAt: "2026-10-04T08:58:00.000Z",
            source: ApprovalSource.make({
              channel: "ui",
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
          FailedAttemptView.make({
            failure: AgentFailureView.make({ message: "The lint check failed" }),
          }),
          "2026-10-03T09:30:00.000Z",
        ),
        attempt(
          "run-dev",
          2,
          "2026-10-03T10:00:00.000Z",
          FailedAttemptView.make({
            failure: AgentFailureView.make({ message: "The required check lint failed again" }),
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
            SucceededAttemptView.make(),
            "2026-10-02T09:20:00.000Z",
          ),
        ],
        { pullRequestUrl: merged.url },
      ),
    ],
    comments: [
      TaskCommentView.make({
        runId: RunId.make("run-review"),
        kind: "review",
        url: `${merged.url}#pullrequestreview-7`,
        postedAt: "2026-10-04T09:05:00.000Z",
        attemptEndedAt: "2026-10-04T09:12:00.000Z",
      }),
      TaskCommentView.make({
        runId: RunId.make("run-plan"),
        kind: "issue-comment",
        url: `${issue.url}#issuecomment-1`,
        postedAt: null,
        attemptEndedAt: "2026-10-02T09:20:00.000Z",
      }),
    ],
  });

const quiet = item(12, "issue", "Document the cycle budget reset", "issue-open", ["backlog"]);

/** Returns issue #12 in the Backlog with no Run, pull request, or comment. */
export const quietTask = () =>
  TaskView.make({
    repository: taskRepository,
    number: ItemNumber.make(12),
    title: quiet.title,
    current: quiet.itemKey,
    lane: TaskLaneView.make({
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
  const items = task.items.map(({ itemKey, kind, number, title, url, state }) =>
    BoardItemLink.make({ itemKey, kind, number, title, url, state }),
  );
  const runs = task.runs.map((run) =>
    RunSummaryView.make({
      ...run,
      attempts: run.attempts.map((attempt) => AttemptSummaryView.make(attempt)),
    }),
  );
  return BoardTaskView.make({
    repository: task.repository,
    itemKey: current.itemKey,
    kind: current.kind,
    number: current.number,
    title: task.title,
    url: current.url,
    state: current.state,
    labels: current.labels,
    items,
    pullRequest: null,
    ...boardRunSummary([...runs].reverse(), runs[0] ?? null, items),
    run: runs[0] ?? null,
    needsYou: task.needsYou,
    conflicting: current.conflicting,
    loops: [],
    usage: taskUsageOf(task.runs),
  });
};

const writable = (name: string, label: string, tasks: ReadonlyArray<TaskView>) =>
  WritableBoardLaneView.make({
    id: BoardLaneId.make(`authored:${name}`),
    name: LaneName.make(name),
    sources: [LabelLaneSource.make({ label: GitHubLabelName.make(label) })],
    labels: [GitHubLabelName.make(label)],
    origin: "authored",
    items: tasks.map(card),
  });

/** Returns an overview whose Board has both Tasks, plus a Ready lane as a move target. */
export const taskOverview = () =>
  ReadyOverview.make({
    loops: [],
    needsYou: [],
    projects: [
      ProjectView.make({
        repository: taskRepository,
        status: "needs-you",
        runs: [],
        labels: [
          LabelView.make({ name: GitHubLabelName.make("bug"), color: "d73a4a", description: null }),
          LabelView.make({ name: GitHubLabelName.make("ui"), color: "a2eeef", description: null }),
          LabelView.make({
            name: GitHubLabelName.make("ready-for-review"),
            color: "d93f0b",
            description: null,
          }),
        ],
        preflightFindings: [],
        board: BoardView.make({
          failures: [],
          lanes: [
            writable("Backlog", "backlog", [quietTask()]),
            writable("Ready", "ready-for-agent", []),
            writable("In review", "ready-for-review", [fullTask()]),
            ReadOnlyBoardLaneView.make({
              id: BoardLaneId.make("authored:Done"),
              name: LaneName.make("Done"),
              sources: [StateLaneSource.make({ state: "issue-closed" })],
              origin: "authored",
              items: [],
            }),
          ],
        }),
      }),
    ],
  });
