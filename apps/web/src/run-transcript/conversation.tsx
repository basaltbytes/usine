import { ArrowDownIcon } from "@phosphor-icons/react";
import type {
  AttemptView,
  RunStateTag,
  TranscriptEventView,
  TranscriptPageCursor,
} from "@usine/orchestrator/operator";
import { useEffect, useReducer, useRef, useState } from "react";
import { ErrorAlert } from "@/components/error-alert";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import type { TranscriptFilter } from "./model.ts";
import { PreserveReadingPosition } from "./scroll-position.tsx";
import { Transcript } from "./transcript.tsx";
import { SessionActivity } from "./activity.tsx";
import { TranscriptDisclosureProvider } from "./grouping/disclosure.tsx";

/** A Run's conversation follows incoming activity until the reader scrolls away. */
export const Conversation = ({
  events,
  attempts,
  earlier,
  loadEarlier,
  loadingEarlier,
  earlierError,
  state,
  active,
}: {
  readonly events: ReadonlyArray<TranscriptEventView>;
  readonly attempts: ReadonlyArray<AttemptView>;
  readonly earlier: TranscriptPageCursor | undefined;
  readonly loadEarlier: () => void;
  readonly loadingEarlier: boolean;
  readonly earlierError: string | null;
  readonly state: RunStateTag;
  readonly active: boolean;
}) => {
  const [filter, setFilter] = useState<TranscriptFilter>("all");
  const viewportRef = useRef<HTMLDivElement>(null);
  const [, refreshTime] = useReducer((version: number) => version + 1, 0);
  useEffect(() => {
    const timer = setInterval(refreshTime, 60_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-2 sm:px-6">
        <ButtonGroup aria-label="Conversation filter">
          {(["all", "messages", "tools"] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={filter === value ? "secondary" : "ghost"}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {{ all: "Everything", messages: "Messages", tools: "Tools" }[value]}
            </Button>
          ))}
        </ButtonGroup>
        <span className="text-muted-foreground">{state === "Running" ? "Live" : state}</span>
      </div>
      <SessionActivity events={events} attempts={attempts} />
      <TranscriptDisclosureProvider>
        <MessageScrollerProvider
          key={filter}
          autoScroll={active}
          defaultScrollPosition="end"
          scrollEdgeThreshold={8}
        >
          <MessageScroller className="min-h-0 flex-1">
            <PreserveReadingPosition
              active={active}
              viewportRef={viewportRef}
              revision={
                events.length + attempts.filter((attempt) => attempt.outcome !== null).length
              }
            >
              <MessageScrollerViewport
                ref={viewportRef}
                aria-label="Run conversation"
                preserveScrollOnPrepend={false}
              >
                <MessageScrollerContent className="gap-4 px-4 pt-4 pb-16 sm:px-6">
                  {earlier !== undefined && (
                    <MessageScrollerItem messageId="history" className="flex justify-center">
                      <Button
                        variant="outline"
                        size="sm"
                        className="self-center"
                        disabled={loadingEarlier}
                        onClick={loadEarlier}
                      >
                        {loadingEarlier ? "Loading…" : "Load earlier"}
                      </Button>
                    </MessageScrollerItem>
                  )}
                  {earlierError !== null && (
                    <MessageScrollerItem messageId="history-error">
                      <ErrorAlert message={earlierError} />
                    </MessageScrollerItem>
                  )}
                  <Transcript events={events} attempts={attempts} filter={filter} />
                </MessageScrollerContent>
              </MessageScrollerViewport>
            </PreserveReadingPosition>
            <MessageScrollerButton
              size="sm"
              className="gap-1.5 shadow-sm"
              aria-label="Jump to latest"
            >
              <ArrowDownIcon aria-hidden="true" /> Jump to latest
            </MessageScrollerButton>
          </MessageScroller>
        </MessageScrollerProvider>
      </TranscriptDisclosureProvider>
    </>
  );
};
