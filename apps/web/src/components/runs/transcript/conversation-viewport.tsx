import { useRef, type ReactNode, type RefObject } from "react";
import { MessageScrollerViewport, useMessageScroller } from "~/components/ui/message-scroller";

const SCROLL_KEYS = ["ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", " "];
const KEYS_TOWARD_START = ["ArrowUp", "Home", "PageUp"];

/**
 * Returns whether scrolling `delta` pixels (negative toward the start) from `target` scrolls a nested
 * area, such as a long tool output, instead of the viewport.
 */
const scrollsNestedArea = (target: EventTarget, viewport: Element, delta: number) => {
  if (delta === 0) return false;
  for (
    let element = target instanceof Element ? target : null;
    element !== null && element !== viewport;
    element = element.parentElement
  ) {
    const room =
      delta < 0
        ? element.scrollTop
        : element.scrollHeight - element.clientHeight - element.scrollTop;
    if (room < 1) continue;
    const { overflowY } = getComputedStyle(element);
    if (overflowY === "auto" || overflowY === "scroll") return true;
  }
  return false;
};

type ConversationViewportProps = {
  readonly viewportRef: RefObject<HTMLDivElement | null>;
  /** Whether the reader is at the latest row and follows new activity. */
  readonly following: boolean;
  /** Called when the operator scrolls the conversation. */
  readonly onNavigate: () => void;
  /** Called when the operator presses or activates something in the conversation, or scrolls a nested area. */
  readonly onInteract: () => void;
  readonly children: ReactNode;
};

/**
 * The scroller stops following on every wheel, swipe, or scroll key before these handlers run.
 * Following resumes after a scroll that ends at the latest row, including one toward the end when
 * already there; a wheel or swipe that scrolls a nested area does not change it.
 */
export const ConversationViewport = ({
  viewportRef,
  following,
  onNavigate,
  onInteract,
  children,
}: ConversationViewportProps) => {
  const { scrollToEnd } = useMessageScroller();
  const touchY = useRef(0);
  const keepFollowing = (viewport: HTMLDivElement) => {
    if (following && viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 8)
      scrollToEnd({ behavior: "instant" });
  };
  const navigate = (viewport: HTMLDivElement, toward: "start" | "end") => {
    onNavigate();
    if (toward === "end") keepFollowing(viewport);
  };
  const scroll = (target: EventTarget, viewport: HTMLDivElement, delta: number) => {
    if (scrollsNestedArea(target, viewport, delta)) {
      onInteract();
      keepFollowing(viewport);
    } else navigate(viewport, delta < 0 ? "start" : "end");
  };
  return (
    <MessageScrollerViewport
      ref={viewportRef}
      aria-label="Run conversation"
      preserveScrollOnPrepend={false}
      onWheel={(event) => scroll(event.target, event.currentTarget, event.deltaY)}
      onTouchStart={(event) => {
        touchY.current = event.touches[0]?.clientY ?? touchY.current;
      }}
      onTouchMove={(event) => {
        const y = event.touches[0]?.clientY ?? touchY.current;
        scroll(event.target, event.currentTarget, touchY.current - y);
        touchY.current = y;
      }}
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
        if (!event.defaultPrevented && SCROLL_KEYS.includes(event.key))
          navigate(
            event.currentTarget,
            KEYS_TOWARD_START.includes(event.key) || (event.key === " " && event.shiftKey)
              ? "start"
              : "end",
          );
      }}
    >
      {children}
    </MessageScrollerViewport>
  );
};
