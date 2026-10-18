import { BrainSpec } from "@usine/core/agent/brain";
import type { AttemptSalvage } from "@usine/core/attempt/salvage";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import type { BoardItemLink, FailureView, NeedView } from "@usine/orchestrator/operator";
import { Match } from "effect";
import type { BoardMoveProgress } from "./board/moves.ts";

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
  cancel: "Cancel Run",
  confirmCancel: "Confirm cancel",
  keepRunning: "Keep running",
} as const;

export const itemKindLabel = (kind: BoardItemLink["kind"]): string =>
  kind === "pr" ? "Pull request" : "Issue";

/** How long ago `since` happened, in the largest whole unit: `now`, `12m`, `3h`, or `2d`. */
export const elapsedLabel = (since: string, now: number = Date.now()): string => {
  const elapsed = Math.max(0, now - Date.parse(since));
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
};

export const moveProgressMessage = (phase: BoardMoveProgress["phase"]): string =>
  phase === "saving" ? "Moving…" : "Saved on GitHub · syncing…";

export const failureMessage = (failure: FailureView): string =>
  Match.valueTags(failure, {
    InfraFailure: ({ message }) => message,
    DefectFailure: ({ message }) => message,
    AgentFailure: ({ message }) => message,
    RunawayFailure: ({ ceiling }) => `Runaway guard tripped its ${ceiling} ceiling`,
    ChildSessionBudgetFailure: ({ attemptedChildren, maxChildren }) =>
      `This Attempt used its ${maxChildren}-child session budget; child ${attemptedChildren} did not start`,
  });

export const salvageMessage = (salvage: AttemptSalvage): string =>
  Match.valueTags(salvage, {
    Pushed: ({ ref, commit }) =>
      `Unfinished work pushed to ${ref} at ${commit.slice(0, 7)}; a retry resumes from it`,
    Retained: ({ path, message }) =>
      `Salvage incomplete; unfinished work stays at ${path} and is retried at every startup. Last error: ${message}`,
  });

export const needCopy = (need: NeedView): NeedCopy =>
  Match.valueTags(need, {
    CycleBudgetNeed: ({ ask, itemLabel }) => ({
      title: "Cycle budget exhausted",
      detail: `${itemLabel}: ${ask.completedCycles} completed rounds. ${ask.counts.map(({ loop, admitted }) => `${loop}: ${admitted} Runs`).join("; ")}. Reset to allow up to ${ask.limit} more rounds of ${ask.loop}.`,
      repository: ask.repository,
      runId: null,
    }),
    ApprovalNeed: ({ loop, repository, runId }) => ({
      title: "Approval required",
      detail: `${loop} is waiting to run on ${repository}.`,
      repository,
      runId,
    }),
    RunFailureNeed: ({ failure, repository, runId }) => ({
      title: failure._tag,
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
      detail: `${error.file}: ${error.message.replace(/\.$/u, "")}. Fix the file and restart usine up.`,
      repository: null,
      runId: null,
    }),
  });
