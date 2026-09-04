import { BrainSpec } from "@usine/core/agent/brain";
import { AgentSessionEvent, RateLimitWindow } from "@usine/core/agent/session";
import { RepositoryName, RunId } from "@usine/core/ids";
import type {
  FailureView,
  NeedView,
  TranscriptEventView,
} from "@usine/orchestrator/operator/model";
import { Match, Option, Schema } from "effect";

export interface NeedCopy {
  readonly title: string;
  readonly detail: string;
  readonly repository: RepositoryName | null;
  readonly runId: RunId | null;
}

export interface PresentedTranscriptEvent {
  readonly sequence: number;
  readonly receivedAt: string;
  readonly scope: "parent" | "child" | "channel";
  readonly sessionId: string | null;
  readonly parentId: string | null;
  readonly agent: string | null;
  readonly label: string;
  readonly detail: string;
  /** Markdown carries prose written for a reader; plain carries protocol payloads shown verbatim. */
  readonly format: "markdown" | "plain";
  readonly isError: boolean;
}

export const brainLine = (brain: BrainSpec): string =>
  `${brain.harness} · ${brain.model} · ${brain.effort}`;

export const failureMessage = (failure: FailureView): string =>
  Match.valueTags(failure, {
    InfraFailure: ({ message }) => message,
    AgentFailure: ({ message }) => message,
    RunawayFailure: ({ ceiling }) => `Runaway guard tripped its ${ceiling} ceiling`,
    ChildSessionBudgetFailure: ({ attemptedChildren, maxChildren }) =>
      `This Attempt used its ${maxChildren}-child session budget; child ${attemptedChildren} did not start`,
  });

export const needCopy = (need: NeedView): NeedCopy =>
  Match.valueTags(need, {
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
  });

const jsonDetail = (value: Schema.Json): string => JSON.stringify(value, null, 2);

const rateLimitWindow = (
  name: string,
  window: Option.Option<RateLimitWindow>,
): ReadonlyArray<string> =>
  Option.match(window, {
    onNone: () => [],
    onSome: ({ usedPercent }) => [`${name} ${usedPercent}% used`],
  });

const sessionPresentation = (
  event: AgentSessionEvent,
): Omit<PresentedTranscriptEvent, "sequence" | "receivedAt"> => {
  const session = event.session;
  const base = {
    scope: session._tag === "ChildSession" ? ("child" as const) : ("parent" as const),
    sessionId: session.id,
    parentId: session._tag === "ChildSession" ? session.parentId : null,
    agent: session.agent,
    detail: "",
    format: "plain" as const,
    isError: false,
  };
  return Match.valueTags(event, {
    SessionStarted: () => ({
      ...base,
      label: `${session.agent} started`,
      detail: brainLine(session.brain),
    }),
    TextOutput: ({ text }) => ({
      ...base,
      label: session.agent,
      detail: text,
      format: "markdown" as const,
    }),
    ToolStarted: ({ tool, input }) => ({
      ...base,
      label: `${tool} started`,
      detail: jsonDetail(input),
    }),
    ToolFinished: ({ tool, output, isError }) => ({
      ...base,
      label: `${tool} ${isError ? "failed" : "finished"}`,
      detail: jsonDetail(output),
      isError,
    }),
    PoolRateLimitsUpdated: ({ pool, rateLimits }) => ({
      ...base,
      label: `${pool} rate limits updated`,
      detail: [
        ...rateLimitWindow("primary", rateLimits.primary),
        ...rateLimitWindow("secondary", rateLimits.secondary),
      ].join(" · "),
    }),
    SessionFinished: () => ({ ...base, label: `${session.agent} finished` }),
  });
};

export const presentTranscriptEvent = (event: TranscriptEventView): PresentedTranscriptEvent => ({
  sequence: event.sequence,
  receivedAt: event.receivedAt,
  ...Match.valueTags(event.payload, {
    Started: ({ parentModel }) => ({
      scope: "channel" as const,
      sessionId: null,
      parentId: null,
      agent: null,
      label: "Attempt started",
      detail: parentModel,
      format: "plain" as const,
      isError: false,
    }),
    SessionEvent: ({ event: sessionEvent }) => sessionPresentation(sessionEvent),
    Final: ({ result }) => ({
      scope: "channel" as const,
      sessionId: null,
      parentId: null,
      agent: null,
      label: "Attempt finished",
      detail: result.message,
      format: "markdown" as const,
      isError: false,
    }),
    Failed: ({ failure }) => ({
      scope: "channel" as const,
      sessionId: null,
      parentId: null,
      agent: null,
      label: failure._tag,
      detail: failureMessage(failure),
      format: "plain" as const,
      isError: true,
    }),
    Interrupted: () => ({
      scope: "channel" as const,
      sessionId: null,
      parentId: null,
      agent: null,
      label: "Interrupted",
      detail: "The run host acknowledged the interrupt.",
      format: "plain" as const,
      isError: false,
    }),
    Steer: ({ message }) => ({
      scope: "channel" as const,
      sessionId: null,
      parentId: null,
      agent: null,
      label: "Operator message",
      detail: message,
      format: "markdown" as const,
      isError: false,
    }),
    Interrupt: () => ({
      scope: "channel" as const,
      sessionId: null,
      parentId: null,
      agent: null,
      label: "Interrupt",
      detail: "The operator asked the run host to stop.",
      format: "plain" as const,
      isError: false,
    }),
  }),
});
