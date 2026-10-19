import type { BillingPool, RateLimitWindow } from "@usine/core/agent/session";
import {
  RunDetailView,
  type TranscriptEventView,
  type TranscriptPageCursor,
} from "@usine/orchestrator/operator";
import { Array as Arr } from "effect";

/** Manual earlier-page cursor writes must pass through the TanStack cache unchanged. */
export const RUN_DETAIL_CACHE_STRUCTURAL_SHARING = false;

/** Joins overlapping transcript pages in durable sequence order without replaying an event. */
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

/** Advances only the Attempt whose earlier page was requested. */
export const replaceEarlierCursor = (
  previous: ReadonlyArray<TranscriptPageCursor>,
  attempted: TranscriptPageCursor["attemptId"],
  next: ReadonlyArray<TranscriptPageCursor>,
): ReadonlyArray<TranscriptPageCursor> =>
  [...previous.filter(({ attemptId }) => attemptId !== attempted), ...next].sort(
    (left, right) => left.before - right.before,
  );

/** Adds an earlier page without replacing newer Run state or operator actions in the cache. */
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

/** The latest allowance readings for one billing pool, primary window first; unreported windows are absent. */
export interface PoolMeter {
  readonly pool: BillingPool;
  readonly windows: ReadonlyArray<RateLimitWindow>;
}

/** Rate-limit updates are a meter, not activity: keep the latest reading per billing pool. */
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
