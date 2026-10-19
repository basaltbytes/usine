import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { TranscriptPageCursor } from "@usine/orchestrator/operator";
import { useMessageScroller } from "@/components/ui/message-scroller";
import { isGroupOpen, useTranscriptDisclosure } from "../grouping/disclosure.tsx";
import { locateReadingAnchor, type ReadingRow } from "./anchor.ts";
import { VISIBLE_ROW_EDGE } from "../scroll-position.tsx";
import type { ReadingAnchor } from "./memory.ts";

/** History uses the page's request and cache seam, including its failure and retry UI. */
export interface ReaderHistory {
  readonly earlier: TranscriptPageCursor | undefined;
  readonly loading: boolean;
  readonly error: string | null;
  readonly load: () => void;
}

/** Restores only after ancestor disclosures mount; explicit reader navigation cancels the target. */
export const RestoreReader = ({
  target,
  rows,
  history,
  viewportRef,
  active,
  onRestored,
}: {
  readonly target: ReadingAnchor | null;
  readonly rows: ReadonlyArray<ReadingRow>;
  readonly history: ReaderHistory;
  readonly viewportRef: RefObject<HTMLDivElement | null>;
  readonly active: boolean;
  readonly onRestored: () => void;
}) => {
  const { scrollToMessage, scrollToStart } = useMessageScroller();
  const { state, reveal } = useTranscriptDisclosure();
  const requested = useRef(new Set<string>());
  const [layout, setLayout] = useState(0);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (target === null || viewport === null) return;
    const observer = new ResizeObserver(() => setLayout((value) => value + 1));
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [target, viewportRef]);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (target === null || !active) return;
    const limited = requested.current.size >= 20;
    const location = locateReadingAnchor(
      target,
      rows,
      history.earlier !== undefined && history.error === null && !limited
        ? "available"
        : "exhausted",
    );
    if (location._tag === "Earlier") {
      if (history.loading || history.earlier === undefined) return;
      const cursor = JSON.stringify([history.earlier.attemptId, history.earlier.before]);
      if (requested.current.has(cursor)) return;
      requested.current.add(cursor);
      history.load();
      return;
    }
    if (
      history.loading &&
      (location._tag === "Empty" || (location._tag === "Row" && location.fallback))
    )
      return;
    if (location._tag === "Row") {
      const closed = location.row.openKeys.filter((key) => state.get(key)?.open !== true);
      const groupClosed =
        location.row.surface !== "group" &&
        location.row.groupKeys.length > 0 &&
        !isGroupOpen(state, location.row.groupKeys);
      if (closed.length > 0 || groupClosed) {
        for (const key of closed) reveal({ _tag: "Item", key, open: true });
        if (groupClosed) reveal({ _tag: "Group", keys: location.row.groupKeys, open: true });
        return;
      }
    }
    let settle: number | undefined;
    let completion: number | undefined;
    const frame = requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      if (viewport === null || viewport.clientHeight === 0) return;
      // Places the saved surface at its saved offset; false when it is not laid out.
      const align = (row: ReadingRow, saved: number): boolean => {
        const element = Array.from(
          viewport.querySelectorAll<HTMLElement>("[data-transcript-id]"),
        ).find((candidate) => candidate.getAttribute("data-transcript-id") === row.elementId);
        if (element === undefined || element.getBoundingClientRect().height === 0) return false;
        const bounds = element.getBoundingClientRect();
        const offset = Math.min(
          viewport.clientHeight - VISIBLE_ROW_EDGE,
          Math.max(VISIBLE_ROW_EDGE - bounds.height, saved),
        );
        const delta =
          bounds.top - viewport.getBoundingClientRect().top - viewport.clientTop - offset;
        if (Math.abs(delta) > 1) viewport.scrollTop += delta;
        return true;
      };
      if (location._tag === "Empty") scrollToStart({ behavior: "instant" });
      else {
        if (!scrollToMessage(location.row.messageId, { align: "start", behavior: "instant" }))
          return;
        if (!align(location.row, location.offset)) return;
      }
      if (location._tag === "Empty" || location.fallback)
        setNotice(
          history.earlier !== undefined
            ? "Your saved place is outside the loaded history. Showing nearby activity; use Load earlier to continue back."
            : "Your saved row is no longer available. Showing the nearest remaining activity.",
        );
      // Rows the jump brought into view replace their estimated heights on the next frame;
      // place the surface again, then let the registry publish the restored scrollability
      // before permitting capture. Restoration never acknowledges unread activity.
      settle = requestAnimationFrame(() => {
        if (location._tag === "Row") align(location.row, location.offset);
        completion = requestAnimationFrame(onRestored);
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      if (settle !== undefined) cancelAnimationFrame(settle);
      if (completion !== undefined) cancelAnimationFrame(completion);
    };
  }, [
    target,
    layout,
    rows,
    history,
    viewportRef,
    active,
    state,
    reveal,
    scrollToMessage,
    scrollToStart,
    onRestored,
  ]);
  return notice === null ? null : (
    <p role="status" className="px-4 py-2 text-xs text-muted-foreground">
      {notice}
    </p>
  );
};
