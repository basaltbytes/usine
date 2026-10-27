import { BrainSpec } from "@usine/core/agent/brain";
import type { BillingPool } from "@usine/core/agent/session";
import type { OutOfMemoryKills } from "@usine/core/attempt";
import type { SalvagePushed } from "@usine/core/attempt/salvage";
import type { AttemptStart } from "@usine/core/attempt/start";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import type { ApprovalChannel } from "@usine/core/run/approval";
import type { MachineProvider } from "@usine/core/worker";
import type { InstanceReload } from "@usine/orchestrator/current-instance";
import type {
  CycleBudgetNeed,
  FailureView,
  LoopView,
  MachineView,
  NeedView,
  ProvisioningPauseView,
  RunView,
  UnconfirmedStopView,
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

export const retryDescription = (brain: BrainSpec): string =>
  `Retry uses ${brain.harness} · ${brain.model} from the saved agent definition.`;

export const runActionLabel = {
  approve: "Approve",
  retry: "Retry",
  runAgain: "Run again",
  cancel: "Cancel run",
  confirmCancel: "Confirm cancel",
  keepRunning: "Keep running",
} as const;

export const runAgainProgress = "Opening a run…";

export const runAgainBlocked = "No run opened: cycle budget used up. Reset it in Needs attention";

/** Returns the label of a Loop trigger, using the Item kind names from Board cards. */
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

/** Returns the time since `since` in the largest whole unit: `now`, `12m`, `3h`, or `2d`. */
export const elapsedLabel = (since: string, now: number = Date.now()): string => {
  const elapsed = Math.max(0, now - Date.parse(since));
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
};

/** Returns the time since `instant` as a phrase: `just now` or `12m ago`. */
export const agoLabel = (instant: string, now: number): string => {
  const elapsed = elapsedLabel(instant, now);
  return elapsed === "now" ? "just now" : `${elapsed} ago`;
};

/** Returns `instant` as a local date and minute, for example `2026-10-18 17:27`. */
export const timestampLabel = (instant: string): string => {
  const date = new Date(instant);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Returns `instant` as a local day and minute, for example `15 Oct 19:30`. */
export const dayTimeLabel = (instant: string): string => {
  const date = new Date(instant);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${two(date.getHours())}:${two(date.getMinutes())}`;
};

/** Returns the local day of `date`, for example `22 Oct`. */
export const dayLabel = (date: Date): string => `${date.getDate()} ${MONTHS[date.getMonth()]}`;

/** Returns the local time of `instant` to the second, for example `19:31:03`. */
export const clockLabel = (instant: string): string => {
  const date = new Date(instant);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
};

/** Returns a duration in its largest useful units: `25s`, `22 min`, or `1 h 4 min`. */
export const durationLabel = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return minutes % 60 === 0
    ? `${Math.floor(minutes / 60)} h`
    : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};

/** Returns why an Attempt started, for example `From the event`, `Retried by PhilDL`, or `Retried after an infrastructure failure`. */
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

/** Returns a token count in compact notation: `950`, `27.3K`, or `1.2M`. */
export const tokensLabel = (tokens: number): string =>
  new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(tokens);

/** Returns dollars to the cent, for example `$1.25`, or `under $0.01` for less than a cent. */
export const usdLabel = (usd: number): string =>
  usd > 0 && usd < 0.005 ? "under $0.01" : `$${usd.toFixed(2)}`;

/**
 * Returns why the open Run `runId` starts no attempt, for example `Waiting for attempt 1 to stop on
 * local`, or `Waiting for attempt 1 of an earlier run to stop on local` for another Run's attempt.
 */
export const stopWaitLine = (
  runId: RunView["id"],
  { runId: stopped, attemptNumber, worker }: UnconfirmedStopView,
): string =>
  stopped === runId
    ? `Waiting for attempt ${attemptNumber} to stop on ${worker}`
    : `Waiting for attempt ${attemptNumber} of an earlier run to stop on ${worker}`;

export const providerLabel = {
  hetzner: "Hetzner",
  boat: "Boat",
} as const satisfies Record<MachineProvider, string>;

/** The provider's word for one machine, as in `Hetzner server 52341896`. */
export const providerMachineNoun = {
  hetzner: "server",
  boat: "sandbox",
} as const satisfies Record<MachineProvider, string>;

/** Returns the status of a machine being created, such as `Creating a Hetzner machine, started 2m ago`. */
export const machineCreationLine = (machine: MachineView, now: number): string =>
  `Creating a ${providerLabel[machine.provider]} machine, started ${agoLabel(machine.since, now)}`;

const creationFailureReason = {
  capacity: "no capacity",
  quota: "quota reached",
  refused: "refused by the provider",
  provider: "provider error",
  unreachable: "unreachable",
  timeout: "SSH timeout",
} as const satisfies Record<Exclude<ProvisioningPauseView["reason"], "check">, string>;

/** Returns why a provisioned Worker has no new machine, such as `Machine creation failed: quota reached`. */
export const creationFailureTitle = ({ reason }: ProvisioningPauseView): string =>
  reason === "check"
    ? "Preflight failed on the first machine of the day"
    : `Machine creation failed: ${creationFailureReason[reason]}`;

/** Returns `instant` to the minute, with its day unless it is on the day of `now`: `19:46` or `26 Oct 07:46`. */
const nearTimeLabel = (instant: string, now: number): string =>
  new Date(instant).toDateString() === new Date(now).toDateString()
    ? timestampLabel(instant).slice(11)
    : dayTimeLabel(instant);

/** Returns when a provisioned Worker creates a machine again: `Next try at 19:46`, or `Pause ended at 19:46`. */
export const nextCreationLine = (
  { blocked, retryAt }: ProvisioningPauseView,
  now: number,
): string => `${blocked ? "Next try" : "Pause ended"} at ${nearTimeLabel(retryAt, now)}`;

/** Returns how often machine creation failed, for example `Failed 3 times in a row, last at 19:31`. */
export const creationFailuresLine = ({ failures, failedAt }: ProvisioningPauseView, now: number) =>
  `${failures === 1 ? "Failed once" : `Failed ${failures} times in a row`}, last at ${nearTimeLabel(failedAt, now)}`;

/**
 * Returns the Run state as a phrase, for example `Failed after 3 attempts`, `Waiting for approval`,
 * or `Running, attempt 2`. While `unconfirmedStop` keeps an open Run from starting an attempt,
 * returns `stopWaitLine`; while `machine` is being created for a queued Run, says so.
 */
export const runStateLine = (
  run: Pick<RunView, "id" | "state" | "attempts">,
  unconfirmedStop: UnconfirmedStopView | null = null,
  machine: MachineView | null = null,
): string => {
  if (unconfirmedStop !== null) return stopWaitLine(run.id, unconfirmedStop);
  if (run.state === "Queued" && machine?.state === "creating")
    return `Queued, creating a ${providerLabel[machine.provider]} machine`;
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

export const failureReason = (failure: FailureView): string =>
  Match.valueTags(failure, {
    InfraFailure: () => "Infrastructure failure",
    DefectFailure: () => "Executor defect",
    AgentFailure: () => "Agent failure",
    BlockedFailure: () => "Agent blocked",
    QuestionFailure: () => "Question from the agent",
    RunawayFailure: () => "Runaway guard",
    ChildSessionBudgetFailure: () => "Child session budget exhausted",
  });

export const harnessLabel = (harness: BrainSpec["harness"]): string =>
  ({ claude: "Claude Code", codex: "Codex", pi: "Pi" })[harness];

export const poolLabel = (pool: BillingPool): string =>
  ({ apiKeys: "API keys", claudePlan: "Claude plan", chatgptPlan: "ChatGPT plan" })[pool];

/** Returns the length of a rate-limit window, for example `7-day` or `5-hour`. */
export const windowLabel = (minutes: number): string =>
  minutes % 1440 === 0
    ? `${minutes / 1440}-day`
    : minutes % 60 === 0
      ? `${minutes / 60}-hour`
      : `${minutes}-minute`;

/** Returns the tooltip for a Run's age, which is measured from when the Run opened. */
export const openedTitle = (openedAt: string): string => `Opened ${timestampLabel(openedAt)}`;

/** Returns the tooltip for the time on a Board card's Run line, with the start time and what it marks. */
export const runLineTimeTitle = (state: RunView["state"], since: string): string => {
  if (state === "Running") return `Running since ${timestampLabel(since)}`;
  if (state === "Failed") return `Failed at ${timestampLabel(since)}`;
  return openedTitle(since);
};

/** The approval source text, shown after the time on the approval line. */
export const approvalChannelLabel = {
  ui: "from the UI",
  "github-ask": "from GitHub",
} as const satisfies Record<ApprovalChannel, string>;

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
    RunawayFailure: ({ ceiling }) =>
      ceiling === "wall-clock"
        ? "Time limit reached: settings.max_attempt_minutes"
        : "Token limit reached: settings.max_attempt_tokens",
    ChildSessionBudgetFailure: ({ attemptedChildren, maxChildren }) =>
      `Child session budget of ${maxChildren} used; child ${attemptedChildren} did not start`,
  });

/** Returns the note under an operator message that the target session has not read yet. */
export const queuedMessageLabel = (session: QueuedFor): string =>
  session === "parent"
    ? "Queued until the delegated task ends"
    : "Queued until the current child step ends";

export const conflictingSalvageMessage = ({ ref, commit }: SalvagePushed): string =>
  `Not applied: the previous attempt's work on ${ref} at ${commit.slice(0, 7)} conflicts with the current revision. It is still on ${ref}`;

export const outOfMemoryLine = ({ kills, memoryMib }: OutOfMemoryKills): string =>
  `The kernel killed ${kills} ${kills === 1 ? "process" : "processes"} for memory across containers in this attempt. The last container with recorded kills had a ${memoryMib} MiB memory limit`;

/** Returns a used-up cycle budget's rounds and Runs per Loop, for example `3 completed rounds. start-dev: 2 runs`. */
export const cycleBudgetCounts = (ask: CycleBudgetNeed["ask"]): string =>
  `${ask.completedCycles} completed rounds. ${ask.counts.map(({ loop, admitted }) => `${loop}: ${admitted} ${admitted === 1 ? "run" : "runs"}`).join("; ")}`;

export const needCopy = (need: NeedView): NeedCopy =>
  Match.valueTags(need, {
    CycleBudgetNeed: ({ ask, itemLabel }) => ({
      title: "Cycle budget exhausted",
      detail: `${itemLabel}: ${cycleBudgetCounts(ask)}`,
      repository: ask.repository,
      runId: null,
    }),
    ApprovalNeed: ({ loop, repository, runId, item }) => ({
      title: `${loop}: approval needed`,
      detail: item === null ? "Open the run for the task text" : item.title,
      repository,
      runId,
    }),
    RunFailureNeed: ({ failure, loop, repository, runId }) => ({
      title:
        failure._tag === "QuestionFailure"
          ? `Question from ${loop}`
          : failure._tag === "BlockedFailure"
            ? `${loop}: blocked`
            : `${loop}: ${failureReason(failure).toLowerCase()}`,
      detail: failureMessage(failure),
      repository,
      runId,
    }),
    BoardProjectionNeed: ({ failure }) => ({
      title: "Item not shown on the board",
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
      title: Match.valueTags(failure, {
        ScheduleTickFailure: ({ errorTag }) => errorTag,
        ScheduleAgentFailure: ({ loop }) => `${loop}: agent not loaded`,
        ScheduleCronFailure: ({ loop }) => `${loop}: schedule not computed`,
      }),
      detail: failure.message,
      repository: failure._tag === "ScheduleTickFailure" ? failure.repository : null,
      runId: null,
    }),
    ConfigFileNeed: ({ kind, error }) => ({
      title: kind === "loop" ? "Loop file not loaded" : "Agent file not loaded",
      detail: `${error.file}: ${error.message.replace(/\.$/u, "")}. Fix the file, then reload the configuration from Configuration > Loops`,
      repository: null,
      runId: null,
    }),
    UnconfiguredWorkerNeed: ({ worker, attempts, running }) => ({
      title: "Worker not configured",
      detail:
        running > 0
          ? `${worker} is not in usine.yaml. ${running} ${running === 1 ? "attempt" : "attempts"} still running on it. Discard the leftovers after they end`
          : `${worker} is not in usine.yaml. Startup does not reconcile the ${attempts} recorded ${attempts === 1 ? "attempt" : "attempts"} on it. Add the worker back and restart usine up, or discard the leftovers`,
      repository: null,
      runId: null,
    }),
    UnconfirmedStopNeed: ({ loop, repository, runId, attemptNumber, worker }) => ({
      title: `${loop}: parent task not stopped`,
      detail: `Attempt ${attemptNumber} still ending on ${worker}, using one slot. No new attempt on this item until it stops. Stop retried every few minutes`,
      repository,
      runId,
    }),
  });

/** Returns one line per kind of change from an accepted reload, or `Nothing changed`. */
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

/** Returns the reload changes, followed by the files the reload skipped. */
export const reloadSummary = (reload: InstanceReload): ReadonlyArray<string> => {
  const lines = [...reloadChanges(reload)];
  const leftOut = reload.quarantinedLoops.length + reload.invalidAgents.length;
  if (leftOut > 0) {
    lines.push(
      leftOut === 1
        ? "1 file not loaded, listed in Needs attention"
        : `${leftOut} files not loaded, listed in Needs attention`,
    );
  }
  return lines;
};
