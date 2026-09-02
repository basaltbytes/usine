import { CaretRightIcon } from "@phosphor-icons/react";
import type { TranscriptEventView, TranscriptPageCursor } from "@usine/orchestrator";
import { useMemo } from "react";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Message, MessageContent, MessageHeader } from "@/components/ui/message";
import { Markdown } from "@/components/markdown";
import { cn } from "@/lib/utils";
import { presentTranscriptEvent, type PresentedTranscriptEvent } from "./operator-copy.ts";

/** Manual earlier-page cursor writes must pass through the TanStack cache unchanged. */
export const RUN_DETAIL_CACHE_STRUCTURAL_SHARING = false;

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
  <Message>
    <MessageContent>
      <MessageHeader
        className={cn("justify-between gap-3 px-0", event.isError && "text-destructive")}
      >
        <span className="truncate">{event.label}</span>
        <time className="shrink-0 font-mono tabular-nums">
          {new Date(event.receivedAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}
        </time>
      </MessageHeader>
      {event.detail !== "" && (
        <Bubble variant={event.isError ? "destructive" : "muted"} className="max-w-full">
          {event.format === "markdown" ? (
            <BubbleContent className="w-full">
              <Markdown>{event.detail}</Markdown>
            </BubbleContent>
          ) : (
            <BubbleContent
              render={<pre />}
              className="max-h-64 w-full overflow-y-auto font-mono text-[0.625rem]/relaxed whitespace-pre-wrap wrap-anywhere"
            >
              {event.detail}
            </BubbleContent>
          )}
        </Bubble>
      )}
    </MessageContent>
  </Message>
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

  if (feed.length === 0)
    return <p className="text-muted-foreground">Waiting for the first agent message…</p>;
  return (
    <div className="flex flex-col gap-3">
      {feed.map((item) =>
        "event" in item ? (
          <TranscriptEvent event={item.event} key={item.key} />
        ) : (
          <Collapsible className="rounded-md border" key={item.key}>
            <CollapsibleTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-between rounded-b-none font-mono data-[panel-open]:[&_svg]:rotate-90"
                />
              }
            >
              <span className="inline-flex items-center gap-1.5">
                <CaretRightIcon className="transition-transform" aria-hidden="true" />
                {item.agent ?? "Child"} activity
              </span>
              <span className="text-muted-foreground">{item.events.length} events</span>
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col gap-3 border-t p-2.5">
              {item.events.map((event) => (
                <TranscriptEvent event={event} key={event.sequence} />
              ))}
            </CollapsibleContent>
          </Collapsible>
        ),
      )}
    </div>
  );
};
