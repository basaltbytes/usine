import { ArrowDownIcon } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  MessageScrollerButton,
  useMessageScroller,
  useMessageScrollerScrollable,
} from "@/components/ui/message-scroller";

/** Observes the visible conversation and offers a way back to the latest activity. */
export const UpdateNavigation = ({
  count,
  active,
  pendingLatest,
  revealing,
  onObserve,
  onLatest,
  onReachedLatest,
}: {
  readonly count: number;
  readonly active: boolean;
  readonly pendingLatest: boolean;
  /** A navigation request is moving the reader, so its passing "at latest" state must not acknowledge updates. */
  readonly revealing: boolean;
  readonly onObserve: (atLatest: boolean) => void;
  readonly onLatest: () => void;
  readonly onReachedLatest: () => void;
}) => {
  const { end } = useMessageScrollerScrollable();
  const { scrollToEnd } = useMessageScroller();
  useEffect(() => {
    onObserve(active && !end && !revealing);
  }, [active, end, revealing, onObserve]);
  useLayoutEffect(() => {
    if (pendingLatest && scrollToEnd({ behavior: "instant" })) onReachedLatest();
  }, [pendingLatest, scrollToEnd, onReachedLatest]);

  if (count > 0)
    return (
      <Button
        variant="secondary"
        size="sm"
        className="absolute bottom-4 inset-s-1/2 -translate-x-1/2 gap-1.5 border border-border shadow-raised"
        onClick={onLatest}
      >
        <ArrowDownIcon aria-hidden="true" />
        {count} new {count === 1 ? "update" : "updates"}
      </Button>
    );
  return (
    <MessageScrollerButton
      size="sm"
      className="gap-1.5 shadow-raised"
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
