import type { UpgradeWait } from "@usine/engine/engine";
import type { BrainSpec } from "@usine/core/agent/brain";
import type { OutOfMemoryKills } from "@usine/core/attempt";
import type { SalvagePushed } from "@usine/core/attempt/salvage";
import type { AttemptStart } from "@usine/core/attempt/start";
import type { ApprovalChannel } from "@usine/core/run/approval";
import type {
  FailureView,
  MachineView,
  MachineQuotaWait,
  RunView,
  UnconfirmedStopView,
} from "@usine/orchestrator/operator";
import { DateTime, Match, Option } from "effect";
import type { RunActionRequest } from "~/hooks/runs/actions";
import type { Chapter } from "~/lib/runs/transcript/document/model";
import type { QueuedFor } from "~/lib/runs/transcript/model";
import { timestampLabel } from "~/lib/strings";
import { providerLabel } from "~/lib/workers/strings";

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
    ProviderRetry: () => "Retried after a provider capacity refusal",
    AfterRestart: () => "Started again after a restart",
  });

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

/** Returns the assigned worker and its provider's quota refusal. */
export const machineWaitLine = ({ worker, message }: MachineQuotaWait): string =>
  `Waiting for ${worker}: ${message}`;

export const upgradeWaitLine = ({ target }: UpgradeWait): string =>
  `Waiting for the upgrade restart to ${target}`;

/** Returns the run state, including a stop or machine creation that prevents progress. */
export const runStateLine = (
  run: Pick<RunView, "id" | "state" | "attempts" | "providerRetry" | "machineWait" | "upgradeWait">,
  unconfirmedStop: UnconfirmedStopView | null = null,
  machine: MachineView | null = null,
): string => {
  if (unconfirmedStop !== null) return stopWaitLine(run.id, unconfirmedStop);
  if (run.upgradeWait !== null) return upgradeWaitLine(run.upgradeWait);
  if (run.machineWait !== null) return machineWaitLine(run.machineWait);
  if (run.state === "Queued" && machine?.state === "creating")
    return `Queued, creating a ${providerLabel[machine.provider]} machine`;
  if (run.providerRetry !== null) {
    const { message, nextAttempt, retryAt } = run.providerRetry;
    return `Provider at capacity: ${message} Next try: attempt ${nextAttempt} at ${timestampLabel(DateTime.formatIso(retryAt))}.`;
  }
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
    GitHubPushFailure: () => "GitHub refused push",
    InfraFailure: () => "Infrastructure failure",
    ProviderCapacityFailure: () => "Provider at capacity",
    DefectFailure: () => "Executor defect",
    AgentFailure: () => "Agent failure",
    BlockedFailure: () => "Agent blocked",
    QuestionFailure: () => "Question from the agent",
    RunawayFailure: () => "Runaway guard",
    ChildSessionBudgetFailure: () => "Child session budget exhausted",
  });

/** Returns the tooltip for a Run's age, which is measured from when the Run opened. */
export const openedTitle = (openedAt: string): string => `Opened ${timestampLabel(openedAt)}`;

/** The approval source text, shown after the time on the approval line. */
export const approvalChannelLabel = {
  ui: "from the UI",
} as const satisfies Record<ApprovalChannel, string>;

export const runActionProgress = {
  approve: "Approving…",
  retry: "Retrying…",
  cancel: "Canceling…",
  resolveFailure: "Marking resolved…",
} as const satisfies Record<RunActionRequest["action"], string>;

export const failureMessage = (failure: FailureView): string =>
  Match.valueTags(failure, {
    GitHubPushFailure: ({ message }) => message,
    InfraFailure: ({ message }) => message,
    ProviderCapacityFailure: ({ message }) => message,
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

export const retryDescription = (brain: BrainSpec): string =>
  `Retry uses ${brain.harness} · ${brain.model} from the saved agent definition.`;

export const transcriptHistoryLabel = {
  loading: "Loading…",
  loadEarlier: "Load earlier",
  empty: "No activity recorded",
} as const;

export const transcriptAttemptLabel = (attempt: Chapter["attempt"]): string =>
  Option.match(attempt, {
    onNone: () => "Attempt",
    onSome: ({ number }) => `Attempt ${number}`,
  });
