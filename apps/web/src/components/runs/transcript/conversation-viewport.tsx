import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { MessageScrollerViewport, useMessageScroller } from "~/components/ui/message-scroller";

const SCROLL_KEYS = ["ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", " "];
const atLatest = (viewport: HTMLDivElement) =>
  viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 8;
const insideScrollableArea = (target: EventTarget, viewport: Element) => {
  for (
    let element = target instanceof Element ? target : null;
    element !== null && element !== viewport;
    element = element.parentElement
  ) {
    const { overflowX, overflowY } = getComputedStyle(element);
    if (
      (element.scrollHeight > element.clientHeight && /^(auto|scroll)$/u.test(overflowY)) ||
      (element.scrollWidth > element.clientWidth && /^(auto|scroll)$/u.test(overflowX))
    )
      return true;
  }
  return false;
};

type ConversationViewportProps = {
  readonly viewportRef: RefObject<HTMLDivElement | null>;
  /** Whether the reader is at the latest row and follows new activity. */
  readonly following: boolean;
  /** Changes when transcript updates can move the viewport without user input. */
  readonly revision: number;
  /** Called when the operator scrolls the conversation. */
  readonly onNavigate: () => void;
  /** Called when the operator presses or activates something in the conversation, or scrolls a nested area. */
  readonly onInteract: () => void;
  readonly children: ReactNode;
};

/**
 * The scroller stops following on every wheel, swipe, or scroll key before these handlers run.
 * Restore following when input leaves the viewport still; only viewport movement is navigation.
 */
export const ConversationViewport = ({
  viewportRef,
  following,
  revision,
  onNavigate,
  onInteract,
  children,
}: ConversationViewportProps) => {
  const { scrollToEnd } = useMessageScroller();
  const inputTop = useRef(0);
  const pendingScroll = useRef<{ top: number; following: boolean; frame: number } | null>(null);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const recordPosition = () => {
      inputTop.current = viewport.scrollTop;
    };
    // React's passive listeners can run after Chromium has already scrolled.
    viewport.addEventListener("wheel", recordPosition, { passive: false });
    viewport.addEventListener("touchmove", recordPosition, { passive: false });
    return () => {
      viewport.removeEventListener("wheel", recordPosition);
      viewport.removeEventListener("touchmove", recordPosition);
    };
  }, [viewportRef]);
  const cancelPendingScroll = useCallback(() => {
    const pending = pendingScroll.current;
    if (pending === null) return;
    cancelAnimationFrame(pending.frame);
    pendingScroll.current = null;
    const viewport = viewportRef.current;
    if (pending.following && viewport !== null && viewport.scrollTop === pending.top)
      scrollToEnd({ behavior: "instant" });
  }, [scrollToEnd, viewportRef]);
  useLayoutEffect(() => cancelPendingScroll, [cancelPendingScroll, revision]);
  useEffect(() => {
    const inputs = ["pointerdown", "keydown", "wheel", "touchmove"] as const;
    for (const input of inputs) window.addEventListener(input, cancelPendingScroll, true);
    return () => {
      for (const input of inputs) window.removeEventListener(input, cancelPendingScroll, true);
    };
  }, [cancelPendingScroll]);
  // Navigation can enable following after the scroller has handled the native scroll event.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (following && viewport !== null && atLatest(viewport)) scrollToEnd({ behavior: "instant" });
  }, [following, scrollToEnd, viewportRef]);
  const keepFollowing = (viewport: HTMLDivElement) => {
    if (following && atLatest(viewport)) scrollToEnd({ behavior: "instant" });
  };
  const observeScroll = (viewport: HTMLDivElement) => {
    const pending = pendingScroll.current;
    if (pending === null) return;
    if (viewport.scrollTop !== pending.top) {
      cancelPendingScroll();
      onNavigate();
    } else if (pending.following) scrollToEnd({ behavior: "instant" });
  };
  const scroll = (viewport: HTMLDivElement, top = viewport.scrollTop) => {
    cancelPendingScroll();
    onInteract();
    pendingScroll.current = {
      top,
      following: following && atLatest(viewport),
      // Restore following after input that moves nothing; a later native scroll still navigates.
      frame: requestAnimationFrame(() => {
        const pending = pendingScroll.current;
        if (pending !== null) pending.frame = requestAnimationFrame(() => observeScroll(viewport));
      }),
    };
  };
  return (
    <MessageScrollerViewport
      ref={viewportRef}
      aria-label="Run conversation"
      preserveScrollOnPrepend={false}
      onScroll={(event) => {
        if (event.target === event.currentTarget) observeScroll(event.currentTarget);
      }}
      onWheel={(event) => {
        if (event.deltaY === 0) keepFollowing(event.currentTarget);
        else scroll(event.currentTarget, inputTop.current);
      }}
      onTouchMove={(event) => scroll(event.currentTarget, inputTop.current)}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onNavigate();
        else onInteract();
      }}
      onKeyDown={(event) => {
        // Space on a focused button activates it without changing whether the reader follows.
        const activatesButton =
          event.key === " " &&
          event.target instanceof Element &&
          event.target.closest('button, [role="button"]') !== null;
        if (event.key === "Enter" || activatesButton) {
          onInteract();
          return;
        }
        if (!event.defaultPrevented && SCROLL_KEYS.includes(event.key)) {
          if (insideScrollableArea(event.target, event.currentTarget)) {
            onInteract();
            keepFollowing(event.currentTarget);
          } else scroll(event.currentTarget);
        }
      }}
    >
      {children}
    </MessageScrollerViewport>
  );
};
