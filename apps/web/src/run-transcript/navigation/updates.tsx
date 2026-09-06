import { ArrowDownIcon } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  MessageScrollerButton,
  useMessageScroller,
  useMessageScrollerScrollable,
} from "@/components/ui/message-scroller";
import type { TranscriptFilter } from "../model.ts";

/** Observes the visible conversation while the unread ledger survives filter remounts. */
export const UpdateNavigation = ({
  count,
  active,
  filter,
  pendingLatest,
  revealingError,
  onObserve,
  onLatest,
  onReachedLatest,
}: {
  readonly count: number;
  readonly active: boolean;
  readonly filter: TranscriptFilter;
  readonly pendingLatest: boolean;
  readonly revealingError: boolean;
  readonly onObserve: (atLatest: boolean) => void;
  readonly onLatest: () => void;
  readonly onReachedLatest: () => void;
}) => {
  const { end } = useMessageScrollerScrollable();
  const { scrollToEnd } = useMessageScroller();
  useEffect(() => {
    onObserve(active && filter === "all" && !end && !revealingError);
  }, [active, filter, end, revealingError, onObserve]);
  useLayoutEffect(() => {
    if (pendingLatest && filter === "all" && scrollToEnd({ behavior: "instant" }))
      onReachedLatest();
  }, [pendingLatest, filter, scrollToEnd, onReachedLatest]);

  if (count > 0)
    return (
      <Button
        variant="secondary"
        size="sm"
        className="absolute bottom-4 inset-s-1/2 -translate-x-1/2 gap-1.5 border border-border shadow-sm"
        onClick={onLatest}
      >
        <ArrowDownIcon aria-hidden="true" />
        {count} new {count === 1 ? "update" : "updates"}
      </Button>
    );
  return (
    <MessageScrollerButton
      size="sm"
      className="gap-1.5 shadow-sm"
      aria-label="Jump to latest"
      onClick={(event) => {
        event.preventDefault();
        onLatest();
      }}
    >
      <ArrowDownIcon aria-hidden="true" /> Jump to latest
    </MessageScrollerButton>
  );
};
