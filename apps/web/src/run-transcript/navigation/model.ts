import type { TranscriptSequence } from "@usine/engine/transcript";
import { Match, Option } from "effect";
import type { Chapter, ChapterRow, ReaderDocument } from "../document/model.ts";
import type { TranscriptTool } from "../model.ts";

/** One reader row that can receive new activity or be revealed during error navigation. */
export interface TranscriptUpdate {
  readonly key: string;
  /** Original conversation position; a tool result does not move its call. */
  readonly sequence: TranscriptSequence;
  /** Latest event contributing to this row, including a paired tool result. */
  readonly latestSequence: TranscriptSequence;
  readonly isError: boolean;
  /** A tool call, which error navigation opens inside its folded burst. */
  readonly isTool: boolean;
}

const toolUpdate = (tool: TranscriptTool): TranscriptUpdate => ({
  key: tool.key,
  sequence: tool.sequence,
  latestSequence: tool.latestSequence,
  isError: tool.state._tag === "Error",
  isTool: true,
});

const rowUpdates = (row: ChapterRow): ReadonlyArray<TranscriptUpdate> =>
  Match.valueTags(row, {
    Message: (message) => [
      {
        key: message.key,
        sequence: message.sequence,
        latestSequence: message.latestSequence,
        isError: message.undelivered,
        isTool: false,
      },
    ],
    Note: (note) => [
      {
        key: note.key,
        sequence: note.sequence,
        latestSequence: note.latestSequence,
        isError: note.tone === "failed",
        isTool: false,
      },
    ],
    Burst: ({ tools }) => tools.map(toolUpdate),
    Delegation: ({ tool }) => [toolUpdate(tool)],
    GitHubChange: () => [],
    BoardMove: () => [],
    Ending: ({ position, end }) =>
      Option.match(position, {
        onNone: () => [],
        onSome: ({ key, sequence, latestSequence }) => [
          { key, sequence, latestSequence, isError: end._tag === "Failed", isTool: false },
        ],
      }),
  });

/** A reader row that error navigation can show: a row, or a tool call inside its folded burst. */
export interface NavigableRow {
  readonly key: string;
  readonly isTool: boolean;
}

/** The outline's two error counts: what the Run ended with or the operator must read, and what the Agent recovered from. */
export interface ErrorTally {
  readonly errors: ReadonlyArray<NavigableRow>;
  readonly recovered: ReadonlyArray<NavigableRow>;
}

/** The notes of a chapter's connectivity warnings that are still open: each signal's latest warning. */
const openWarnings = (chapter: Chapter): ReadonlySet<string> => {
  const open = new Set(
    chapter.connectivity.map((warning) =>
      warning._tag === "WorkerSilent" ? "worker" : `provider:${warning.sessionId}`,
    ),
  );
  const latest = new Map<string, string>();
  for (const row of chapter.rows) {
    if (row._tag !== "Note" || row.connectivity === null) continue;
    if (row.connectivity._tag === "WorkerSilent") latest.set("worker", row.key);
    if (row.connectivity._tag === "ProviderRetrying")
      latest.set(`provider:${row.connectivity.sessionId}`, row.key);
  }
  return new Set([...latest].flatMap(([signal, key]) => (open.has(signal) ? [key] : [])));
};

const chapterErrors = (chapter: Chapter): ErrorTally => {
  const open = openWarnings(chapter);
  const errors: Array<NavigableRow> = [];
  const failedCalls: Array<TranscriptTool> = [];
  // The newest point at which the Attempt's sessions still said or did something.
  let wentOn = -1;
  const tool = (call: TranscriptTool) => {
    wentOn = Math.max(wentOn, call.sequence);
    if (call.state._tag === "Error") failedCalls.push(call);
  };
  const error = (key: string) => errors.push({ key, isTool: false });
  for (const row of chapter.rows) {
    switch (row._tag) {
      case "Message":
        if (row.from === "agent") wentOn = Math.max(wentOn, row.sequence);
        if (row.blocked || row.question || row.undelivered) error(row.key);
        break;
      case "Note":
        if (row.tone === "failed" || open.has(row.key)) error(row.key);
        break;
      case "Burst":
        row.tools.forEach(tool);
        break;
      case "Delegation":
        tool(row.tool);
        break;
      case "Ending":
        if (row.end._tag === "Failed") error(row.key);
        if (row.end._tag === "Succeeded") wentOn = Number.POSITIVE_INFINITY;
        break;
      case "GitHubChange":
      case "BoardMove":
        break;
    }
  }
  return {
    errors,
    recovered: failedCalls
      .filter((call) => call.sequence < wentOn)
      .map((call) => ({ key: call.key, isTool: true })),
  };
};

/**
 * Counts what the outline's error count shows, in reading order, by one rule:
 * an error is what the Run ended with or what the operator must read. That is
 * each failed Attempt's outcome, the last of which is the Run's failure, every
 * blocker and question an Agent raised, operator input a session refused, and
 * each connectivity warning still open on a running Attempt. A tool call that
 * failed while its Attempt went on, with another message or call or with
 * success, is recovered and counted apart; a failed call the Attempt did not
 * go on from is part of that Attempt's outcome.
 */
export const errorTally = (document: ReaderDocument): ErrorTally => {
  const tallies = document.chapters.map(chapterErrors);
  return {
    errors: tallies.flatMap(({ errors }) => errors),
    recovered: tallies.flatMap(({ recovered }) => recovered),
  };
};

/** Indexes the rows the reader shows, once each; account meters and omitted repeats are excluded. */
export const indexTranscriptUpdates = (document: ReaderDocument): ReadonlyArray<TranscriptUpdate> =>
  document.chapters
    .flatMap((chapter) => chapter.rows.flatMap(rowUpdates))
    .sort((left, right) => left.sequence - right.sequence);

/** Activity received since the reader last acknowledged the latest conversation. */
export interface UnreadTranscript {
  /** Newest observed raw transcript event, including events omitted from the conversation. */
  readonly through: TranscriptSequence | null;
  /** Last explicitly acknowledged tail; retained across closes and refreshes. */
  readonly readThrough: TranscriptSequence | null;
  readonly keys: ReadonlySet<string>;
}

/** Treats the initial loaded tail as read; through is its newest raw event, or null for an empty Run. */
export const initializeUnread = (through: TranscriptSequence | null): UnreadTranscript => ({
  through,
  readThrough: through,
  keys: new Set(),
});

/**
 * Adds each updated row once and advances the raw cursor. Earlier pages and repeated
 * responses cannot introduce unread activity, including when the initial tail contains only meters.
 */
export const advanceUnread = (
  previous: UnreadTranscript,
  updates: ReadonlyArray<TranscriptUpdate>,
  through: TranscriptSequence | null,
): UnreadTranscript => {
  const keys = new Set(previous.keys);
  for (const row of updates)
    if (previous.readThrough === null || row.latestSequence > previous.readThrough)
      keys.add(row.key);
  const latest =
    through !== null && (previous.through === null || through > previous.through)
      ? through
      : previous.through;
  return latest === previous.through && keys.size === previous.keys.size
    ? previous
    : { through: latest, readThrough: previous.readThrough, keys };
};

/** Clears the count without forgetting how far the transcript has already been observed. */
export const acknowledgeUnread = (previous: UnreadTranscript): UnreadTranscript =>
  previous.keys.size === 0 && previous.readThrough === previous.through
    ? previous
    : initializeUnread(previous.through);
