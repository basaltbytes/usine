import type { AttemptId } from "@usine/core/attempt";
import type { AttemptSalvage } from "@usine/core/attempt/salvage";
import type { TranscriptSequence } from "@usine/engine/transcript";
import type {
  AttemptView,
  CommentedView,
  FailureView,
  LabelView,
  ReviewedView,
  TranscriptEventView,
} from "@usine/orchestrator/operator";
import { Match, Option } from "effect";
import { conflictingSalvageMessage, failureMessage } from "../../operator-copy.ts";
import { poolMeters, type PoolMeter } from "../cache.ts";
import type {
  TranscriptEntry,
  TranscriptNotice,
  TranscriptProjection,
  TranscriptSession,
  TranscriptTool,
} from "../model.ts";
import { presentTool } from "../tool/presentation.ts";
import {
  answerMarker,
  checkpointLabel,
  checkpointText,
  comparableText,
  withoutMarker,
} from "./text.ts";

/** A row's place in the durable transcript. */
interface RowPosition {
  readonly key: string;
  readonly sequence: TranscriptSequence;
  /** Newest durable event represented by this row, including a paired tool result. */
  readonly latestSequence: TranscriptSequence;
  readonly receivedAt: string;
}

/** Whom a row is attributed to: "Parent", a child's Agent name, or the operator. */
export interface Speaker {
  readonly name: string;
  /** The session the row belongs to; operator input carries the session it was sent to. */
  readonly sessionKey: string | null;
}

/** Prose from an Agent session or the operator. */
export interface MessageRow extends RowPosition {
  readonly _tag: "Message";
  readonly speaker: Speaker;
  /** The prose without a reserved opening marker. */
  readonly text: string;
  readonly format: "markdown" | "plain";
  /** Operator input the session refused; the text includes the refusal. */
  readonly undelivered: boolean;
  /** The message opens with the reserved blocker marker. */
  readonly blocked: boolean;
}

/** A lifecycle line, such as a session waiting for the operator or a requested cancel. */
interface NoteRow extends RowPosition {
  readonly _tag: "Note";
  readonly speaker: Speaker | null;
  readonly text: string;
  /** Operator input the session refused. */
  readonly undelivered: boolean;
}

/** Consecutive tool calls of one session between two messages, folded into one line. */
export interface Burst {
  readonly _tag: "Burst";
  /** Named after its first call, so the burst keeps its identity while calls join it. */
  readonly key: string;
  readonly speaker: Speaker;
  readonly tools: readonly [TranscriptTool, ...TranscriptTool[]];
}

/** A session handing work to a child, shown with the task it gave. */
export interface DelegationRow {
  readonly _tag: "Delegation";
  readonly key: string;
  readonly speaker: Speaker;
  readonly tool: TranscriptTool;
}

/** How an Attempt ended. */
export type AttemptEnd =
  | { readonly _tag: "Succeeded"; readonly message: Option.Option<string> }
  | {
      readonly _tag: "Failed";
      readonly failure: FailureView;
      readonly salvage: AttemptSalvage | null;
    }
  | { readonly _tag: "Canceled"; readonly salvage: AttemptSalvage | null };

/** The Attempt's outcome, in place of a final message that would repeat it. */
interface EndingRow {
  readonly _tag: "Ending";
  readonly key: string;
  /** The terminal envelope's place, when that envelope is loaded. */
  readonly position: Option.Option<RowPosition>;
  /** When the ending was said: the replaced final message, else the envelope or recorded end. */
  readonly receivedAt: Option.Option<string>;
  /** The session whose final message the ending replaced. */
  readonly speaker: Speaker | null;
  readonly end: AttemptEnd;
}

/** Labels an Agent removed from and added to the Run's Item in one go. */
export interface LabelChanges {
  readonly _tag: "Labels";
  readonly removed: ReadonlyArray<LabelView>;
  readonly added: ReadonlyArray<LabelView>;
}

/** A change an Attempt's Agent made on the Run's GitHub Item, among the rows around its time. */
export interface GitHubChangeRow {
  readonly _tag: "GitHubChange";
  readonly key: string;
  /** When GitHub recorded the change; for labels changed in one go, the first of them. */
  readonly at: string;
  readonly change: LabelChanges | CommentedView | ReviewedView;
}

/** One row of an Attempt as the reader shows it. */
export type ChapterRow = MessageRow | NoteRow | Burst | DelegationRow | EndingRow | GitHubChangeRow;

/** One Attempt of a Run: its sessions, its rows in transcript order, and its account readings. */
export interface Chapter {
  readonly key: string;
  readonly attemptId: AttemptId;
  readonly attempt: Option.Option<AttemptView>;
  /** The Attempt has no outcome and no terminal envelope yet. */
  readonly live: boolean;
  readonly parentModel: Option.Option<string>;
  /** The parent first, then each child in the order it started. */
  readonly sessions: ReadonlyArray<TranscriptSession>;
  readonly rows: ReadonlyArray<ChapterRow>;
  readonly meters: ReadonlyArray<PoolMeter>;
  readonly endedAt: Option.Option<string>;
  /** The newest loaded event the Attempt sent, account readings aside. */
  readonly lastActivityAt: Option.Option<string>;
}

/** A Run's loaded transcript as the reader shows it, one chapter per Attempt. */
export interface ReaderDocument {
  readonly chapters: ReadonlyArray<Chapter>;
}

/** A row the outline lists by its own first sentence; failures and blockers are marked. */
export interface Checkpoint {
  readonly key: string;
  readonly sessionKey: string | null;
  /** The message's first sentence. */
  readonly text: string;
  /** The sentence shortened to one outline row at a clause or word boundary. */
  readonly label: string;
  readonly tone: "plain" | "failed";
}

/** Where the operator is reading: the Attempt at the reading line and the last checkpoint at or above it. */
export interface ReadingPlace {
  readonly attemptId: AttemptId;
  readonly checkpointKey: string | null;
}

const speakerOf = (session: TranscriptSession): Speaker => ({
  name: session.session._tag === "ParentSession" ? "Parent" : session.session.agent,
  sessionKey: session.key,
});

const isTerminal = (notice: TranscriptNotice) =>
  notice.origin._tag === "Envelope" &&
  (notice.origin.payload._tag === "Final" ||
    notice.origin.payload._tag === "Failed" ||
    notice.origin.payload._tag === "Interrupted");

/** Agent prose that a terminal outcome repeats: the result, an Agent's own failure report, or its question. */
export const terminalText = (end: AttemptEnd): string | null =>
  Match.valueTags(end, {
    Succeeded: ({ message }) => Option.getOrNull(message),
    Failed: ({ failure }) =>
      failure._tag === "AgentFailure" || failure._tag === "QuestionFailure"
        ? failureMessage(failure)
        : null,
    Canceled: () => null,
  });

const envelopeEnd = (
  envelope: TranscriptNotice | undefined,
  attempt: AttemptView | undefined,
): AttemptEnd | null => {
  const salvage = attempt?.salvage ?? null;
  const message =
    envelope?.origin._tag === "Envelope" && envelope.origin.payload._tag === "Final"
      ? Option.some(envelope.origin.payload.result.message)
      : Option.none<string>();
  const outcome = attempt?.outcome;
  if (outcome !== null && outcome !== undefined)
    return Match.valueTags(outcome, {
      Succeeded: (): AttemptEnd => ({ _tag: "Succeeded", message }),
      Failed: ({ failure }): AttemptEnd => ({ _tag: "Failed", failure, salvage }),
      Canceled: (): AttemptEnd => ({ _tag: "Canceled", salvage }),
    });
  if (envelope?.origin._tag !== "Envelope") return null;
  const payload = envelope.origin.payload;
  if (payload._tag === "Final") return { _tag: "Succeeded", message };
  if (payload._tag === "Failed") return { _tag: "Failed", failure: payload.failure, salvage };
  if (payload._tag === "Interrupted") return { _tag: "Canceled", salvage };
  return null;
};

const noteText = (notice: TranscriptNotice): string =>
  notice.detail === "" ? notice.label : `${notice.label}. ${notice.detail}`;

const chapterRows = (
  entries: ReadonlyArray<{ readonly entry: TranscriptEntry; readonly session: Speaker | null }>,
  end: AttemptEnd | null,
  envelope: TranscriptNotice | undefined,
  attempt: AttemptView | undefined,
  attemptId: AttemptId,
): ReadonlyArray<ChapterRow> => {
  const rows: Array<ChapterRow> = [];
  const repeated = end === null ? null : terminalText(end);
  const ending = repeated === null ? null : comparableText(repeated);
  const childTexts = new Set<string>();
  let replaced: { readonly receivedAt: string; readonly speaker: Speaker } | null = null;
  let burst: Array<TranscriptTool> = [];
  let burstSpeaker: Speaker | null = null;
  const flush = () => {
    const [first, ...rest] = burst;
    if (first !== undefined && burstSpeaker !== null)
      rows.push({
        _tag: "Burst",
        key: `burst:${first.key}`,
        speaker: burstSpeaker,
        tools: [first, ...rest],
      });
    burst = [];
    burstSpeaker = null;
  };
  for (const { entry, session } of entries) {
    if (entry._tag === "Tool") {
      const speaker = session ?? { name: "Parent", sessionKey: null };
      if (presentTool(entry).category === "agent") {
        flush();
        rows.push({ _tag: "Delegation", key: entry.key, speaker, tool: entry });
        continue;
      }
      if (burstSpeaker !== null && burstSpeaker.sessionKey !== speaker.sessionKey) flush();
      burstSpeaker = speaker;
      burst.push(entry);
      continue;
    }
    if (isTerminal(entry)) continue;
    const origin = entry.origin;
    const at = {
      key: entry.key,
      sequence: entry.sequence,
      latestSequence: entry.latestSequence,
      receivedAt: entry.receivedAt,
    };
    if (origin._tag === "Session") {
      const speaker = session ?? { name: origin.session.agent, sessionKey: null };
      if (origin.event === "TextOutput") {
        const text = comparableText(entry.detail);
        if (ending !== null && text === ending) {
          replaced ??= { receivedAt: entry.receivedAt, speaker };
          continue;
        }
        const child = origin.session._tag === "ChildSession";
        if (!child && childTexts.has(text)) continue;
        if (child) childTexts.add(text);
        flush();
        rows.push({
          _tag: "Message",
          ...at,
          speaker,
          text: withoutMarker(entry.detail),
          format: entry.format,
          undelivered: false,
          blocked: answerMarker(entry.detail) === "blocked",
        });
        continue;
      }
      if (origin.event === "SessionIdle" || origin.event === "SessionResumed") {
        flush();
        rows.push({
          _tag: "Note",
          ...at,
          speaker,
          text: origin.event === "SessionIdle" ? "Waiting for operator input" : "Resumed",
          undelivered: false,
        });
      }
      continue;
    }
    if (origin._tag === "Envelope" && origin.payload._tag === "Started") {
      const salvage = origin.payload.conflictingSalvage;
      if (Option.isSome(salvage)) {
        flush();
        rows.push({
          _tag: "Note",
          ...at,
          speaker: null,
          text: conflictingSalvageMessage(salvage.value),
          undelivered: false,
        });
      }
      continue;
    }
    flush();
    rows.push(
      entry.kind === "message"
        ? {
            _tag: "Message",
            ...at,
            speaker: {
              name: origin._tag === "Operator" ? origin.operator : entry.label,
              sessionKey: session?.sessionKey ?? null,
            },
            text: entry.detail,
            format: entry.format,
            undelivered: entry.isError,
            blocked: false,
          }
        : { _tag: "Note", ...at, speaker: null, text: noteText(entry), undelivered: entry.isError },
    );
  }
  flush();
  if (end !== null) {
    const position =
      envelope === undefined
        ? Option.none<RowPosition>()
        : Option.some({
            key: envelope.key,
            sequence: envelope.sequence,
            latestSequence: envelope.latestSequence,
            receivedAt: envelope.receivedAt,
          });
    rows.push({
      _tag: "Ending",
      key: envelope?.key ?? `ending:${attemptId}`,
      position,
      receivedAt: Option.orElse(Option.fromNullishOr(replaced?.receivedAt), () =>
        Option.orElse(
          Option.map(position, ({ receivedAt }) => receivedAt),
          () => Option.fromNullishOr(attempt?.endedAt),
        ),
      ),
      speaker: replaced?.speaker ?? null,
      end,
    });
  }
  return rows;
};

/**
 * Arranges a projected transcript as the reader shows it: one chapter per Attempt, tool
 * calls folded between messages, a parent's copy of a child's message left out, and a
 * final message that the Attempt's outcome repeats shown once, as that outcome.
 */
export const readerDocument = (
  projection: TranscriptProjection,
  attempts: ReadonlyArray<AttemptView>,
  events: ReadonlyArray<TranscriptEventView>,
): ReaderDocument => {
  const owners = new Map<string, TranscriptSession>();
  for (const session of projection.sessions)
    for (const entry of session.entries) owners.set(entry.key, session);
  const entries = projection.items
    .flatMap((item) => (item._tag === "Session" ? item.entries : [item]))
    .sort((left, right) => left.sequence - right.sequence);
  const order = [
    ...[...attempts].sort((left, right) => left.number - right.number).map(({ id }) => id),
    ...entries.map(({ attemptId }) => attemptId),
  ];
  const chapters = [...new Set(order)].map((attemptId): Chapter => {
    const attempt = attempts.find(({ id }) => id === attemptId);
    const own = entries.filter((entry) => entry.attemptId === attemptId);
    const envelope = [...own]
      .reverse()
      .find((entry): entry is TranscriptNotice => entry._tag === "Notice" && isTerminal(entry));
    const started = own.find(
      (entry) =>
        entry._tag === "Notice" &&
        entry.origin._tag === "Envelope" &&
        entry.origin.payload._tag === "Started",
    );
    const end = envelopeEnd(envelope, attempt);
    const sent = events.filter((event) => event.attemptId === attemptId);
    const lastActivity = [...sent]
      .reverse()
      .find(
        ({ direction, payload }) =>
          direction === "outbound" &&
          !(payload._tag === "SessionEvent" && payload.event._tag === "PoolRateLimitsUpdated"),
      );
    return {
      key: `attempt:${attemptId}`,
      attemptId,
      attempt: Option.fromNullishOr(attempt),
      live: end === null && !projection.terminalAttempts.has(attemptId),
      parentModel:
        started?._tag === "Notice" &&
        started.origin._tag === "Envelope" &&
        started.origin.payload._tag === "Started"
          ? Option.some(started.origin.payload.parentModel)
          : Option.none(),
      sessions: projection.sessions
        .filter((session) => session.attemptId === attemptId)
        .sort(
          (left, right) =>
            Number(left.session._tag === "ChildSession") -
              Number(right.session._tag === "ChildSession") || left.sequence - right.sequence,
        ),
      rows: chapterRows(
        own.map((entry) => {
          const owner = owners.get(entry.key);
          return { entry, session: owner === undefined ? null : speakerOf(owner) };
        }),
        end,
        envelope,
        attempt,
        attemptId,
      ),
      meters: poolMeters(sent),
      endedAt: Option.orElse(Option.fromNullishOr(attempt?.endedAt), () =>
        Option.fromNullishOr(envelope?.receivedAt),
      ),
      lastActivityAt: Option.fromNullishOr(lastActivity?.receivedAt),
    };
  });
  return { chapters };
};

/** The rows the outline lists for a chapter: each message, then the Attempt's outcome. */
export const chapterCheckpoints = (chapter: Chapter): ReadonlyArray<Checkpoint> =>
  chapter.rows.flatMap((row): ReadonlyArray<Checkpoint> => {
    const named = (
      sessionKey: string | null,
      text: string,
      tone: Checkpoint["tone"],
    ): ReadonlyArray<Checkpoint> => [
      { key: row.key, sessionKey, text, label: checkpointLabel(text), tone },
    ];
    if (row._tag === "Message" && !row.undelivered)
      return named(
        row.speaker.sessionKey,
        checkpointText(row.text),
        row.blocked ? "failed" : "plain",
      );
    if (row._tag !== "Ending") return [];
    const sessionKey = row.speaker?.sessionKey ?? null;
    return Match.valueTags(row.end, {
      Succeeded: ({ message }) =>
        named(
          sessionKey,
          Option.match(message, { onNone: () => "Succeeded", onSome: checkpointText }),
          "plain",
        ),
      Failed: ({ failure }) => named(sessionKey, checkpointText(failureMessage(failure)), "failed"),
      Canceled: () => named(sessionKey, "Canceled", "plain"),
    });
  });

/** The reader's rows in document order, each with its Attempt and whether the outline lists it. */
export type ReadingOrder = ReadonlyArray<{
  readonly id: string;
  readonly attemptId: AttemptId;
  readonly checkpoint: boolean;
}>;

/** Orders every row the reader can show, including each Attempt's heading, history, and activity rows. */
export const readingOrder = (document: ReaderDocument): ReadingOrder =>
  document.chapters.flatMap((chapter) => {
    const checkpoints = new Set(chapterCheckpoints(chapter).map(({ key }) => key));
    const own = (id: string, checkpoint = false) => ({
      id,
      attemptId: chapter.attemptId,
      checkpoint,
    });
    return [
      own(chapter.key),
      own(`history:${chapter.attemptId}`),
      own(`empty:${chapter.attemptId}`),
      ...chapter.rows.map((row) => own(row.key, checkpoints.has(row.key))),
      own(`activity:${chapter.attemptId}`),
    ];
  });

/**
 * Finds the reading place from the reader's rows in view: the first of them in
 * document order sets the Attempt, and the last checkpoint at or above it is marked.
 * Above an Attempt's first checkpoint, nothing in that Attempt is marked.
 */
export const readingPlace = (
  order: ReadingOrder,
  visible: ReadonlyArray<string>,
): ReadingPlace | null => {
  const shown = new Set(visible);
  const first = order.findIndex(({ id }) => shown.has(id));
  const at = order[first];
  if (at === undefined) return null;
  const marked = order
    .slice(0, first + 1)
    .reverse()
    .find((entry) => entry.attemptId === at.attemptId && entry.checkpoint);
  return { attemptId: at.attemptId, checkpointKey: marked?.id ?? null };
};
