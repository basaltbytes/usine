import type { RunId } from "@usine/core/run";
import type { TranscriptSequence } from "@usine/engine/transcript";
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { useTranscriptDisclosure } from "~/components/runs/transcript/grouping/disclosure";
import { visibleTranscriptRow } from "~/components/runs/transcript/scroll-position";
import type { ReadingRow } from "~/lib/runs/transcript/reader/anchor";
import {
  readerMemory,
  type ReaderBookmark,
  type ReaderPosition,
} from "~/lib/runs/transcript/reader/memory";

type RememberReaderProps = {
  readonly runId: RunId;
  readonly readThrough: TranscriptSequence | null;
  readonly rows: ReadonlyArray<ReadingRow>;
  readonly viewportRef: RefObject<HTMLDivElement | null>;
  readonly active: boolean;
  readonly restoring: boolean;
  readonly allowLatest: boolean;
  readonly initialPosition: ReaderPosition;
};

/** Captures the scroll position on every scroll and debounces the browser storage writes; flushes on close and on page exit. */
export const RememberReader = ({
  runId,
  readThrough,
  rows,
  viewportRef,
  active,
  restoring,
  allowLatest,
  initialPosition,
}: RememberReaderProps) => {
  const { state } = useTranscriptDisclosure();
  const bookmark = useRef<ReaderBookmark | null>(null);
  const position = useRef(initialPosition);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const memory = useRef(readerMemory(() => window.localStorage));
  const capture = (container?: HTMLDivElement | null) => {
    const viewport = container === undefined ? viewportRef.current : container;
    if (!active || restoring) return;
    if (viewport === null || viewport.clientHeight === 0) return;
    const element = visibleTranscriptRow(viewport);
    const row = rows.find(
      (candidate) => candidate.elementId === element?.getAttribute("data-transcript-id"),
    );
    if (allowLatest && viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 8)
      position.current = { _tag: "Latest" };
    else if (row !== undefined && element !== undefined)
      position.current = {
        _tag: "Anchor",
        key: row.key,
        surface: row.surface,
        sequence: row.sequence,
        offset:
          element.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top -
          viewport.clientTop,
      };
    bookmark.current = {
      readThrough,
      position: position.current,
      disclosures: [...state].slice(-200).map(([key, choice]) => ({ key, ...choice })),
    };
  };
  const latestCapture = useRef(capture);
  // oxlint-disable-next-line usine/no-unreasoned-effect -- Capture the committed DOM scroll position for browser-storage persistence.
  useLayoutEffect(() => {
    latestCapture.current = capture;
    capture();
  });
  // oxlint-disable-next-line usine/no-unreasoned-effect -- Capture the DOM scroll position before the viewport ref is detached.
  useLayoutEffect(() => {
    // React clears the viewport ref before this cleanup runs, so the element is captured here.
    const viewport = viewportRef.current;
    return () => latestCapture.current(viewport);
  }, [active, runId, viewportRef]);
  // oxlint-disable-next-line usine/no-unreasoned-effect -- Persist scroll bookmarks to localStorage on scrolling, visibility changes, and page exit.
  useEffect(() => {
    const flush = () => {
      clearTimeout(timer.current);
      timer.current = undefined;
      if (bookmark.current !== null) memory.current.write(runId, bookmark.current, Date.now());
    };
    const schedule = () => {
      latestCapture.current();
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, 500);
    };
    const pageExit = () => {
      latestCapture.current();
      flush();
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") pageExit();
    };
    const viewport = viewportRef.current;
    viewport?.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("pagehide", pageExit);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("pagehide", pageExit);
      document.removeEventListener("visibilitychange", visibility);
      flush();
    };
  }, [runId, viewportRef]);
  // oxlint-disable-next-line usine/no-unreasoned-effect -- Save the visible DOM reading anchor after transcript or disclosure changes.
  useEffect(() => {
    if (!active || restoring) return;
    const frame = requestAnimationFrame(() => {
      latestCapture.current();
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        if (bookmark.current !== null) memory.current.write(runId, bookmark.current, Date.now());
      }, 500);
    });
    return () => cancelAnimationFrame(frame);
  }, [runId, readThrough, rows, state, active, restoring, allowLatest]);
  return null;
};
