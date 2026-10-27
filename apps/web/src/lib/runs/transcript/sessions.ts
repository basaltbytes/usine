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
      readonly _tag: "PoolRateLimitsUpdated" | "SessionTokensUpdated";
    }
  >;
}

/** One session's state and events; state comes from all session records, `events` only from the loaded page. */
export interface SessionEvents {
  readonly attemptId: AttemptId;
  readonly session: AgentSession;
  readonly first: TranscriptEventView;
  harnessSession: Option.Option<HarnessSession>;
  latestSequence: TranscriptEventView["sequence"];
  status: "Live" | "Finished" | "Stopped";
  held: boolean;
  paused: boolean;
  idle: boolean;
  readonly events: Array<RecordedSessionEvent>;
  readonly interventions: Array<InterventionRecord>;
}

/** Groups records by session; records outside the loaded page update only the state fields. */
export const indexSessions = (
  events: ReadonlyArray<TranscriptEventView>,
  sessionState: ReadonlyArray<TranscriptEventView>,
  terminalAttempts: ReadonlySet<AttemptId>,
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
    if (event._tag === "PoolRateLimitsUpdated" || event._tag === "SessionTokensUpdated") continue;
    const id = key(record.attemptId, event.session.id);
    let group = groups.get(id);
    if (group === undefined) {
      group = {
        attemptId: record.attemptId,
        session: event.session,
        first: record,
        harnessSession: Option.none(),
        latestSequence: record.sequence,
        status: terminalAttempts.has(record.attemptId) ? "Stopped" : "Live",
        held: false,
        paused: false,
        idle: false,
        events: [],
        interventions: [],
      };
      groups.set(id, group);
      if (event.session._tag === "ParentSession") parents.set(record.attemptId, group);
    }
    group.latestSequence = record.sequence;
    if (event._tag === "SessionStarted") group.harnessSession = event.harnessSession;
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
      group.held = payload.state.held;
      group.paused = payload.state.paused;
    }
    if (first) group.interventions.push(receipt);
  }
  return { groups, unmatched };
};
