import { LabelLaneSource, LaneName, StateLaneSource } from "@usine/config/board";
import { GitHubLabelName } from "@usine/config/label";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AttemptId, AttemptNumber, AttemptTask } from "@usine/core/attempt";
import { ItemKey, ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import {
  AgentFailureView,
  AttemptView,
  BoardItemLink,
  BoardLaneId,
  BoardTaskView,
  BoardView,
  FailedAttemptView,
  LabelView,
  ProjectView,
  ReadOnlyBoardLaneView,
  ReadyOverview,
  RunView,
  SucceededAttemptView,
  WritableBoardLaneView,
} from "@usine/orchestrator/operator";

// The browser test server answers lane writes for this repository only.
const boardRepository = RepositoryName.make("board-test/repo");

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const link = (number: number, kind: "issue" | "pr", title: string) =>
  new BoardItemLink({
    itemKey: ItemKey.make(`${boardRepository}:${number}`),
    kind,
    number: ItemNumber.make(number),
    title,
    url: `https://github.com/${boardRepository}/${kind === "pr" ? "pull" : "issues"}/${number}`,
  });

const attempt = (
  number: number,
  startedAt: string,
  failure: string | null | "running",
  endedAt: string | null = null,
) =>
  new AttemptView({
    task: AttemptTask.make("Implement the issue"),
    agent: AgentName.make("developer"),
    operatorIntervened: false,
    id: AttemptId.make(`attempt-${number}-${startedAt}`),
    number: AttemptNumber.make(number),
    worker: WorkerName.make("local"),
    brain: new BrainSpec({ harness: "codex", model: ModelId.make("gpt-5.6-sol"), effort: "high" }),
    startedAt,
    outcome:
      failure === "running"
        ? null
        : failure === null
          ? new SucceededAttemptView()
          : new FailedAttemptView({ failure: new AgentFailureView({ message: failure }) }),
    endedAt,
    salvage: null,
  });

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
    loopPaused: false,
    openedAt: minutesAgo(minutes),
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
    canRunAgain: false,
  });

const task = (
  members: readonly [BoardItemLink, ...ReadonlyArray<BoardItemLink>],
  labels: ReadonlyArray<string>,
  runs: ReadonlyArray<RunView> = [],
  extra: { readonly conflicting?: boolean; readonly state?: BoardTaskView["state"] } = {},
) => {
  const current = members.at(-1) ?? members[0];
  const preferred =
    [...runs].reverse().find((run) => run.canApprove || run.canResolveFailure) ?? runs.at(-1);
  return new BoardTaskView({
    ...current,
    title: members[0].title,
    state: extra.state ?? (current.kind === "pr" ? "pr-open" : "issue-open"),
    labels: labels.map((label) => GitHubLabelName.make(label)),
    items: members,
    runs,
    run: preferred ?? null,
    needsYou: runs.some((run) => run.canApprove || run.canResolveFailure),
    conflicting: extra.conflicting ?? false,
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
const shipped = link(5, "issue", "Show the salvage branch on failed Attempts");
const dropped = link(18, "issue", "Cache the label catalog per repository");
const flaky = link(
  15,
  "issue",
  "Reader restore test is flaky on narrow viewports when the sidebar is collapsed and the transcript history spans several earlier pages",
);

/** A Board with every card shape: lane-only and overflowing labels, a linked PR, and open, waiting, failed, canceled and finished Runs. */
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
    ],
    preflightFindings: [],
    board: new BoardView({
      failures: [],
      lanes: [
        writable("Backlog", "backlog", [
          task([link(12, "issue", "Document the cycle budget reset")], ["backlog", "docs"]),
          task([flaky], ["backlog", "bug", "priority", "ci", "flaky"]),
          task(
            [dropped],
            ["backlog"],
            [run("run-dropped", dropped, "implement", "Canceled", 1440, [])],
          ),
        ]),
        writable("Ready", "ready-for-agent", [
          task(
            [salvage],
            ["ready-for-agent", "bug"],
            [run("run-salvage", salvage, "implement", "Waiting", 3, [])],
          ),
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
          ),
        ]),
        writable("Review", "review", [
          task(
            [pinned],
            ["review"],
            [
              run("run-pinned", pinned, "review", "Failed", 95, [
                attempt(
                  1,
                  minutesAgo(95),
                  "The required check lint failed on the pinned commit",
                  minutesAgo(80),
                ),
              ]),
            ],
            { conflicting: true },
          ),
        ]),
        new ReadOnlyBoardLaneView({
          id: BoardLaneId.make("authored:done"),
          name: LaneName.make("Done"),
          sources: [new StateLaneSource({ state: "issue-closed" })],
          origin: "authored",
          items: [
            task(
              [shipped],
              [],
              [
                run("run-shipped", shipped, "implement", "Succeeded", 2 * 1440, [
                  attempt(1, minutesAgo(2 * 1440), null, minutesAgo(2 * 1440 - 30)),
                ]),
              ],
              { state: "issue-closed" },
            ),
          ],
        }),
      ],
    }),
  });

export const boardOverview = () =>
  new ReadyOverview({ projects: [boardProject()], loops: [], needsYou: [] });
