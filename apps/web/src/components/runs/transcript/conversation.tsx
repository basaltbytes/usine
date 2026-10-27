import type { RunId } from "@usine/core/run";
import type { TranscriptSequence } from "@usine/engine/transcript";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerVisibility,
} from "~/components/ui/message-scroller";
import {
  readingOrder,
  readingPlace,
  type ReaderDocument,
  type ReadingPlace,
} from "~/lib/runs/transcript/document/model";
import { TranscriptDisclosureProvider } from "~/components/runs/transcript/grouping/disclosure";
import { PreserveReadingPosition } from "~/components/runs/transcript/scroll-position";
import { Transcript, type TranscriptHistory } from "~/components/runs/transcript/transcript";
import {
  acknowledgeUnread,
  advanceUnread,
  indexTranscriptUpdates,
  initializeUnread,
} from "~/lib/runs/transcript/navigation/model";
import { RevealTarget, type ReaderTarget } from "~/components/runs/transcript/navigation/errors";
import { UpdateNavigation } from "~/components/runs/transcript/navigation/updates";
import { readerMemory, type ReadingAnchor } from "~/lib/runs/transcript/reader/memory";
import { readingRows } from "~/lib/runs/transcript/reader/anchor";
import { RestoreReader } from "~/components/runs/transcript/reader/restore";
import { RememberReader } from "~/components/runs/transcript/reader/remember";

/** A request to show a reader location; a new `id` repeats a request for the same location. */
export interface ReaderRequest {
  readonly id: number;
  readonly target: ReaderTarget;
}

// On a narrow screen, a finished Run opens at its outcome line instead of mid-message.
const narrowEntry = (document: ReaderDocument): ReaderTarget | null => {
  const last = document.chapters.at(-1);
  if (last === undefined || last.live || !window.matchMedia("(max-width: 1023px)").matches)
    return null;
  const row = [...last.rows].reverse().find(({ _tag }) => _tag === "Ending" || _tag === "Message");
  return row === undefined ? null : { messageId: row.key, tool: null };
};

/** Reports the reading position while the reader is shown. */
const TrackReading = ({
  document,
  active,
  onReading,
}: {
  readonly document: ReaderDocument;
  readonly active: boolean;
  readonly onReading: (place: ReadingPlace) => void;
}) => {
  const { visibleMessageIds } = useMessageScrollerVisibility();
  const order = useMemo(() => readingOrder(document), [document]);
  const place = readingPlace(order, visibleMessageIds);
  const attemptId = place?.attemptId;
  const checkpointKey = place?.checkpointKey ?? null;
  useEffect(() => {
    if (active && attemptId !== undefined) onReading({ attemptId, checkpointKey });
  }, [active, attemptId, checkpointKey, onReading]);
  return null;
};

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

/**
 * The scroller stops following on every wheel, swipe, or scroll key before these handlers run.
 * Following resumes after a scroll that ends at the latest row, including one toward the end when
 * already there; a wheel or swipe that scrolls a nested area does not change it.
 */
const ConversationViewport = ({
  viewportRef,
  following,
  onNavigate,
  onInteract,
  children,
}: {
  readonly viewportRef: RefObject<HTMLDivElement | null>;
  /** Whether the reader is at the latest row and follows new activity. */
  readonly following: boolean;
  /** Called when the operator scrolls the conversation. */
  readonly onNavigate: () => void;
  /** Called when the operator presses or activates something in the conversation, or scrolls a nested area. */
  readonly onInteract: () => void;
  readonly children: ReactNode;
}) => {
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

const Reader = ({
  runId,
  document,
  through,
  revision,
  runTask,
  history,
  active,
  request,
  onReading,
}: {
  readonly runId: RunId;
  readonly document: ReaderDocument;
  /** The newest transcript event, including events that no row shows. */
  readonly through: TranscriptSequence | null;
  /** A value that changes whenever transcript rows change size or content. */
  readonly revision: number;
  readonly runTask: string;
  readonly history: TranscriptHistory;
  /** Whether the reader is shown; while `false`, it neither saves its position nor acknowledges updates. */
  readonly active: boolean;
  readonly request: ReaderRequest | null;
  /** Called with the Attempt and checkpoint being read as the reader scrolls. */
  readonly onReading: (place: ReadingPlace) => void;
}) => {
  const [saved] = useState(() => readerMemory(() => window.localStorage).read(runId, Date.now()));
  const [pendingRestore, setPendingRestore] = useState<ReadingAnchor | null>(
    saved?.position._tag === "Anchor" ? saved.position : null,
  );
  const [allowLatest, setAllowLatest] = useState(pendingRestore === null);
  const [defaultPosition] = useState<"start" | "end">(pendingRestore === null ? "end" : "start");
  const restored = useCallback(() => setPendingRestore(null), []);
  const inspect = useCallback(() => {
    setPendingRestore(null);
    setAllowLatest(false);
  }, []);
  const navigate = () => {
    setPendingRestore(null);
    setAllowLatest(true);
  };
  const viewportRef = useRef<HTMLDivElement>(null);
  const updates = useMemo(() => indexTranscriptUpdates(document), [document]);
  const rows = useMemo(() => readingRows(document), [document]);
  const [unread, setUnread] = useState(() =>
    initializeUnread(saved === null ? through : saved.readThrough),
  );
  const [pendingTarget, setPendingTarget] = useState<ReaderTarget | null>(() =>
    saved === null ? narrowEntry(document) : null,
  );
  const [pendingLatest, setPendingLatest] = useState(false);
  const [handled, setHandled] = useState<number | null>(null);
  if (request !== null && request.id !== handled) {
    setHandled(request.id);
    inspect();
    setPendingTarget(request.target);
    setPendingLatest(false);
  }
  const observe = useCallback(
    (atLatest: boolean) => {
      setUnread((previous) => {
        const next = advanceUnread(previous, updates, through);
        return atLatest && pendingRestore === null && allowLatest ? acknowledgeUnread(next) : next;
      });
    },
    [updates, through, pendingRestore, allowLatest],
  );
  const jumpLatest = () => {
    navigate();
    setPendingLatest(true);
    setPendingTarget(null);
  };
  const reachedLatest = useCallback(() => setPendingLatest(false), []);
  const revealed = useCallback(() => setPendingTarget(null), []);
  const latest = history.cursors.at(-1);
  const following = active && pendingRestore === null && allowLatest;
  return (
    <TranscriptDisclosureProvider
      initialState={new Map(saved?.disclosures.map(({ key, ...choice }) => [key, choice]))}
      onInspect={inspect}
    >
      <MessageScrollerProvider
        autoScroll={following}
        defaultScrollPosition={defaultPosition}
        scrollEdgeThreshold={8}
      >
        <MessageScroller className="min-h-0 flex-1">
          <PreserveReadingPosition
            active={active && pendingRestore === null}
            viewportRef={viewportRef}
            revision={revision}
          >
            <ConversationViewport
              viewportRef={viewportRef}
              following={following}
              onNavigate={navigate}
              onInteract={() => setPendingRestore(null)}
            >
              <MessageScrollerContent className="mx-auto w-full max-w-[38.5rem] gap-0 px-4 pt-5 pb-8 sm:px-2 [&>*]:-mx-2 [&>*]:px-2">
                <Transcript document={document} runTask={runTask} history={history} />
              </MessageScrollerContent>
            </ConversationViewport>
          </PreserveReadingPosition>
          <RestoreReader
            target={pendingRestore}
            rows={rows}
            viewportRef={viewportRef}
            active={active}
            history={{
              earlier: latest,
              loading: history.loading,
              error: history.error,
              load: () => {
                if (latest !== undefined) history.load(latest);
              },
            }}
            onRestored={restored}
          />
          <RememberReader
            runId={runId}
            rows={rows}
            viewportRef={viewportRef}
            readThrough={unread.readThrough}
            active={active}
            restoring={pendingRestore !== null}
            allowLatest={allowLatest}
            initialPosition={saved?.position ?? { _tag: "Latest" }}
          />
          <RevealTarget target={pendingTarget} onRevealed={revealed} />
          <TrackReading document={document} active={active} onReading={onReading} />
          <UpdateNavigation
            count={unread.keys.size}
            active={active}
            pendingLatest={pendingLatest}
            revealing={pendingTarget !== null}
            onObserve={observe}
            onLatest={jumpLatest}
            onReachedLatest={reachedLatest}
          />
        </MessageScroller>
      </MessageScrollerProvider>
    </TranscriptDisclosureProvider>
  );
};

/** Renders a Run's Attempts as one document that follows new activity until the reader scrolls away. */
export const Conversation = memo(Reader);
