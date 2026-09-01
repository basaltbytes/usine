import type { TranscriptEventView, TranscriptPageCursor } from "@usine/orchestrator";
import { useMemo } from "react";
import { presentTranscriptEvent, type PresentedTranscriptEvent } from "./operator-copy.ts";

interface TranscriptGroup {
  readonly key: string;
  readonly sequence: number;
  readonly agent: string | null;
  readonly events: ReadonlyArray<PresentedTranscriptEvent>;
}

type TranscriptItem =
  | TranscriptGroup
  | {
      readonly key: string;
      readonly sequence: number;
      readonly event: PresentedTranscriptEvent;
    };

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

export const replaceEarlierCursor = (
  previous: ReadonlyArray<TranscriptPageCursor>,
  attempted: TranscriptPageCursor["attemptId"],
  next: ReadonlyArray<TranscriptPageCursor>,
): ReadonlyArray<TranscriptPageCursor> =>
  [...previous.filter(({ attemptId }) => attemptId !== attempted), ...next].sort(
    (left, right) => left.before - right.before,
  );

const TranscriptEvent = ({ event }: { readonly event: PresentedTranscriptEvent }) => (
  <article className={`transcript-event ${event.isError ? "event-error" : ""}`}>
    <header>
      <span>{event.label}</span>
      <time>
        {new Date(event.receivedAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })}
      </time>
    </header>
    {event.detail !== "" && <pre>{event.detail}</pre>}
  </article>
);

export const Transcript = ({ events }: { readonly events: ReadonlyArray<TranscriptEventView> }) => {
  const feed = useMemo(() => {
    // One collapsible group per child session, anchored at its own first
    // event, so concurrent children stay distinct and the parent/child
    // interleaving stays chronological (ADR 0008: one level deep).
    const groups = new Map<string, TranscriptGroup>();
    const presented = events.map(presentTranscriptEvent);
    for (const event of presented) {
      if (event.scope !== "child" || event.sessionId === null) continue;
      const current = groups.get(event.sessionId);
      groups.set(event.sessionId, {
        key: `child:${event.sessionId}`,
        sequence: Math.min(current?.sequence ?? event.sequence, event.sequence),
        agent: current?.agent ?? event.agent,
        events: [...(current?.events ?? []), event],
      });
    }
    const feed: Array<TranscriptItem> = [
      ...presented
        .filter((event) => event.scope !== "child")
        .map((event) => ({
          key: `event:${event.sequence}`,
          sequence: event.sequence,
          event,
        })),
      ...groups.values(),
    ];
    return feed.sort((left, right) => left.sequence - right.sequence);
  }, [events]);

  if (feed.length === 0) return <p className="empty-copy">Waiting for the first agent message…</p>;
  return (
    <div className="transcript">
      {feed.map((item) =>
        "event" in item ? (
          <TranscriptEvent event={item.event} key={item.key} />
        ) : (
          <details className="child-activity" key={item.key}>
            <summary>
              {item.agent ?? "Child"} activity <span>{item.events.length} events</span>
            </summary>
            <div>
              {item.events.map((event) => (
                <TranscriptEvent event={event} key={event.sequence} />
              ))}
            </div>
          </details>
        ),
      )}
    </div>
  );
};
