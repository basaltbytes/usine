import type { TranscriptSequence } from "@usine/engine/transcript";
import type { TranscriptEntry, TranscriptProjection } from "../model.ts";

/** One conversation row that can receive new activity or be revealed during error navigation. */
export interface TranscriptUpdate {
  readonly key: string;
  /** Original conversation position; a tool result does not move its call. */
  readonly sequence: TranscriptSequence;
  /** Latest event contributing to this row, including a paired tool result. */
  readonly latestSequence: TranscriptSequence;
  readonly isError: boolean;
  /** Child disclosure to open before revealing this row, or null for parent activity. */
  readonly childKey: string | null;
  readonly isTool: boolean;
}

const update = (entry: TranscriptEntry, childKey: string | null): TranscriptUpdate => ({
  key: entry.key,
  sequence: entry.sequence,
  latestSequence: entry.latestSequence,
  isError: entry._tag === "Tool" ? entry.state._tag === "Error" : entry.isError,
  childKey,
  isTool: entry._tag === "Tool",
});

/** Indexes original rows once, before filtering or grouping; child summaries and meters are excluded. */
export const indexTranscriptUpdates = (
  projection: TranscriptProjection,
): ReadonlyArray<TranscriptUpdate> =>
  projection.items
    .flatMap((item) =>
      item._tag === "Session"
        ? item.entries.map((entry) => update(entry, item.key))
        : [update(item, null)],
    )
    .sort((left, right) => left.sequence - right.sequence);

/** Activity received since the reader last acknowledged the latest conversation. */
export interface UnreadTranscript {
  /** Newest observed raw transcript event, including events omitted from the conversation. */
  readonly through: TranscriptSequence | null;
  readonly keys: ReadonlySet<string>;
}

/** Treats the initial loaded tail as read; through is its newest raw event, or null for an empty Run. */
export const initializeUnread = (through: TranscriptSequence | null): UnreadTranscript => ({
  through,
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
    if (previous.through === null || row.latestSequence > previous.through) keys.add(row.key);
  const latest =
    through !== null && (previous.through === null || through > previous.through)
      ? through
      : previous.through;
  return latest === previous.through && keys.size === previous.keys.size
    ? previous
    : { through: latest, keys };
};

/** Clears the count without forgetting how far the transcript has already been observed. */
export const acknowledgeUnread = (previous: UnreadTranscript): UnreadTranscript =>
  previous.keys.size === 0 ? previous : initializeUnread(previous.through);
