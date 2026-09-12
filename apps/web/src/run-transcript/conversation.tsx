import type { RunId } from "@usine/core/run";
import type {
  AttemptView,
  RunStateTag,
  TranscriptEventView,
  TranscriptPageCursor,
} from "@usine/orchestrator/operator";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ErrorAlert } from "@/components/error-alert";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { projectTranscript, type TranscriptFilter } from "./model.ts";
import { PreserveReadingPosition } from "./scroll-position.tsx";
import { Transcript } from "./transcript.tsx";
import { SessionActivity } from "./activity.tsx";
import { TranscriptDisclosureProvider } from "./grouping/disclosure.tsx";
import {
  acknowledgeUnread,
  advanceUnread,
  indexTranscriptUpdates,
  initializeUnread,
  type TranscriptUpdate,
} from "./navigation/model.ts";
import { ErrorControls, RevealError } from "./navigation/errors.tsx";
import { UpdateNavigation } from "./navigation/updates.tsx";

import { readerMemory, type ReadingAnchor } from "./reader/memory.ts";
import { readingRows } from "./reader/anchor.ts";
import { RestoreReader } from "./reader/restore.tsx";
import { RememberReader } from "./reader/remember.tsx";
import { ParentTarget } from "@usine/core/attempt/channel";
import { SessionComposer } from "../run-intervention/session-composer.tsx";

/** A Run's conversation follows incoming activity until the reader scrolls away. */
export const Conversation = ({
  runId,
  events,
  sessionState = [],
  attempts,
  earlier,
  loadEarlier,
  loadingEarlier,
  earlierError,
  state,
  active,
}: {
  readonly runId: RunId;
  readonly events: ReadonlyArray<TranscriptEventView>;
  readonly sessionState?: ReadonlyArray<TranscriptEventView>;
  readonly attempts: ReadonlyArray<AttemptView>;
  readonly earlier: TranscriptPageCursor | undefined;
  readonly loadEarlier: () => void;
  readonly loadingEarlier: boolean;
  readonly earlierError: string | null;
  readonly state: RunStateTag;
  readonly active: boolean;
}) => {
  const [saved] = useState(() => readerMemory(() => window.localStorage).read(runId, Date.now()));
  const [pendingRestore, setPendingRestore] = useState<ReadingAnchor | null>(
    saved?.position._tag === "Anchor" ? saved.position : null,
  );
  const [allowLatest, setAllowLatest] = useState(pendingRestore === null);
  const [defaultPosition, setDefaultPosition] = useState<"start" | "end">(
    pendingRestore === null ? "end" : "start",
  );
  const restored = useCallback(() => setPendingRestore(null), []);
  const inspect = useCallback(() => {
    setPendingRestore(null);
    setAllowLatest(false);
  }, []);
  const navigate = () => {
    setPendingRestore(null);
    setAllowLatest(true);
  };
  const [filter, setFilter] = useState<TranscriptFilter>(saved?.filter ?? "all");
  const viewportRef = useRef<HTMLDivElement>(null);
  const projection = useMemo(
    () => projectTranscript(events, attempts, sessionState),
    [events, attempts, sessionState],
  );
  const parent = projection.sessions.find(
    (session) => session.session._tag === "ParentSession" && session.status === "Live",
  );
  const updates = useMemo(() => indexTranscriptUpdates(projection), [projection]);
  const rows = useMemo(() => readingRows(projection, filter), [projection, filter]);
  const through = events.reduce<TranscriptEventView["sequence"] | null>(
    (latest, event) => (latest === null || event.sequence > latest ? event.sequence : latest),
    null,
  );
  const [unread, setUnread] = useState(() =>
    initializeUnread(saved === null ? through : saved.readThrough),
  );
  const [selectedErrorKey, setSelectedErrorKey] = useState<string | null>(null);
  const [pendingError, setPendingError] = useState<TranscriptUpdate | null>(null);
  const [pendingLatest, setPendingLatest] = useState(false);
  const observe = useCallback(
    (atLatest: boolean) => {
      setUnread((previous) => {
        const next = advanceUnread(previous, updates, through);
        return atLatest && pendingRestore === null && allowLatest ? acknowledgeUnread(next) : next;
      });
    },
    [updates, through, pendingRestore, allowLatest],
  );
  const selectError = (error: TranscriptUpdate) => {
    inspect();
    setDefaultPosition("start");
    setFilter("all");
    setSelectedErrorKey(error.key);
    setPendingError(error);
    setPendingLatest(false);
  };
  const jumpLatest = () => {
    navigate();
    setDefaultPosition("end");
    setFilter("all");
    setPendingLatest(true);
    setPendingError(null);
  };
  const reachedLatest = useCallback(() => setPendingLatest(false), []);
  const revealedError = useCallback(() => setPendingError(null), []);
  const [, refreshTime] = useReducer((version: number) => version + 1, 0);
  useEffect(() => {
    const timer = setInterval(refreshTime, 60_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-2 sm:px-6">
        <ButtonGroup aria-label="Conversation filter">
          {(["all", "messages", "tools"] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={filter === value ? "secondary" : "ghost"}
              aria-pressed={filter === value}
              onClick={() => {
                navigate();
                setDefaultPosition("end");
                setFilter(value);
                setPendingError(null);
                setPendingLatest(false);
              }}
            >
              {{ all: "Everything", messages: "Messages", tools: "Tools" }[value]}
            </Button>
          ))}
        </ButtonGroup>
        <div className="flex items-center gap-3">
          <ErrorControls
            errors={updates.filter((update) => update.isError)}
            selectedKey={selectedErrorKey}
            earlier={earlier !== undefined}
            onSelect={selectError}
          />
          <span className="text-muted-foreground">{state === "Running" ? "Live" : state}</span>
        </div>
      </div>
      <SessionActivity events={events} attempts={attempts} />
      <TranscriptDisclosureProvider
        initialState={new Map(saved?.disclosures.map(({ key, ...choice }) => [key, choice]))}
        onInspect={inspect}
      >
        <MessageScrollerProvider
          key={filter}
          autoScroll={active && pendingRestore === null && allowLatest}
          defaultScrollPosition={defaultPosition}
          scrollEdgeThreshold={8}
        >
          <MessageScroller className="min-h-0 flex-1">
            <PreserveReadingPosition
              active={active && pendingRestore === null}
              viewportRef={viewportRef}
              revision={
                events.length + attempts.filter((attempt) => attempt.outcome !== null).length
              }
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
                <MessageScrollerContent className="gap-4 px-4 pt-4 pb-16 sm:px-6">
                  {earlier !== undefined && (
                    <MessageScrollerItem messageId="history" className="flex justify-center">
                      <Button
                        variant="outline"
                        size="sm"
                        className="self-center"
                        disabled={loadingEarlier}
                        onClick={loadEarlier}
                      >
                        {loadingEarlier ? "Loading…" : "Load earlier"}
                      </Button>
                    </MessageScrollerItem>
                  )}
                  {earlierError !== null && (
                    <MessageScrollerItem messageId="history-error">
                      <ErrorAlert message={earlierError} />
                    </MessageScrollerItem>
                  )}
                  <Transcript events={events} attempts={attempts} filter={filter} runId={runId} />
                </MessageScrollerContent>
              </MessageScrollerViewport>
            </PreserveReadingPosition>
            <RestoreReader
              target={pendingRestore}
              rows={rows}
              viewportRef={viewportRef}
              active={active}
              history={{ earlier, loading: loadingEarlier, error: earlierError, load: loadEarlier }}
              onRestored={restored}
            />
            <RememberReader
              runId={runId}
              filter={filter}
              rows={rows}
              viewportRef={viewportRef}
              readThrough={unread.readThrough}
              active={active}
              restoring={pendingRestore !== null}
              allowLatest={allowLatest}
              initialPosition={saved?.position ?? { _tag: "Latest" }}
            />
            <RevealError target={pendingError} filter={filter} onRevealed={revealedError} />
            <UpdateNavigation
              count={unread.keys.size}
              active={active}
              filter={filter}
              pendingLatest={pendingLatest}
              revealingError={pendingError !== null}
              onObserve={observe}
              onLatest={jumpLatest}
              onReachedLatest={reachedLatest}
            />
          </MessageScroller>
        </MessageScrollerProvider>
      </TranscriptDisclosureProvider>
      {state === "Running" && parent !== undefined && (
        <div className="shrink-0 px-4 pb-4 sm:px-6">
          <SessionComposer
            key={parent.attemptId}
            runId={runId}
            attemptId={parent.attemptId}
            target={new ParentTarget()}
            paused={parent.paused}
          />
        </div>
      )}
    </>
  );
};
