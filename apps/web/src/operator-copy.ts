import { BrainSpec } from "@usine/core/agent/brain";
import type { AttemptSalvage, SalvagePushed } from "@usine/core/attempt/salvage";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import type { InstanceReload } from "@usine/orchestrator/current-instance";
import type { BoardItemLink, FailureView, NeedView, RunView } from "@usine/orchestrator/operator";
import { Match } from "effect";
import type { BoardMoveProgress } from "./board/moves.ts";
import type { RunActionRequest } from "./run-actions.ts";

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

/** An instant as a local date and minute, such as `2026-10-18 17:27`. */
export const timestampLabel = (instant: string): string => {
  const date = new Date(instant);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
};

/** The tooltip of a Run's age, which counts from when the Run opened. */
export const openedTitle = (openedAt: string): string => `Opened ${timestampLabel(openedAt)}`;

/** The tooltip of the time on a Board card's Run line: the instant it counts from and what that instant is. */
export const runLineTimeTitle = (state: RunView["state"], since: string): string => {
  if (state === "Running") return `Running since ${timestampLabel(since)}`;
  if (state === "Failed") return `Failed at ${timestampLabel(since)}`;
  return openedTitle(since);
};

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
    QuestionFailure: ({ question }) => question,
    RunawayFailure: ({ ceiling }) => `Runaway guard tripped its ${ceiling} ceiling`,
    ChildSessionBudgetFailure: ({ attemptedChildren, maxChildren }) =>
      `This Attempt used its ${maxChildren}-child session budget; child ${attemptedChildren} did not start`,
  });

export const salvageMessage = (salvage: AttemptSalvage): string =>
  Match.valueTags(salvage, {
    Pushed: ({ ref, commit }) =>
      `Unfinished work pushed to ${ref} at ${commit.slice(0, 7)}; a retry resumes from it`,
    Retained: ({ path, message }) =>
      `Salvage incomplete; unfinished work stays at ${path} and is retried at every startup while its Worker is configured. Last error: ${message}`,
  });

export const conflictingSalvageMessage = ({ ref, commit }: SalvagePushed): string =>
  `The previous Attempt's work on ${ref} at ${commit.slice(0, 7)} conflicts with the current revision; this Attempt starts without it, and the branch keeps it`;

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
      detail: `${loop} is waiting to run.`,
      repository,
      runId,
    }),
    RunFailureNeed: ({ failure, loop, repository, runId }) => ({
      title: failure._tag === "QuestionFailure" ? `${loop} asks a question` : failure._tag,
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
      detail: `${error.file}: ${error.message.replace(/\.$/u, "")}. Fix the file, then reload the configuration from Configuration > Loops.`,
      repository: null,
      runId: null,
    }),
    UnconfiguredWorkerNeed: ({ worker, attempts }) => ({
      title: "Worker not configured",
      detail: `usine.yaml no longer declares Worker ${worker}, so startup doesn't reconcile its ${attempts} recorded ${attempts === 1 ? "Attempt" : "Attempts"} and any checkout they left stays on it. Declare the Worker again and restart usine up, or discard the leftovers to stop tracking them.`,
      repository: null,
      runId: null,
    }),
  });

/** One line per kind of change an accepted reload made, then the files it left out. */
export const reloadSummary = (reload: InstanceReload): ReadonlyArray<string> => {
  const named = [
    ["Loops", reload.loops],
    ["Agents", reload.agents],
    ["Labels", reload.labels],
    ["Repositories", reload.repos],
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
  const leftOut = reload.quarantinedLoops.length + reload.invalidAgents.length;
  if (leftOut > 0) {
    lines.push(
      leftOut === 1
        ? "1 file was left out; Needs you lists it"
        : `${leftOut} files were left out; Needs you lists them`,
    );
  }
  return lines;
};
