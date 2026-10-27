import { ArrowDownIcon } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect } from "react";
import { Button } from "~/components/ui/button";
import { useMessageScroller, useMessageScrollerScrollable } from "~/components/ui/message-scroller";

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
  /** Whether a navigation request is scrolling the reader; an "at latest" observation during it does not acknowledge updates. */
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

  // A separate row below the reader, so the control does not cover the outcome or salvage line.
  return (
    <div className="flex h-10 shrink-0 items-center justify-center">
      {count > 0 ? (
        <Button variant="secondary" size="sm" className="gap-1.5" onClick={onLatest}>
          <ArrowDownIcon aria-hidden="true" />
          {count} new {count === 1 ? "update" : "updates"}
        </Button>
      ) : (
        end && (
          <Button variant="ghost" size="sm" className="gap-1.5" onClick={onLatest}>
            <ArrowDownIcon aria-hidden="true" />
            Jump to latest
          </Button>
        )
      )}
    </div>
  );
};
