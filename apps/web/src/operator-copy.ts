import { BrainSpec } from "@usine/core/agent/brain";
import type { BillingPool } from "@usine/core/agent/session";
import type { SalvagePushed } from "@usine/core/attempt/salvage";
import type { AttemptStart } from "@usine/core/attempt/start";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import type { ApprovalChannel } from "@usine/core/run/approval";
import type { InstanceReload } from "@usine/orchestrator/current-instance";
import type {
  BoardItemLink,
  FailureView,
  LoopView,
  NeedView,
  RunView,
} from "@usine/orchestrator/operator";
import { Match, Option } from "effect";
import type { BoardMoveProgress } from "./board/moves.ts";
import type { RunActionRequest } from "./run-actions.ts";
import type { QueuedFor } from "./run-transcript/model.ts";

export interface NeedCopy {
  readonly title: string;
  readonly detail: string;
  readonly repository: RepositoryName | null;
  readonly runId: RunId | null;
}

export const brainLine = (brain: BrainSpec): string =>
  `${brain.harness} · ${brain.model} · ${brain.effort}`;

/** Labels of the Run actions that the Run drawer and the Board card menu both offer. */
export const runActionLabel = {
  approve: "Approve",
  retry: "Retry",
  runAgain: "Run again",
  cancel: "Cancel run",
  confirmCancel: "Confirm cancel",
  keepRunning: "Keep running",
} as const;

/** What a screen says while a Run again request is sent. */
export const runAgainProgress = "Opening a run…";

/** Why running a Run again opened no Run, and what the operator does next. */
export const runAgainBlocked = "No run opened: cycle budget used up. Reset it in Needs attention";

export const itemKindLabel = (kind: BoardItemLink["kind"]): string =>
  kind === "pr" ? "Pull request" : "Issue";

/** What opens a Loop's Runs, named like the Item kinds on Board cards. */
export const triggerLabel = (trigger: LoopView["trigger"]): string => {
  switch (trigger) {
    case "issue":
      return "Issue";
    case "pr":
      return "PR";
    case "schedule":
      return "Schedule";
    default:
      return trigger;
  }
};

/** How long ago `since` happened, in the largest whole unit: `now`, `12m`, `3h`, or `2d`. */
export const elapsedLabel = (since: string, now: number = Date.now()): string => {
  const elapsed = Math.max(0, now - Date.parse(since));
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
};

/** How long ago `instant` was, as a phrase: `just now` or `12m ago`. */
export const agoLabel = (instant: string, now: number): string => {
  const elapsed = elapsedLabel(instant, now);
  return elapsed === "now" ? "just now" : `${elapsed} ago`;
};

/** An instant as a local date and minute, such as `2026-10-18 17:27`. */
export const timestampLabel = (instant: string): string => {
  const date = new Date(instant);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** An instant's local day and minute, such as `15 Oct 19:30`. */
export const dayTimeLabel = (instant: string): string => {
  const date = new Date(instant);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${two(date.getHours())}:${two(date.getMinutes())}`;
};

/** An instant's local day, such as `22 Oct`. */
export const dayLabel = (date: Date): string => `${date.getDate()} ${MONTHS[date.getMonth()]}`;

/** An instant's local time of day to the second, such as `19:31:03`. */
export const clockLabel = (instant: string): string => {
  const date = new Date(instant);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
};

/** A span of time in its largest useful units: `25s`, `22 min`, or `1 h 4 min`. */
export const durationLabel = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return minutes % 60 === 0
    ? `${Math.floor(minutes / 60)} h`
    : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};

/** Why an Attempt began, in a phrase: `From the event`, `Retried by PhilDL`, `Retried after an infrastructure failure`. */
export const attemptStartLabel = (start: AttemptStart): string =>
  Match.valueTags(start, {
    Event: () => "From the event",
    OperatorRetry: ({ operator }) =>
      Option.match(operator, { onNone: () => "Retried", onSome: (login) => `Retried by ${login}` }),
    EditAndRetry: ({ operator }) =>
      Option.match(operator, {
        onNone: () => "Edited and retried",
        onSome: (login) => `Edited and retried by ${login}`,
      }),
    InfraRetry: () => "Retried after an infrastructure failure",
    AfterRestart: () => "Started again after a restart",
  });

/** A token count in its largest useful unit: `950`, `27.3K`, `1.2M`. */
export const tokensLabel = (tokens: number): string =>
  new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(tokens);

/** Dollars to the cent, such as `$1.25`, or `under $0.01` for less than a cent. */
export const usdLabel = (usd: number): string =>
  usd > 0 && usd < 0.005 ? "under $0.01" : `$${usd.toFixed(2)}`;

/** How a Run stands, in one phrase: `Failed after 3 attempts`, `Waiting for approval`, `Running, attempt 2`. */
export const runStateLine = (run: Pick<RunView, "state" | "attempts">): string => {
  const attempts = run.attempts.length;
  const after =
    attempts === 0 ? "" : ` after ${attempts} ${attempts === 1 ? "attempt" : "attempts"}`;
  switch (run.state) {
    case "Pending":
      return "Pending";
    case "Waiting":
      return "Waiting for approval";
    case "Queued":
      return "Queued, no free worker";
    case "Running":
      return `Running, attempt ${run.attempts.at(-1)?.number ?? 1}`;
    case "Succeeded":
      return attempts > 1 ? `Succeeded${after}` : "Succeeded";
    case "Failed":
      return `Failed${after}`;
    case "Canceled":
      return `Canceled${after}`;
  }
};

/** The typed reason of an Attempt failure, in words. */
export const failureReason = (failure: FailureView): string =>
  Match.valueTags(failure, {
    InfraFailure: () => "Infrastructure failure",
    DefectFailure: () => "Executor defect; retry explicitly",
    AgentFailure: () => "Agent failure",
    BlockedFailure: () => "Agent blocked",
    QuestionFailure: () => "Question from the agent",
    RunawayFailure: () => "Runaway guard",
    ChildSessionBudgetFailure: () => "Child session budget exhausted",
  });

/** A coding harness by its product name. */
export const harnessLabel = (harness: BrainSpec["harness"]): string =>
  ({ claude: "Claude Code", codex: "Codex", pi: "Pi" })[harness];

/** A billing pool by the account it draws on. */
export const poolLabel = (pool: BillingPool): string =>
  ({ apiKeys: "API keys", claudePlan: "Claude plan", chatgptPlan: "ChatGPT plan" })[pool];

/** An allowance window's length, such as `7-day` or `5-hour`. */
export const windowLabel = (minutes: number): string =>
  minutes % 1440 === 0
    ? `${minutes / 1440}-day`
    : minutes % 60 === 0
      ? `${minutes / 60}-hour`
      : `${minutes}-minute`;

/** The tooltip of a Run's age, which counts from when the Run opened. */
export const openedTitle = (openedAt: string): string => `Opened ${timestampLabel(openedAt)}`;

/** The tooltip of the time on a Board card's Run line: the instant it counts from and what that instant is. */
export const runLineTimeTitle = (state: RunView["state"], since: string): string => {
  if (state === "Running") return `Running since ${timestampLabel(since)}`;
  if (state === "Failed") return `Failed at ${timestampLabel(since)}`;
  return openedTitle(since);
};

/** Where an approval came from, worded to follow its time on the approval line. */
export const approvalChannelLabel = {
  ui: "from the UI",
  "github-ask": "from the GitHub Ask",
} as const satisfies Record<ApprovalChannel, string>;

/** The card's status while one of its Run actions is being sent. */
export const runActionProgress = {
  approve: "Approving…",
  retry: "Retrying…",
  cancel: "Canceling…",
  resolveFailure: "Marking resolved…",
} as const satisfies Record<RunActionRequest["action"], string>;

export const moveProgressMessage = (phase: BoardMoveProgress["phase"]): string =>
  phase === "saving" ? "Moving…" : "Saved on GitHub · syncing…";

export const failureMessage = (failure: FailureView): string =>
  Match.valueTags(failure, {
    InfraFailure: ({ message }) => message,
    DefectFailure: ({ message }) => message,
    AgentFailure: ({ message }) => message,
    BlockedFailure: ({ message }) => message,
    QuestionFailure: ({ question }) => question,
    RunawayFailure: ({ ceiling }) => `Runaway guard: ${ceiling} ceiling reached`,
    ChildSessionBudgetFailure: ({ attemptedChildren, maxChildren }) =>
      `Child session budget of ${maxChildren} used; child ${attemptedChildren} did not start`,
  });

/** Under an operator message the session it went to has not read yet. */
export const queuedMessageLabel = (session: QueuedFor): string =>
  session === "parent"
    ? "Queued until the current delegation returns"
    : "Queued until the child's current step ends";

export const conflictingSalvageMessage = ({ ref, commit }: SalvagePushed): string =>
  `Not applied: the previous attempt's work on ${ref} at ${commit.slice(0, 7)} conflicts with the current revision. It is still on ${ref}`;

export const needCopy = (need: NeedView): NeedCopy =>
  Match.valueTags(need, {
    CycleBudgetNeed: ({ ask, itemLabel }) => ({
      title: "Cycle budget exhausted",
      detail: `${itemLabel}: ${ask.completedCycles} completed rounds. ${ask.counts.map(({ loop, admitted }) => `${loop}: ${admitted} ${admitted === 1 ? "run" : "runs"}`).join("; ")}`,
      repository: ask.repository,
      runId: null,
    }),
    ApprovalNeed: ({ loop, repository, runId, item }) => ({
      title: `${loop}: approval needed`,
      detail: item === null ? "Open the run for the task text" : `#${item.number} ${item.title}`,
      repository,
      runId,
    }),
    RunFailureNeed: ({ failure, loop, repository, runId }) => ({
      title:
        failure._tag === "QuestionFailure"
          ? `Question from ${loop}`
          : failure._tag === "BlockedFailure"
            ? `${loop}: blocked`
            : failure._tag,
      detail: failureMessage(failure),
      repository,
      runId,
    }),
    BoardProjectionNeed: ({ failure }) => ({
      title: "Item projection quarantined",
      detail: failure.message,
      repository: failure.repository,
      runId: null,
    }),
    PollFailureNeed: ({ failure }) => ({
      title: failure.errorTag,
      detail: failure.message,
      repository: failure.repository,
      runId: null,
    }),
    PreflightFindingNeed: ({ finding }) => ({
      title: "Label preflight failed",
      detail: `${finding.label}: ${finding.message}`,
      repository: finding.repository,
      runId: null,
    }),
    ScheduleFailureNeed: ({ failure }) => ({
      title: failure._tag === "ScheduleTickFailure" ? failure.errorTag : failure._tag,
      detail: failure.message,
      repository: failure._tag === "ScheduleTickFailure" ? failure.repository : null,
      runId: null,
    }),
    ConfigFileNeed: ({ kind, error }) => ({
      title: kind === "loop" ? "Loop quarantined" : "Agent file not loaded",
      detail: `${error.file}: ${error.message.replace(/\.$/u, "")}. Fix the file, then reload the configuration from Configuration > Loops`,
      repository: null,
      runId: null,
    }),
    UnconfiguredWorkerNeed: ({ worker, attempts, running }) => ({
      title: "Worker not configured",
      detail:
        running > 0
          ? `${worker} is not in usine.yaml. ${running} ${running === 1 ? "attempt still runs" : "attempts still run"} on it; discard its leftovers once they end`
          : `${worker} is not in usine.yaml. Startup does not reconcile the ${attempts} recorded ${attempts === 1 ? "attempt" : "attempts"} on it. Declare the worker again and restart usine up, or discard the leftovers`,
      repository: null,
      runId: null,
    }),
  });

/** One line per kind of change an accepted reload made, or `Nothing changed`. */
export const reloadChanges = (reload: InstanceReload): ReadonlyArray<string> => {
  const named = [
    ["Loops", reload.loops],
    ["Agents", reload.agents],
    ["Labels", reload.labels],
    ["Repositories", reload.repos],
    ["Workers", reload.workers],
  ] as const;
  const lines = named.flatMap(([subject, { added, removed, changed }]) =>
    (
      [
        ["added", added],
        ["removed", removed],
        ["changed", changed],
      ] as const
    ).flatMap(([verb, names]) =>
      names.length === 0 ? [] : [`${subject} ${verb}: ${names.join(", ")}`],
    ),
  );
  if (reload.settingsChanged) lines.push("Settings changed");
  if (reload.operatorChanged) lines.push("Operator login changed");
  if (lines.length === 0) lines.push("Nothing changed");
  return lines;
};

/** One line per kind of change an accepted reload made, then the files it left out. */
export const reloadSummary = (reload: InstanceReload): ReadonlyArray<string> => {
  const lines = [...reloadChanges(reload)];
  const leftOut = reload.quarantinedLoops.length + reload.invalidAgents.length;
  if (leftOut > 0) {
    lines.push(
      leftOut === 1
        ? "1 file left out, listed in Needs attention"
        : `${leftOut} files left out, listed in Needs attention`,
    );
  }
  return lines;
};
