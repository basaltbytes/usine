import type { AttemptId, OutOfMemoryKills } from "@usine/core/attempt";
import type { AttemptSalvage } from "@usine/core/attempt/salvage";
import type { TranscriptSequence } from "@usine/engine/transcript";
import type {
  AttemptView,
  BoardMovedView,
  CommentedView,
  FailureView,
  LabelView,
  ReviewedView,
  TranscriptEventView,
} from "@usine/orchestrator/operator";
import { Match, Option } from "effect";
import { conflictingSalvageMessage, failureMessage } from "~/lib/runs/strings";
import { poolMeters, type PoolMeter } from "~/lib/runs/transcript/cache";
import {
  type NoticeTone,
  type QueuedFor,
  retriesLabel,
  type TranscriptEntry,
  type TranscriptNotice,
  type TranscriptProjection,
  type TranscriptSession,
  type TranscriptTool,
} from "~/lib/runs/transcript/model";
import {
  type ConnectivityWarning,
  openConnectivity,
} from "~/lib/runs/transcript/document/connectivity";
import { presentTool } from "~/lib/runs/transcript/tool/presentation";
import {
  answerMarker,
  checkpointLabel,
  checkpointText,
  comparableText,
  withoutMarker,
} from "~/lib/runs/transcript/document/text";

/** A row's position in the transcript. */
interface RowPosition {
  readonly key: string;
  readonly sequence: TranscriptSequence;
  /** The newest event in this row, including a matched tool result. */
  readonly latestSequence: TranscriptSequence;
  readonly receivedAt: string;
}

/** The author of a row: "Parent", a child's Agent name, or the operator. */
export interface Speaker {
  readonly name: string;
  /** The row's session; for operator input, the session it was sent to. */
  readonly sessionKey: string | null;
}

/** A message from an Agent session or the operator. */
export interface MessageRow extends RowPosition {
  readonly _tag: "Message";
  readonly speaker: Speaker;
  /** Whether an Agent session or the operator sent the message. */
  readonly from: "agent" | "operator";
  /** The text without its reserved opening marker. */
  readonly text: string;
  readonly format: "markdown" | "plain";
  /** Whether the session rejected this operator input; the text includes the rejection. */
  readonly undelivered: boolean;
  /** The session that queued this operator input until its current step ends, or `null`. */
  readonly queued: QueuedFor | null;
  /** Whether the message starts with the reserved blocker marker. */
  readonly blocked: boolean;
  /** Whether the message starts with the reserved question marker. */
  readonly question: boolean;
}

/** The connectivity state in a note: the Worker silent or answering again, or a session retrying its provider. */
type ConnectivityNote =
  | { readonly _tag: "WorkerSilent" }
  | { readonly _tag: "WorkerAnswers" }
  | { readonly _tag: "ProviderRetrying"; readonly sessionId: string };

/**
 * A lifecycle line, for example a session waiting for the operator, a requested cancel, or a Worker
 * or provider that stopped answering. A `failed` note is operator input that the session rejected.
 */
interface NoteRow extends RowPosition {
  readonly _tag: "Note";
  readonly speaker: Speaker | null;
  readonly text: string;
  readonly tone: NoticeTone;
  readonly connectivity: ConnectivityNote | null;
}

/** Consecutive tool calls of one session between two messages, shown as one line. */
export interface Burst {
  readonly _tag: "Burst";
  /** The key of its first call, so it stays the same as calls are added. */
  readonly key: string;
  readonly speaker: Speaker;
  readonly tools: readonly [TranscriptTool, ...TranscriptTool[]];
}

/** A session delegating work to a child, with the delegated task. */
export interface DelegationRow {
  readonly _tag: "Delegation";
  readonly key: string;
  readonly speaker: Speaker;
  readonly tool: TranscriptTool;
}

/** The outcome of an Attempt. */
export type AttemptEnd =
  | { readonly _tag: "Succeeded"; readonly message: Option.Option<string> }
  | {
      readonly _tag: "Failed";
      readonly failure: FailureView;
      readonly salvage: AttemptSalvage | null;
    }
  | { readonly _tag: "Canceled"; readonly salvage: AttemptSalvage | null };

/** The Attempt's outcome, shown instead of a final message that repeats it. */
interface EndingRow {
  readonly _tag: "Ending";
  readonly key: string;
  /** The terminal envelope's position, if the envelope is loaded. */
  readonly position: Option.Option<RowPosition>;
  /** The time of the replaced final message, else of the envelope or recorded end. */
  readonly receivedAt: Option.Option<string>;
  /** The session whose final message the ending replaces. */
  readonly speaker: Speaker | null;
  readonly end: AttemptEnd;
  readonly outOfMemory: OutOfMemoryKills | null;
}

/** Labels an Agent removed from and added to the Run's Item together. */
export interface LabelChanges {
  readonly _tag: "Labels";
  readonly removed: ReadonlyArray<LabelView>;
  readonly added: ReadonlyArray<LabelView>;
}

/** A change an Attempt's Agent made on the Run's GitHub Item, placed among the rows by time. */
export interface GitHubChangeRow {
  readonly _tag: "GitHubChange";
  readonly key: string;
  /** When GitHub recorded the change; for labels changed together, the first change. */
  readonly at: string;
  readonly change: LabelChanges | CommentedView | ReviewedView;
}

/** An operator Board move of the Run's Item during the Attempt, placed among the rows by time. */
export interface BoardMoveRow {
  readonly _tag: "BoardMove";
  readonly key: string;
  readonly move: BoardMovedView;
}

export type ChapterRow =
  | MessageRow
  | NoteRow
  | Burst
  | DelegationRow
  | EndingRow
  | GitHubChangeRow
  | BoardMoveRow;

/** One Attempt of a Run, with its sessions, rows in transcript order, and account readings. */
export interface Chapter {
  readonly key: string;
  readonly attemptId: AttemptId;
  readonly attempt: Option.Option<AttemptView>;
  /** Whether the Attempt has no outcome and no terminal envelope yet. */
  readonly live: boolean;
  readonly parentModel: Option.Option<string>;
  /** The parent session first, then each child in start order. */
  readonly sessions: ReadonlyArray<TranscriptSession>;
  readonly rows: ReadonlyArray<ChapterRow>;
  readonly meters: ReadonlyArray<PoolMeter>;
  readonly endedAt: Option.Option<string>;
  /** The time of the newest loaded event from the Attempt, excluding account readings. */
  readonly lastActivityAt: Option.Option<string>;
  /** While the Attempt runs, the open connectivity warnings for its Worker and children. */
  readonly connectivity: ReadonlyArray<ConnectivityWarning>;
}

/** A Run's loaded transcript, with one chapter per Attempt. */
export interface ReaderDocument {
  readonly chapters: ReadonlyArray<Chapter>;
}

/**
 * The kind of a checkpoint: `turn`, which the outline folds with the session's adjacent turns, or a
 * kind that the outline lists separately.
 */
type CheckpointKind = "turn" | "blocker" | "question" | "operator" | "notice" | "ending";

/** A row that the outline lists by its first sentence. */
export interface Checkpoint {
  readonly key: string;
  readonly sessionKey: string | null;
  readonly kind: CheckpointKind;
  /** The speaker: "Parent", a child's Agent, or the operator; `null` for an outcome or a Worker notice. */
  readonly speaker: string | null;
  readonly text: string;
  /** `text` shortened to one outline row at a clause or word boundary. */
  readonly label: string;
  readonly tone: "plain" | "warning" | "failed";
}

/** Consecutive turns of one session, listed as one outline entry until opened. */
export interface TurnsEntry {
  readonly _tag: "Turns";
  /** The key of its first turn, so it stays the same as turns are added. */
  readonly key: string;
  readonly speaker: string;
  readonly sessionKey: string | null;
  readonly turns: readonly [Checkpoint, ...Checkpoint[]];
}

/** An entry of an Attempt's outline: folded turns or a separate checkpoint. */
export type OutlineEntry = TurnsEntry | { readonly _tag: "Mark"; readonly checkpoint: Checkpoint };

/** The reading position: the Attempt at the reading line and the last checkpoint at or above it. */
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

/** Returns the Agent text that a terminal outcome repeats: the result, failure report, blocker, or question. */
export const terminalText = (end: AttemptEnd): string | null =>
  Match.valueTags(end, {
    Succeeded: ({ message }) => Option.getOrNull(message),
    Failed: ({ failure }) =>
      failure._tag === "AgentFailure" ||
      failure._tag === "BlockedFailure" ||
      failure._tag === "QuestionFailure"
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

/** Returns whether an event is activity from the Attempt's sessions; meters and no-response reports are not. */
const isActivity = ({ direction, payload }: TranscriptEventView): boolean =>
  direction === "outbound" &&
  payload._tag !== "WorkerUnresponsive" &&
  payload._tag !== "WorkerResponsive" &&
  !(
    payload._tag === "SessionEvent" &&
    (payload.event._tag === "PoolRateLimitsUpdated" || payload.event._tag === "ProviderRetrying")
  );

const noteText = (notice: TranscriptNotice): string =>
  notice.detail === "" ? notice.label : `${notice.label}. ${notice.detail}`;

const workerNotice = (origin: TranscriptNotice["origin"]): ConnectivityNote | null => {
  if (origin._tag !== "Envelope") return null;
  if (origin.payload._tag === "WorkerUnresponsive") return { _tag: "WorkerSilent" };
  if (origin.payload._tag === "WorkerResponsive" && origin.payload.recovered)
    return { _tag: "WorkerAnswers" };
  return null;
};

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
  /** The row index of each session's unresolved provider retries, by session ID. */
  const retrying = new Map<string, number>();
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
        const marker = answerMarker(entry.detail);
        rows.push({
          _tag: "Message",
          ...at,
          speaker,
          from: "agent",
          text: withoutMarker(entry.detail),
          format: entry.format,
          undelivered: false,
          queued: null,
          blocked: marker === "blocked",
          question: marker === "question",
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
          tone: "plain",
          connectivity: null,
        });
      }
      continue;
    }
    if (origin._tag === "Provider") {
      const speaker = session ?? { name: origin.session.agent, sessionKey: null };
      const event = origin.event;
      flush();
      if (event._tag === "ProviderRecovered") {
        retrying.delete(origin.session.id);
        rows.push({
          _tag: "Note",
          ...at,
          speaker,
          text: `Provider reachable again after ${retriesLabel(event.retries)}`,
          tone: "plain",
          connectivity: null,
        });
        continue;
      }
      const text = `Provider unreachable, ${retriesLabel(event.retries)} so far. ${event.message}`;
      const streak = retrying.get(origin.session.id);
      const folded = streak === undefined ? undefined : rows[streak];
      // Consecutive retries of one session are merged into one line with the latest report.
      if (streak === rows.length - 1 && folded?._tag === "Note") {
        rows[streak] = { ...folded, latestSequence: entry.latestSequence, text };
        continue;
      }
      retrying.set(origin.session.id, rows.length);
      rows.push({
        _tag: "Note",
        ...at,
        speaker,
        text,
        tone: "warning",
        connectivity: { _tag: "ProviderRetrying", sessionId: origin.session.id },
      });
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
          tone: "plain",
          connectivity: null,
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
            from: "operator",
            text: entry.detail,
            format: entry.format,
            undelivered: entry.tone === "failed",
            queued: entry.queued,
            blocked: false,
            question: false,
          }
        : {
            _tag: "Note",
            ...at,
            speaker: null,
            text: noteText(entry),
            tone: entry.tone,
            connectivity: workerNotice(origin),
          },
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
      outOfMemory: attempt?.outOfMemory ?? null,
    });
  }
  return rows;
};

/**
 * Returns the reader document: one chapter per Attempt, tool calls grouped between messages, a
 * parent's copy of a child's message omitted, and a final message that the outcome repeats shown
 * only as the outcome.
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
    const lastActivity = [...sent].reverse().find(isActivity);
    const live = end === null && !projection.terminalAttempts.has(attemptId);
    return {
      key: `attempt:${attemptId}`,
      attemptId,
      attempt: Option.fromNullishOr(attempt),
      live,
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
      connectivity: live ? openConnectivity(sent) : [],
    };
  });
  return { chapters };
};

/**
 * Returns the outline checkpoints of a chapter in order: each message, operator input, Worker
 * notice, and provider warning, then the Attempt's outcome.
 */
export const chapterCheckpoints = (chapter: Chapter): ReadonlyArray<Checkpoint> =>
  chapter.rows.flatMap((row): ReadonlyArray<Checkpoint> => {
    const named = (
      fields: Pick<Checkpoint, "sessionKey" | "kind" | "speaker" | "tone">,
      text: string,
    ): ReadonlyArray<Checkpoint> => [
      { key: row.key, ...fields, text, label: checkpointLabel(text) },
    ];
    if (row._tag === "Message") {
      const { sessionKey, name } = row.speaker;
      if (row.from === "operator")
        return named(
          {
            sessionKey,
            kind: "operator",
            speaker: name,
            tone: row.undelivered ? "failed" : "plain",
          },
          checkpointText(row.text),
        );
      return named(
        {
          sessionKey,
          kind: row.blocked ? "blocker" : row.question ? "question" : "turn",
          speaker: name,
          tone: row.blocked ? "failed" : "plain",
        },
        checkpointText(row.text),
      );
    }
    if (row._tag === "Note") {
      if (row.connectivity === null && row.tone !== "failed") return [];
      return named(
        {
          sessionKey: row.speaker?.sessionKey ?? null,
          kind: row.connectivity === null ? "operator" : "notice",
          speaker: row.speaker?.name ?? null,
          tone: row.tone,
        },
        checkpointText(row.text),
      );
    }
    if (row._tag !== "Ending") return [];
    const ending = (text: string, tone: Checkpoint["tone"]) =>
      named(
        { sessionKey: row.speaker?.sessionKey ?? null, kind: "ending", speaker: null, tone },
        text,
      );
    return Match.valueTags(row.end, {
      Succeeded: ({ message }) =>
        ending(
          Option.match(message, { onNone: () => "Succeeded", onSome: checkpointText }),
          "plain",
        ),
      Failed: ({ failure }) => ending(checkpointText(failureMessage(failure)), "failed"),
      Canceled: () => ending("Canceled", "plain"),
    });
  });

/**
 * Returns the outline entries of a chapter: consecutive turns of one session are folded into one
 * entry, and every other checkpoint is a separate entry, so it is never hidden in a fold.
 */
export const outlineEntries = (chapter: Chapter): ReadonlyArray<OutlineEntry> => {
  const entries: Array<OutlineEntry> = [];
  for (const checkpoint of chapterCheckpoints(chapter)) {
    const last = entries.at(-1);
    if (checkpoint.kind !== "turn") {
      entries.push({ _tag: "Mark", checkpoint });
    } else if (last?._tag === "Turns" && last.sessionKey === checkpoint.sessionKey) {
      entries[entries.length - 1] = { ...last, turns: [...last.turns, checkpoint] };
    } else {
      entries.push({
        _tag: "Turns",
        key: `turns:${checkpoint.key}`,
        speaker: checkpoint.speaker ?? "Parent",
        sessionKey: checkpoint.sessionKey,
        turns: [checkpoint],
      });
    }
  }
  return entries;
};

/** The reader's rows in document order, each with its Attempt and whether the outline lists it. */
export type ReadingOrder = ReadonlyArray<{
  readonly id: string;
  readonly attemptId: AttemptId;
  readonly checkpoint: boolean;
}>;

/** Returns every row the reader can show in order, including each Attempt's heading, history, and activity rows. */
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
 * Returns the reading position from the rows in view: the first in document order sets the Attempt,
 * and the last checkpoint at or above it is marked. Above an Attempt's first checkpoint, no
 * checkpoint is marked.
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
