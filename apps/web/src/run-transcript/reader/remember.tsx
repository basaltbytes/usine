import type { RunId } from "@usine/core/run";
import type { TranscriptSequence } from "@usine/engine/transcript";
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { useTranscriptDisclosure } from "../grouping/disclosure.tsx";
import type { TranscriptFilter } from "../model.ts";
import { visibleTranscriptRow } from "../scroll-position.tsx";
import type { ReadingRow } from "./anchor.ts";
import { readerMemory, type ReaderBookmark, type ReaderPosition } from "./memory.ts";

/** Debounces browser writes while capturing scrolling immediately; flushes on close and page exit. */
export const RememberReader = ({
  runId,
  filter,
  readThrough,
  rows,
  viewportRef,
  active,
  restoring,
  allowLatest,
  initialPosition,
}: {
  readonly runId: RunId;
  readonly filter: TranscriptFilter;
  readonly readThrough: TranscriptSequence | null;
  readonly rows: ReadonlyArray<ReadingRow>;
  readonly viewportRef: RefObject<HTMLDivElement | null>;
  readonly active: boolean;
  readonly restoring: boolean;
  readonly allowLatest: boolean;
  readonly initialPosition: ReaderPosition;
}) => {
  const { state } = useTranscriptDisclosure();
  const bookmark = useRef<ReaderBookmark | null>(null);
  const position = useRef(initialPosition);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const memory = useRef(readerMemory(() => window.localStorage));
  const capture = (viewport = viewportRef.current) => {
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
      filter,
      readThrough,
      position: position.current,
      disclosures: [...state].slice(-200).map(([key, choice]) => ({ key, ...choice })),
    };
  };
  const latestCapture = useRef(capture);
  useLayoutEffect(() => {
    latestCapture.current = capture;
    capture();
  });
  useLayoutEffect(() => {
    // React clears the viewport ref during deletion before this sibling's cleanup.
    // Retain its DOM handle for the last measurement while the containing tree still exists.
    const viewport = viewportRef.current;
    return () => latestCapture.current(viewport);
  }, [active, runId, viewportRef]);
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
  }, [runId, filter, readThrough, rows, state, active, restoring, allowLatest]);
  return null;
};
