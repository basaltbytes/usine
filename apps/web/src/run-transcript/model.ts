import type { AgentSession, AgentSessionEvent } from "@usine/core/agent/session";
import type { AttemptId } from "@usine/core/attempt";
import type { AttemptView, TranscriptEventView } from "@usine/orchestrator/operator";
import { Match, Option, type Schema } from "effect";
import { brainLine, failureMessage } from "../operator-copy.ts";

/** Conversation filters hide prose or tool calls while preserving lifecycle notices. */
export type TranscriptFilter = "all" | "messages" | "tools";

interface NoticeContent {
  readonly kind: "message" | "status";
  readonly label: string;
  readonly detail: string;
  readonly format: "markdown" | "plain";
  readonly isError: boolean;
}

interface TranscriptPosition {
  readonly key: string;
  readonly sequence: TranscriptEventView["sequence"];
  /** Newest durable event represented by this row, independently of its position. */
  readonly latestSequence: TranscriptEventView["sequence"];
  readonly receivedAt: string;
}

/** Prose or a lifecycle notice retained in the conversation. */
export interface TranscriptNotice extends TranscriptPosition, NoticeContent {
  readonly _tag: "Notice";
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
  readonly attemptId: AttemptId;
  readonly session: AgentSession;
  readonly status: SessionStatus;
  readonly entries: ReadonlyArray<TranscriptEntry>;
}

/** A flat parent conversation with one section per child session. */
export interface TranscriptProjection {
  readonly items: ReadonlyArray<TranscriptEntry | TranscriptSession>;
  readonly sessions: ReadonlyArray<TranscriptSession>;
  readonly terminalAttempts: ReadonlySet<AttemptId>;
}

interface RecordedSessionEvent {
  readonly sequence: TranscriptEventView["sequence"];
  readonly receivedAt: string;
  readonly event: Exclude<AgentSessionEvent, { readonly _tag: "PoolRateLimitsUpdated" }>;
}

interface SessionEvents {
  readonly attemptId: AttemptId;
  readonly session: AgentSession;
  readonly events: [RecordedSessionEvent, ...Array<RecordedSessionEvent>];
}

const position = (
  event: Pick<TranscriptEventView, "sequence" | "receivedAt">,
): TranscriptPosition => ({
  key: `event:${event.sequence}`,
  sequence: event.sequence,
  latestSequence: event.sequence,
  receivedAt: event.receivedAt,
});

const notice = (
  event: Pick<TranscriptEventView, "sequence" | "receivedAt">,
  content: NoticeContent,
): TranscriptNotice => ({ _tag: "Notice", ...position(event), ...content });

const sessionEntries = (
  group: SessionEvents,
  status: SessionStatus,
): ReadonlyArray<TranscriptEntry> => {
  const entries: Array<TranscriptNotice> = [];
  const tools = new Map<string, TranscriptTool>();
  for (const record of group.events) {
    const event = record.event;
    if (event._tag === "ToolStarted" || event._tag === "ToolFinished") {
      const key = JSON.stringify([group.attemptId, group.session.id, event.callId]);
      const previous = tools.get(key);
      const start = previous?.start ?? Option.none<ToolStart>();
      tools.set(key, {
        _tag: "Tool",
        ...position(record),
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
    const content = Match.valueTags(event, {
      TextOutput: ({ text }) => ({
        kind: "message" as const,
        label: group.session.agent,
        detail: text,
        format: "markdown" as const,
        isError: false,
      }),
      SessionStarted: () => ({
        kind: "status" as const,
        label: `${group.session.agent} started`,
        detail: brainLine(group.session.brain),
        format: "plain" as const,
        isError: false,
      }),
      SessionFinished: () => ({
        kind: "status" as const,
        label: `${group.session.agent} finished`,
        detail: "",
        format: "plain" as const,
        isError: false,
      }),
    });
    entries.push(notice(record, content));
  }
  return [...entries, ...tools.values()].sort((left, right) => left.sequence - right.sequence);
};

/** Folds durable transcript events into conversation rows without reading time or changing stored data. */
export const projectTranscript = (
  events: ReadonlyArray<TranscriptEventView>,
  attempts: ReadonlyArray<AttemptView>,
): TranscriptProjection => {
  const terminalAttempts = new Set(
    attempts.filter(({ outcome }) => outcome !== null).map(({ id }) => id),
  );
  const groups = new Map<string, SessionEvents>();
  const entries: Array<TranscriptEntry> = [];
  for (const record of [...events].sort((left, right) => left.sequence - right.sequence)) {
    const payload = record.payload;
    if (payload._tag === "Final" || payload._tag === "Failed" || payload._tag === "Interrupted")
      terminalAttempts.add(record.attemptId);
    if (payload._tag === "SessionEvent") {
      if (payload.event._tag === "PoolRateLimitsUpdated") continue;
      const session = payload.event.session;
      const key = JSON.stringify([record.attemptId, session.id]);
      const sessionEvent: RecordedSessionEvent = {
        sequence: record.sequence,
        receivedAt: record.receivedAt,
        event: payload.event,
      };
      const group = groups.get(key);
      if (group === undefined)
        groups.set(key, { attemptId: record.attemptId, session, events: [sessionEvent] });
      else group.events.push(sessionEvent);
      continue;
    }
    entries.push(
      notice(
        record,
        Match.valueTags(payload, {
          Started: ({ parentModel }): NoticeContent => ({
            kind: "status",
            label: "Attempt started",
            detail: parentModel,
            format: "plain",
            isError: false,
          }),
          Final: ({ result }): NoticeContent => ({
            kind: "status",
            label: "Attempt finished",
            detail: result.message,
            format: "markdown",
            isError: false,
          }),
          Failed: ({ failure }): NoticeContent => ({
            kind: "status",
            label: "Attempt failed",
            detail: failureMessage(failure),
            format: "plain",
            isError: true,
          }),
          Interrupted: (): NoticeContent => ({
            kind: "status",
            label: "Interrupted",
            detail: "The run host acknowledged the interrupt.",
            format: "plain",
            isError: false,
          }),
          Steer: ({ message }): NoticeContent => ({
            kind: "message",
            label: "Operator",
            detail: message,
            format: "markdown",
            isError: false,
          }),
          Interrupt: (): NoticeContent => ({
            kind: "status",
            label: "Interrupt requested",
            detail: "The operator asked the run host to stop.",
            format: "plain",
            isError: false,
          }),
          OperatorMessage: ({ message }): NoticeContent => ({
            kind: "message",
            label: "Operator",
            detail: message,
            format: "markdown",
            isError: false,
          }),
          Release: (): NoticeContent => ({
            kind: "status",
            label: "Released",
            detail: "The operator released the held child.",
            format: "plain",
            isError: false,
          }),
        }),
      ),
    );
  }
  const sessions: Array<TranscriptSession> = [];
  for (const [key, group] of groups) {
    const first = group.events[0];
    const status: SessionStatus = group.events.some(({ event }) => event._tag === "SessionFinished")
      ? "Finished"
      : terminalAttempts.has(group.attemptId)
        ? "Stopped"
        : "Live";
    sessions.push({
      _tag: "Session",
      ...position(first),
      key,
      latestSequence: group.events.at(-1)?.sequence ?? first.sequence,
      attemptId: group.attemptId,
      session: group.session,
      status,
      entries: sessionEntries(group, status),
    });
  }
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

/** Applies a conversation filter after pairing tools, so their results and lifecycle remain intact. */
export const matchesFilter = (entry: TranscriptEntry, filter: TranscriptFilter): boolean =>
  entry._tag === "Tool" ? filter !== "messages" : entry.kind === "status" || filter !== "tools";

/** Describes observed session activity without assuming unrecorded thinking or success. */
export const sessionActivityLabel = (session: TranscriptSession): string => {
  if (session.status !== "Live") return session.status;
  const tool = [...session.entries]
    .reverse()
    .find((entry) => entry._tag === "Tool" && entry.state._tag === "Running");
  return tool?._tag === "Tool" ? `Running ${tool.name}` : "Working";
};
