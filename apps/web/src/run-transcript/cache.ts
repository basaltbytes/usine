import type { BillingPool, RateLimitWindow } from "@usine/core/agent/session";
import {
  RunDetailView,
  type TranscriptEventView,
  type TranscriptPageCursor,
} from "@usine/orchestrator/operator";
import { Array as Arr } from "effect";

/** `false`, so earlier-page cursors written with `setQueryData` are stored unchanged. */
export const RUN_DETAIL_CACHE_STRUCTURAL_SHARING = false;

/** Merges overlapping transcript pages in sequence order, without duplicate events. */
export const mergeTranscript = (
  previous: ReadonlyArray<TranscriptEventView>,
  next: ReadonlyArray<TranscriptEventView>,
): ReadonlyArray<TranscriptEventView> => {
  const merged = new Map(previous.map((event) => [event.sequence, event]));
  for (const event of next) {
    if (!merged.has(event.sequence)) merged.set(event.sequence, event);
  }
  return [...merged.values()].sort((left, right) => left.sequence - right.sequence);
};

/** Replaces only the cursor of the Attempt whose earlier page was loaded. */
export const replaceEarlierCursor = (
  previous: ReadonlyArray<TranscriptPageCursor>,
  attempted: TranscriptPageCursor["attemptId"],
  next: ReadonlyArray<TranscriptPageCursor>,
): ReadonlyArray<TranscriptPageCursor> =>
  [...previous.filter(({ attemptId }) => attemptId !== attempted), ...next].sort(
    (left, right) => left.before - right.before,
  );

/** Adds an earlier page's events; keeps the cached Run state and operator actions. */
export const mergeEarlierTranscript = (
  previous: RunDetailView,
  page: RunDetailView,
  cursor: TranscriptPageCursor,
): RunDetailView =>
  new RunDetailView({
    ...previous,
    transcript: mergeTranscript(previous.transcript, page.transcript),
    earlierTranscript: replaceEarlierCursor(
      previous.earlierTranscript,
      cursor.attemptId,
      page.earlierTranscript,
    ),
  });

/** The latest rate-limit readings for one billing pool, primary window first; windows never reported are omitted. */
export interface PoolMeter {
  readonly pool: BillingPool;
  readonly windows: ReadonlyArray<RateLimitWindow>;
}

/** Returns the latest rate-limit reading per billing pool. */
export const poolMeters = (
  events: ReadonlyArray<TranscriptEventView>,
): ReadonlyArray<PoolMeter> => {
  const latest = new Map<BillingPool, PoolMeter>();
  for (const event of events) {
    if (event.payload._tag !== "SessionEvent") continue;
    const session = event.payload.event;
    if (session._tag !== "PoolRateLimitsUpdated") continue;
    latest.set(session.pool, {
      pool: session.pool,
      windows: Arr.getSomes([session.rateLimits.primary, session.rateLimits.secondary]),
    });
  }
  return [...latest.values()];
};
