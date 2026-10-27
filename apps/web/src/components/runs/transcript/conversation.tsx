import type { RunId } from "@usine/core/run";
import type { TranscriptSequence } from "@usine/engine/transcript";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { ConversationViewport } from "~/components/runs/transcript/conversation-viewport";
import { TranscriptDisclosureProvider } from "~/components/runs/transcript/grouping/disclosure";
import { RevealTarget, type ReaderTarget } from "~/components/runs/transcript/navigation/errors";
import { UpdateNavigation } from "~/components/runs/transcript/navigation/updates";
import { RememberReader } from "~/components/runs/transcript/reader/remember";
import { RestoreReader } from "~/components/runs/transcript/reader/restore";
import { PreserveReadingPosition } from "~/components/runs/transcript/scroll-position";
import { TrackReading } from "~/components/runs/transcript/track-reading";
import { Transcript, type TranscriptHistory } from "~/components/runs/transcript/transcript";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerProvider,
} from "~/components/ui/message-scroller";
import { type ReaderDocument, type ReadingPlace } from "~/lib/runs/transcript/document/model";
import {
  acknowledgeUnread,
  advanceUnread,
  indexTranscriptUpdates,
  initializeUnread,
} from "~/lib/runs/transcript/navigation/model";
import { readingRows } from "~/lib/runs/transcript/reader/anchor";
import { readerMemory, type ReadingAnchor } from "~/lib/runs/transcript/reader/memory";

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

type ReaderProps = {
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
}: ReaderProps) => {
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
