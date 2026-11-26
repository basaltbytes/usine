import { Option } from "effect";
import type { AgentSession, AgentSessionEvent, HarnessSession } from "@usine/core/agent/session";
import type { AttemptId } from "@usine/core/attempt";
import type { TranscriptEventView } from "@usine/orchestrator/operator";

/** A delivery receipt for an operator input, at the first receipt's position with the newest payload. */
export type InterventionRecord = TranscriptEventView & {
  readonly payload: Extract<
    TranscriptEventView["payload"],
    {
      readonly _tag: "InterventionApplied" | "InterventionRejected";
    }
  >;
};

interface RecordedSessionEvent {
  readonly sequence: TranscriptEventView["sequence"];
  readonly receivedAt: string;
  readonly event: Exclude<
    AgentSessionEvent,
    {
      readonly _tag:
        | "PoolRateLimitsUpdated"
        | "SessionTokensUpdated"
        | "ProviderAnswered"
        | "OperatorMessageRead";
    }
  >;
}

/** One session's state and events; state comes from all session records, `events` only from the loaded page. */
export interface SessionEvents {
  readonly attemptId: AttemptId;
  readonly session: AgentSession;
  readonly first: TranscriptEventView;
  harnessSession: Option.Option<HarnessSession>;
  prompt: Option.Option<string>;
  latestSequence: TranscriptEventView["sequence"];
  status: "Live" | "Finished" | "Stopped";
  held: boolean;
  paused: boolean;
  idle: boolean;
  /**
   * Whether the loaded page holds every event of the session before `events`: its Attempt has no
   * earlier page, or the page holds the child's first launch.
   */
  earlierLoaded: boolean;
  readonly events: Array<RecordedSessionEvent>;
  readonly interventions: Array<InterventionRecord>;
}

/**
 * Groups records by session; records outside the loaded page update only the state fields.
 * `earlierUnloaded` holds the Attempts whose earlier events aren't loaded.
 */
export const indexSessions = (
  events: ReadonlyArray<TranscriptEventView>,
  sessionState: ReadonlyArray<TranscriptEventView>,
  terminalAttempts: ReadonlySet<AttemptId>,
  earlierUnloaded: ReadonlySet<AttemptId>,
) => {
  const loaded = new Set(events.map(({ sequence }) => sequence));
  const records = [
    ...new Map([...sessionState, ...events].map((record) => [record.sequence, record])).values(),
  ].sort((a, b) => a.sequence - b.sequence);
  const groups = new Map<string, SessionEvents>();
  const parents = new Map<AttemptId, SessionEvents>();
  const key = (attemptId: AttemptId, sessionId: AgentSession["id"]) =>
    JSON.stringify([attemptId, sessionId]);
  for (const record of records) {
    const payload = record.payload;
    if (payload._tag !== "SessionEvent") continue;
    const event = payload.event;
    if (
      event._tag === "PoolRateLimitsUpdated" ||
      event._tag === "SessionTokensUpdated" ||
      event._tag === "ProviderAnswered" ||
      event._tag === "OperatorMessageRead"
    )
      continue;
    const id = key(record.attemptId, event.session.id);
    let group = groups.get(id);
    if (group === undefined) {
      group = {
        attemptId: record.attemptId,
        session: event.session,
        first: record,
        harnessSession: Option.none(),
        prompt: Option.none(),
        latestSequence: record.sequence,
        status: terminalAttempts.has(record.attemptId) ? "Stopped" : "Live",
        held: false,
        paused: false,
        idle: false,
        earlierLoaded: !earlierUnloaded.has(record.attemptId),
        events: [],
        interventions: [],
      };
      groups.set(id, group);
      if (event.session._tag === "ParentSession") parents.set(record.attemptId, group);
    }
    group.latestSequence = record.sequence;
    if (event._tag === "SessionStarted") {
      group.harnessSession = event.harnessSession;
      group.prompt = event.prompt;
      // Only a child's first launch records its prompt; a relaunch after a restart doesn't.
      if (Option.isSome(event.prompt) && loaded.has(record.sequence)) group.earlierLoaded = true;
    }
    if (event._tag === "SessionFinished") group.status = "Finished";
    if (event._tag === "SessionIdle") group.idle = true;
    if (event._tag === "SessionResumed") group.idle = false;
    if (loaded.has(record.sequence))
      group.events.push({
        sequence: record.sequence,
        receivedAt: record.receivedAt,
        event,
      });
  }
  const unmatched: Array<InterventionRecord> = [];
  const inputKey = (attemptId: AttemptId, payload: InterventionRecord["payload"]) =>
    JSON.stringify([attemptId, payload.inputSequence]);
  const newest = new Map<string, InterventionRecord["payload"]>();
  for (const { attemptId, payload } of records)
    if (payload._tag === "InterventionApplied" || payload._tag === "InterventionRejected")
      newest.set(inputKey(attemptId, payload), payload);
  const shown = new Set<string>();
  for (const record of records) {
    const payload = record.payload;
    if (payload._tag !== "InterventionApplied" && payload._tag !== "InterventionRejected") continue;
    const input = inputKey(record.attemptId, payload);
    const receipt = { ...record, payload: newest.get(input) ?? payload };
    const target = payload.intervention.target;
    const group =
      target._tag === "Parent"
        ? parents.get(record.attemptId)
        : groups.get(key(record.attemptId, target.sessionId));
    const first = loaded.has(record.sequence) && !shown.has(input);
    if (first) shown.add(input);
    if (group === undefined) {
      if (first) unmatched.push(receipt);
      continue;
    }
    if (record.sequence > group.latestSequence) group.latestSequence = record.sequence;
    if (payload._tag === "InterventionApplied") {
      const recipient = Option.match(payload.state.forwardedTo, {
        onNone: () => group,
        onSome: (id) => groups.get(key(record.attemptId, id)),
      });
      if (recipient !== undefined) {
        recipient.held = payload.state.held;
        recipient.paused = payload.state.paused;
      }
    }
    if (first) group.interventions.push(receipt);
  }
  return { groups, unmatched };
};
