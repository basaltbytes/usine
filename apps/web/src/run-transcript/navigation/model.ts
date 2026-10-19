import type { TranscriptSequence } from "@usine/engine/transcript";
import { Match, Option } from "effect";
import type { ChapterRow, ReaderDocument } from "../document/model.ts";
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
        isError: note.undelivered,
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
