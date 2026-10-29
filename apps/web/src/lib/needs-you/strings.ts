import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import type {
  CycleBudgetNeed,
  NeedView,
  UnresponsiveWorkerNeed,
} from "@usine/orchestrator/operator";
import { Match } from "effect";
import { failureMessage, failureReason } from "~/lib/runs/strings";

export interface NeedCopy {
  readonly title: string;
  readonly detail: string;
  readonly repository: RepositoryName | null;
  readonly runId: RunId | null;
}

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
    WorkerPreflightNeed: ({ worker, message }) => ({
      title: `${worker}: preflight failed`,
      detail: `${message} This worker takes no new attempts while preflight retries automatically.`,
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
    UnresponsiveWorkerNeed: ({ worker, lastAnsweredAt, attempts }) => ({
      title: `${worker}: worker not responding`,
      detail: `Last answered ${lastAnsweredAt}. ${attempts.length} ${attempts.length === 1 ? "attempt is" : "attempts are"} still running. Check the worker or open an affected run.`,
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

export const attentionActionLabel = { dismissNeed: "Dismiss", undoDismissNeed: "Undo" } as const;
export const attentionActionProgress = {
  dismissNeed: "Dismissing…",
  undoDismissNeed: "Undoing…",
} as const;
export const dismissedAttentionTitle = "Dismissed";

export const workerAttemptLabel = ({
  repository,
  loop,
  attemptNumber,
}: UnresponsiveWorkerNeed["attempts"][number]) =>
  `${repository} · ${loop} · attempt ${attemptNumber}`;

export const openWorkerLabel = "Open worker";

export const attentionTitle = "Needs attention";
export const attentionEmpty = "Nothing needs attention";
export const attentionOverviewLink = "View all on Overview";
export const attentionBellLabel = (count: number) => `Needs attention (${count})`;

export const needKindLabel = {
  ApprovalNeed: "Approval needed",
  CycleBudgetNeed: "Cycle budget exhausted",
  WorkerPreflightNeed: "Worker preflight failed",
  UnconfiguredWorkerNeed: "Unconfigured worker",
  UnresponsiveWorkerNeed: "Unresponsive worker",
  RunFailureNeed: "Run failed",
  BoardProjectionNeed: "Board item unavailable",
  PollFailureNeed: "Poll failed",
  PreflightFindingNeed: "Label preflight failed",
  ScheduleFailureNeed: "Schedule failed",
  ConfigFileNeed: "Configuration file not loaded",
  UnconfirmedStopNeed: "Parent task not stopped",
} satisfies Record<NeedView["_tag"], string>;
