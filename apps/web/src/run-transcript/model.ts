import type {
  AgentSession,
  AgentSessionEvent,
  HarnessSession,
  ProviderRecovered,
  ProviderRetrying,
} from "@usine/core/agent/session";
import type { AttemptId } from "@usine/core/attempt";
import type { AttemptView, TranscriptEventView } from "@usine/orchestrator/operator";
import { DateTime, Match, Option, type Schema } from "effect";
import {
  brainLine,
  clockLabel,
  conflictingSalvageMessage,
  durationLabel,
  failureMessage,
} from "../operator-copy.ts";
import { indexSessions, type SessionEvents, type InterventionRecord } from "./sessions.ts";

/** How a notice reads: as plain record, as a signal that work may not be progressing, or as a failure. */
export type NoticeTone = "plain" | "warning" | "failed";

interface NoticeContent {
  readonly kind: "message" | "status";
  readonly label: string;
  readonly detail: string;
  readonly format: "markdown" | "plain";
  readonly tone: NoticeTone;
}

interface TranscriptPosition {
  readonly key: string;
  readonly attemptId: AttemptId;
  readonly sequence: TranscriptEventView["sequence"];
  /** Newest durable event represented by this row, independently of its position. */
  readonly latestSequence: TranscriptEventView["sequence"];
  readonly receivedAt: string;
}

/**
 * What a notice reports: a session's own event, a harness retrying or reaching its
 * model provider again, an operator input receipt, or an Attempt envelope.
 */
type NoticeOrigin =
  | {
      readonly _tag: "Session";
      readonly session: AgentSession;
      readonly event: Exclude<
        AgentSessionEvent["_tag"],
        "ToolStarted" | "ToolFinished" | "ProviderRetrying" | "ProviderRecovered"
      >;
    }
  | {
      readonly _tag: "Provider";
      readonly session: AgentSession;
      readonly event: ProviderRetrying | ProviderRecovered;
    }
  | { readonly _tag: "Operator"; readonly operator: string }
  | { readonly _tag: "Envelope"; readonly payload: TranscriptEventView["payload"] };

/** Prose or a lifecycle notice retained in the conversation. */
export interface TranscriptNotice extends TranscriptPosition, NoticeContent {
  readonly _tag: "Notice";
  readonly origin: NoticeOrigin;
}

interface ToolStart {
  readonly receivedAt: string;
  readonly input: Schema.Json;
}

type ToolState =
  | { readonly _tag: "Running" | "Stopped" }
  | {
      readonly _tag: "Finished" | "Error";
      readonly receivedAt: string;
      readonly output: Schema.Json;
    };

/** One tool call, paired within its Attempt and session, including an unpaged start when available. */
export interface TranscriptTool extends TranscriptPosition {
  readonly _tag: "Tool";
  readonly name: string;
  readonly start: Option.Option<ToolStart>;
  readonly state: ToolState;
}

/** A child's contents cannot contain another child section (ADR 0008). */
export type TranscriptEntry = TranscriptNotice | TranscriptTool;

/** Session completion is distinct from the enclosing Attempt's success or failure. */
type SessionStatus = "Live" | "Finished" | "Stopped";

/** One session's observed activity, scoped to its Attempt so retries never share state. */
export interface TranscriptSession extends TranscriptPosition {
  readonly _tag: "Session";
  readonly session: AgentSession;
  readonly harnessSession: Option.Option<HarnessSession>;
  readonly status: SessionStatus;
  readonly held: boolean;
  readonly paused: boolean;
  readonly idle: boolean;
  readonly entries: ReadonlyArray<TranscriptEntry>;
}

/** A flat parent conversation with one section per child session. */
export interface TranscriptProjection {
  readonly items: ReadonlyArray<TranscriptEntry | TranscriptSession>;
  readonly sessions: ReadonlyArray<TranscriptSession>;
  readonly terminalAttempts: ReadonlySet<AttemptId>;
}

const position = (
  event: Pick<TranscriptEventView, "sequence" | "receivedAt" | "attemptId">,
): TranscriptPosition => ({
  key: `event:${event.sequence}`,
  attemptId: event.attemptId,
  sequence: event.sequence,
  latestSequence: event.sequence,
  receivedAt: event.receivedAt,
});

const notice = (
  event: Pick<TranscriptEventView, "sequence" | "receivedAt" | "attemptId">,
  content: NoticeContent,
  origin: NoticeOrigin,
): TranscriptNotice => ({ _tag: "Notice", ...position(event), ...content, origin });

/** A count of a harness's provider retries in words: `1 retry`, `27 retries`. */
export const retriesLabel = (retries: number): string =>
  `${retries} ${retries === 1 ? "retry" : "retries"}`;

const sessionEntries = (
  group: SessionEvents,
  status: SessionStatus,
): ReadonlyArray<TranscriptEntry> => {
  const entries: Array<TranscriptNotice> = [];
  const tools = new Map<string, TranscriptTool>();
  for (const record of group.events) {
    const event = record.event;
    const at = { ...record, attemptId: group.attemptId };
    if (event._tag === "ToolStarted" || event._tag === "ToolFinished") {
      const key = JSON.stringify([group.attemptId, group.session.id, event.callId]);
      const previous = tools.get(key);
      const start = previous?.start ?? Option.none<ToolStart>();
      tools.set(key, {
        _tag: "Tool",
        ...position(at),
        key,
        sequence: previous?.sequence ?? record.sequence,
        receivedAt: previous?.receivedAt ?? record.receivedAt,
        name: event.tool,
        start:
          event._tag === "ToolStarted"
            ? Option.some({ receivedAt: record.receivedAt, input: event.input })
            : start,
        state:
          event._tag === "ToolFinished"
            ? {
                _tag: event.isError ? "Error" : "Finished",
                receivedAt: record.receivedAt,
                output: event.output,
              }
            : (previous?.state ?? { _tag: status === "Live" ? "Running" : "Stopped" }),
      });
      continue;
    }
    if (event._tag === "ProviderRetrying" || event._tag === "ProviderRecovered") {
      entries.push(
        notice(
          at,
          event._tag === "ProviderRetrying"
            ? {
                kind: "status",
                label: `${group.session.agent} cannot reach its provider`,
                detail: event.message,
                format: "plain",
                tone: "warning",
              }
            : {
                kind: "status",
                label: `${group.session.agent} reached its provider again`,
                detail: `After ${retriesLabel(event.retries)}.`,
                format: "plain",
                tone: "plain",
              },
          { _tag: "Provider", session: group.session, event },
        ),
      );
      continue;
    }
    const content = Match.valueTags(event, {
      TextOutput: ({ text }): NoticeContent => ({
        kind: "message",
        label: group.session.agent,
        detail: text,
        format: "markdown",
        tone: "plain",
      }),
      SessionStarted: (): NoticeContent => ({
        kind: "status",
        label: `${group.session.agent} started`,
        detail: brainLine(group.session.brain),
        format: "plain",
        tone: "plain",
      }),
      SessionIdle: (): NoticeContent => ({
        kind: "status",
        label: `${group.session.agent} is waiting`,
        detail: "The session remains open for operator input.",
        format: "plain",
        tone: "plain",
      }),
      SessionResumed: (): NoticeContent => ({
        kind: "status",
        label: `${group.session.agent} resumed`,
        detail: "",
        format: "plain",
        tone: "plain",
      }),
      SessionFinished: (): NoticeContent => ({
        kind: "status",
        label: `${group.session.agent} finished`,
        detail: "",
        format: "plain",
        tone: "plain",
      }),
    });
    entries.push(
      notice(at, content, { _tag: "Session", session: group.session, event: event._tag }),
    );
  }
  return [...entries, ...tools.values()].sort((left, right) => left.sequence - right.sequence);
};

const interventionNotice = (record: InterventionRecord): TranscriptNotice => {
  const { action, operator } = record.payload.intervention;
  const rejected = record.payload._tag === "InterventionRejected";
  const message = action._tag === "OperatorMessage" || action._tag === "Steer";
  return notice(
    record,
    {
      kind: message ? "message" : "status",
      label: rejected
        ? `${operator} · not delivered`
        : message
          ? operator
          : action._tag === "Release"
            ? `${operator} released the child`
            : `${operator} paused the session`,
      detail: rejected
        ? `${message ? `${action.message}\n\n` : ""}${record.payload.message}`
        : message
          ? action.message
          : "",
      format: message ? "markdown" : "plain",
      tone: rejected ? "failed" : "plain",
    },
    { _tag: "Operator", operator },
  );
};

/** Folds durable transcript events into conversation rows without reading time or changing stored data. */
export const projectTranscript = (
  events: ReadonlyArray<TranscriptEventView>,
  attempts: ReadonlyArray<AttemptView>,
  sessionState: ReadonlyArray<TranscriptEventView> = [],
): TranscriptProjection => {
  const terminalAttempts = new Set(
    attempts.filter(({ outcome }) => outcome !== null).map(({ id }) => id),
  );
  // Terminal state can be supplied by either the Attempt row or its final frame.
  for (const { attemptId, payload } of events) {
    if (payload._tag === "Final" || payload._tag === "Failed" || payload._tag === "Interrupted")
      terminalAttempts.add(attemptId);
  }
  const { groups, unmatched } = indexSessions(events, sessionState, terminalAttempts);
  const entries: Array<TranscriptEntry> = [];
  for (const record of [...events].sort((left, right) => left.sequence - right.sequence)) {
    const payload = record.payload;
    if (payload._tag === "InterventionApplied" || payload._tag === "InterventionRejected") {
      continue;
    }
    // New inputs are rendered from their delivery receipt, including the correct session and attribution.
    if (
      record.direction === "inbound" &&
      record.operator !== undefined &&
      payload._tag !== "Cancel"
    )
      continue;
    if (payload._tag === "SessionEvent") continue;
    entries.push(
      notice(
        record,
        Match.valueTags(payload, {
          Started: ({ parentModel, conflictingSalvage }): NoticeContent => ({
            kind: "status",
            label: "Attempt started",
            detail: Option.match(conflictingSalvage, {
              onNone: () => parentModel,
              onSome: (salvage) => `${parentModel}. ${conflictingSalvageMessage(salvage)}`,
            }),
            format: "plain",
            tone: "plain",
          }),
          Final: ({ result }): NoticeContent => ({
            kind: "status",
            label: "Attempt finished",
            detail: result.message,
            format: "markdown",
            tone: "plain",
          }),
          Failed: ({ failure }): NoticeContent => ({
            kind: "status",
            label: "Attempt failed",
            detail: failureMessage(failure),
            format: "plain",
            tone: "failed",
          }),
          Cancel: (): NoticeContent => ({
            kind: "status",
            label: "Cancel requested",
            detail: "The Attempt is stopping.",
            format: "plain",
            tone: "plain",
          }),
          Interrupted: (): NoticeContent => ({
            kind: "status",
            label: "Interrupted",
            detail: "The Attempt's parent acknowledged the interrupt.",
            format: "plain",
            tone: "plain",
          }),
          Steer: ({ message }): NoticeContent => ({
            kind: "message",
            label: "Operator",
            detail: message,
            format: "markdown",
            tone: "plain",
          }),
          Interrupt: (): NoticeContent => ({
            kind: "status",
            label: "Interrupt requested",
            detail: "The operator asked the Attempt to stop.",
            format: "plain",
            tone: "plain",
          }),
          OperatorMessage: ({ message }): NoticeContent => ({
            kind: "message",
            label: "Operator",
            detail: message,
            format: "markdown",
            tone: "plain",
          }),
          Release: (): NoticeContent => ({
            kind: "status",
            label: "Released",
            detail: "The operator released the held child.",
            format: "plain",
            tone: "plain",
          }),
          WorkerUnresponsive: ({ worker, lastAnsweredAt, reason }): NoticeContent => ({
            kind: "status",
            label: `Worker ${worker} stopped answering`,
            detail: `It last answered at ${clockLabel(DateTime.formatIso(lastAnsweredAt))}. ${reason}`,
            format: "plain",
            tone: "warning",
          }),
          WorkerResponsive: ({ worker, lastAnsweredAt }): NoticeContent => ({
            kind: "status",
            label: `Worker ${worker} answers again`,
            detail: `It did not answer for ${durationLabel(
              Date.parse(record.receivedAt) - DateTime.toEpochMillis(lastAnsweredAt),
            )}`,
            format: "plain",
            tone: "plain",
          }),
        }),
        { _tag: "Envelope", payload },
      ),
    );
  }
  const sessions: Array<TranscriptSession> = [];
  for (const [key, group] of groups) {
    sessions.push({
      _tag: "Session",
      ...position(group.first),
      key,
      latestSequence: group.latestSequence,
      session: group.session,
      harnessSession: group.harnessSession,
      status: group.status,
      held: group.status === "Live" && group.held,
      paused: group.status === "Live" && group.paused,
      idle: group.status === "Live" && group.idle,
      entries: [
        ...sessionEntries(group, group.status),
        ...group.interventions.map((record) => interventionNotice(record)),
      ].sort((a, b) => a.sequence - b.sequence),
    });
  }
  entries.push(
    ...unmatched.map((record) => {
      const entry = interventionNotice(record);
      const target = record.payload.intervention.target;
      return {
        ...entry,
        label: `${entry.label} · ${target._tag === "Parent" ? "parent" : target.sessionId}`,
      };
    }),
  );
  return {
    sessions,
    terminalAttempts,
    items: [
      ...entries,
      ...sessions.flatMap<TranscriptEntry | TranscriptSession>((session) =>
        session.session._tag === "ChildSession" ? [session] : session.entries,
      ),
    ].sort((left, right) => left.sequence - right.sequence),
  };
};

/** Describes observed session activity without assuming unrecorded thinking or success. */
export const sessionActivityLabel = (session: TranscriptSession): string => {
  if (session.status !== "Live") return session.status;
  if (session.paused) return "Paused · send a message to resume";
  if (session.held) return session.idle ? "Held · waiting for you" : "Held · working";
  if (session.idle) return "Waiting for operator input";
  const tool = [...session.entries]
    .reverse()
    .find((entry) => entry._tag === "Tool" && entry.state._tag === "Running");
  return tool?._tag === "Tool" ? `Running ${tool.name}` : "Working";
};
