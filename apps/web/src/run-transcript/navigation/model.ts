import type { TranscriptSequence } from "@usine/engine/transcript";
import { Match, Option } from "effect";
import type { Chapter, ChapterRow, ReaderDocument } from "../document/model.ts";
import type { TranscriptTool } from "../model.ts";

/** A reader row that can get new activity or be shown by error navigation. */
export interface TranscriptUpdate {
  readonly key: string;
  /** The row's position in the conversation; a tool result does not change its call's position. */
  readonly sequence: TranscriptSequence;
  /** The newest event in this row, including a matched tool result. */
  readonly latestSequence: TranscriptSequence;
  readonly isError: boolean;
  /** Whether the row is a tool call, which error navigation opens inside its folded burst. */
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

/** A reader row that error navigation can show: a row or a tool call in a folded burst. */
export interface NavigableRow {
  readonly key: string;
  readonly isTool: boolean;
}

/** The outline's errors and recovered tool failures (see `errorTally`). */
export interface ErrorTally {
  readonly errors: ReadonlyArray<NavigableRow>;
  readonly recovered: ReadonlyArray<NavigableRow>;
}

/** Returns the note keys of a chapter's open connectivity warnings: the latest warning of each signal. */
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
  // The sequence of the Attempt's latest message or tool call.
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
 * Returns the outline's errors and recovered tool failures in reading order. Errors are each failed
 * Attempt's outcome, every blocker and question, every rejected operator input, and each open
 * connectivity warning on a running Attempt. A failed tool call followed by more activity in its
 * Attempt is recovered; one with no later activity is part of the Attempt's outcome.
 */
export const errorTally = (document: ReaderDocument): ErrorTally => {
  const tallies = document.chapters.map(chapterErrors);
  return {
    errors: tallies.flatMap(({ errors }) => errors),
    recovered: tallies.flatMap(({ recovered }) => recovered),
  };
};

/** Returns each row the reader shows once, excluding account meters and omitted repeats. */
export const indexTranscriptUpdates = (document: ReaderDocument): ReadonlyArray<TranscriptUpdate> =>
  document.chapters
    .flatMap((chapter) => chapter.rows.flatMap(rowUpdates))
    .sort((left, right) => left.sequence - right.sequence);

/** The activity received since the reader last acknowledged the latest row. */
export interface UnreadTranscript {
  /** The newest transcript event received, including events not shown in the conversation. */
  readonly through: TranscriptSequence | null;
  /** The last acknowledged event; kept across closes and refreshes. */
  readonly readThrough: TranscriptSequence | null;
  readonly keys: ReadonlySet<string>;
}

/** Returns a state in which the initially loaded tail is read; `through` is `null` for an empty Run. */
export const initializeUnread = (through: TranscriptSequence | null): UnreadTranscript => ({
  through,
  readThrough: through,
  keys: new Set(),
});

/** Adds each updated row once and advances `through`; earlier pages and repeated responses add no unread activity. */
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

/** Clears the unread rows and marks everything up to `through` as read. */
export const acknowledgeUnread = (previous: UnreadTranscript): UnreadTranscript =>
  previous.keys.size === 0 && previous.readThrough === previous.through
    ? previous
    : initializeUnread(previous.through);
