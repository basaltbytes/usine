import type { RunId } from "@usine/core/run";
import type { TranscriptSequence } from "@usine/engine/transcript";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScrollerVisibility,
} from "@/components/ui/message-scroller";
import {
  readingOrder,
  readingPlace,
  type ReaderDocument,
  type ReadingPlace,
} from "./document/model.ts";
import { TranscriptDisclosureProvider } from "./grouping/disclosure.tsx";
import { PreserveReadingPosition } from "./scroll-position.tsx";
import { Transcript, type TranscriptHistory } from "./transcript.tsx";
import {
  acknowledgeUnread,
  advanceUnread,
  indexTranscriptUpdates,
  initializeUnread,
} from "./navigation/model.ts";
import { RevealTarget, type ReaderTarget } from "./navigation/errors.tsx";
import { UpdateNavigation } from "./navigation/updates.tsx";
import { readerMemory, type ReadingAnchor } from "./reader/memory.ts";
import { readingRows } from "./reader/anchor.ts";
import { RestoreReader } from "./reader/restore.tsx";
import { RememberReader } from "./reader/remember.tsx";

/** A request from outside the reader to show a place in it; a new id repeats the same place. */
export interface ReaderRequest {
  readonly id: number;
  readonly target: ReaderTarget;
}

// A narrow reader opening on a finished Run starts at its outcome's own line, not mid-message.
const narrowEntry = (document: ReaderDocument): ReaderTarget | null => {
  const last = document.chapters.at(-1);
  if (last === undefined || last.live || !window.matchMedia("(max-width: 1023px)").matches)
    return null;
  const row = [...last.rows].reverse().find(({ _tag }) => _tag === "Ending" || _tag === "Message");
  return row === undefined ? null : { messageId: row.key, tool: null };
};

/** Reports where the operator is reading while the reader is shown. */
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
  /** Newest raw transcript event, including events no row shows. */
  readonly through: TranscriptSequence | null;
  /** Changes when transcript rows grow or change, so the reading position can be kept. */
  readonly revision: number;
  readonly runTask: string;
  readonly history: TranscriptHistory;
  /** False while the reader is hidden, so it neither captures nor acknowledges. */
  readonly active: boolean;
  readonly request: ReaderRequest | null;
  /** Receives the Attempt and checkpoint being read as the reader scrolls. */
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
  return (
    <TranscriptDisclosureProvider
      initialState={new Map(saved?.disclosures.map(({ key, ...choice }) => [key, choice]))}
      onInspect={inspect}
    >
      <MessageScrollerProvider
        autoScroll={active && pendingRestore === null && allowLatest}
        defaultScrollPosition={defaultPosition}
        scrollEdgeThreshold={8}
      >
        <MessageScroller className="min-h-0 flex-1">
          <PreserveReadingPosition
            active={active && pendingRestore === null}
            viewportRef={viewportRef}
            revision={revision}
          >
            <MessageScrollerViewport
              ref={viewportRef}
              aria-label="Run conversation"
              preserveScrollOnPrepend={false}
              onWheel={navigate}
              onTouchMove={navigate}
              onPointerDown={(event) => {
                if (event.target === event.currentTarget) navigate();
                else setPendingRestore(null);
              }}
              onKeyDown={(event) => {
                // Let focused buttons activate on Space without changing the reader's follow intention.
                const activatesButton =
                  event.key === " " &&
                  event.target instanceof Element &&
                  event.target.closest('button, [role="button"]') !== null;
                if (event.key === "Enter" || activatesButton) {
                  setPendingRestore(null);
                  return;
                }
                if (
                  !event.defaultPrevented &&
                  ["ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", " "].includes(
                    event.key,
                  )
                )
                  navigate();
              }}
            >
              <MessageScrollerContent className="mx-auto w-full max-w-[38.5rem] gap-0 px-4 pt-5 pb-8 sm:px-2 [&>*]:-mx-2 [&>*]:px-2">
                <Transcript document={document} runTask={runTask} history={history} />
              </MessageScrollerContent>
            </MessageScrollerViewport>
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

/**
 * A Run's Attempts as one document that follows incoming activity until the reader scrolls
 * away, reporting the Attempt and checkpoint being read so the outline can follow.
 */
export const Conversation = memo(Reader);
