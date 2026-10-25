import { CaretRightIcon } from "@phosphor-icons/react";
import type { AttemptId } from "@usine/core/attempt";
import { ChildTarget, ParentTarget } from "@usine/core/attempt/channel";
import type { RunDetailView } from "@usine/orchestrator/operator";
import { Option } from "effect";
import { useCallback, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { SessionComposer } from "../run-intervention/session-composer.tsx";
import { Conversation, type ReaderRequest } from "../run-transcript/conversation.tsx";
import {
  readerDocument,
  type Chapter,
  type ChapterRow,
  type ReaderDocument,
  type ReadingPlace,
} from "../run-transcript/document/model.ts";
import { withGitHubChanges } from "../run-transcript/document/github-changes.ts";
import { projectTranscript } from "../run-transcript/model.ts";
import {
  ErrorControls,
  updateTarget,
  type ReaderTarget,
} from "../run-transcript/navigation/errors.tsx";
import { errorTally, type NavigableRow } from "../run-transcript/navigation/model.ts";
import { ReaderLine, type TranscriptHistory } from "../run-transcript/transcript.tsx";
import { EventDocument, TaskDocument } from "./documents.tsx";
import { useRunGitHubChanges } from "./github-changes.ts";
import { eventPreview } from "./item.ts";
import { Outline, type OutlineSelection } from "./outline.tsx";

const rowKeys = (row: ChapterRow): ReadonlyArray<string> => {
  switch (row._tag) {
    case "Burst":
      return [row.key, ...row.tools.map((tool) => tool.key)];
    case "Delegation":
      return [row.key, row.tool.key];
    case "Ending":
    case "GitHubChange":
    case "BoardMove":
      return [row.key];
    case "Message":
    case "Note":
      return [row.key];
  }
};

const chapterOf = (document: ReaderDocument, key: string): Chapter | undefined =>
  document.chapters.find((chapter) => chapter.rows.some((row) => rowKeys(row).includes(key)));

const rowSession = (row: ChapterRow): string | null => {
  switch (row._tag) {
    case "Burst":
    case "Delegation":
    case "Message":
      return row.speaker.sessionKey;
    case "Note":
    case "Ending":
      return row.speaker?.sessionKey ?? null;
    case "GitHubChange":
    case "BoardMove":
      return null;
  }
};

export const RunWorkspace = ({
  detail,
  history,
}: {
  readonly detail: RunDetailView;
  readonly history: TranscriptHistory;
}) => {
  const run = detail.run;
  const outlineId = useId();
  const githubChanges = useRunGitHubChanges(run);
  const document = useMemo(
    () =>
      withGitHubChanges(
        readerDocument(
          projectTranscript(detail.transcript, run.attempts, detail.sessionState),
          run.attempts,
          detail.transcript,
        ),
        new Map(githubChanges.data?.attempts.map(({ attemptId, changes }) => [attemptId, changes])),
        new Set(detail.earlierTranscript.map(({ attemptId }) => attemptId)),
      ),
    [
      detail.transcript,
      detail.sessionState,
      detail.earlierTranscript,
      run.attempts,
      githubChanges.data,
    ],
  );
  const tally = useMemo(() => errorTally(document), [document]);
  const through = detail.transcript.reduce<RunDetailView["transcript"][number]["sequence"] | null>(
    (latest, event) => (latest === null || event.sequence > latest ? event.sequence : latest),
    null,
  );
  const revision =
    detail.transcript.length +
    run.attempts.filter(({ outcome }) => outcome !== null).length +
    document.chapters.reduce(
      (count, { rows }) =>
        count + rows.filter(({ _tag }) => _tag === "GitHubChange" || _tag === "BoardMove").length,
      0,
    );
  const [chosen, setChosen] = useState<OutlineSelection | null>(null);
  const latest = document.chapters.at(-1);
  const selection: OutlineSelection =
    chosen ??
    (latest === undefined
      ? { _tag: "Task" }
      : { _tag: "Attempt", attemptId: latest.attemptId, sessionKey: null });
  const [request, setRequest] = useState<ReaderRequest | null>(null);
  const requests = useRef(0);
  const show = (target: ReaderTarget) => {
    requests.current += 1;
    setRequest({ id: requests.current, target });
  };
  const [selectedError, setSelectedError] = useState<string | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [place, setPlace] = useState<ReadingPlace | null>(null);
  const follow = useCallback(
    (next: ReadingPlace) =>
      setPlace((previous) =>
        previous?.attemptId === next.attemptId && previous.checkpointKey === next.checkpointKey
          ? previous
          : next,
      ),
    [],
  );

  const live = [...document.chapters].reverse().find((chapter) => chapter.live);
  const liveSessions = live?.sessions.filter(({ status }) => status === "Live") ?? [];
  const composer =
    (selection._tag === "Attempt" && selection.attemptId === live?.attemptId
      ? liveSessions.find(({ key }) => key === selection.sessionKey)
      : undefined) ?? liveSessions.find(({ session }) => session._tag === "ParentSession");

  const [returnTo, setReturnTo] = useState<AttemptId | null>(null);
  const select = (next: OutlineSelection) => {
    setChosen(next);
    setOutlineOpen(false);
    if (next._tag !== "Attempt") {
      if (selection._tag === "Attempt") setReturnTo(selection.attemptId);
      return;
    }
    // Returning from the Task or Event to the Attempt being read keeps the scroll position.
    if (selection._tag !== "Attempt" && next.attemptId === returnTo && next.sessionKey === null)
      return;
    const chapter = document.chapters.find(({ attemptId }) => attemptId === next.attemptId);
    if (chapter === undefined) return;
    const first =
      next.sessionKey === null
        ? undefined
        : chapter.rows.find((row) => rowSession(row) === next.sessionKey);
    // Selects the Attempt in the outline now, before the reader reports it after scrolling.
    follow({ attemptId: chapter.attemptId, checkpointKey: null });
    show({ messageId: first?.key ?? chapter.key, tool: null });
  };
  const selectError = (error: NavigableRow) => {
    setSelectedError(error.key);
    const chapter = chapterOf(document, error.key);
    if (chapter !== undefined) {
      setChosen({ _tag: "Attempt", attemptId: chapter.attemptId, sessionKey: null });
      follow({ attemptId: chapter.attemptId, checkpointKey: null });
    }
    show(updateTarget(error));
  };
  const showsReader = selection._tag === "Attempt";
  const shownAttempt =
    selection._tag === "Attempt" ? (place?.attemptId ?? selection.attemptId) : null;
  const selectionName =
    shownAttempt === null
      ? selection._tag
      : Option.match(
          Option.flatMap(
            Option.fromNullishOr(
              document.chapters.find(({ attemptId }) => attemptId === shownAttempt),
            ),
            ({ attempt }) => attempt,
          ),
          { onNone: () => "Attempt", onSome: ({ number }) => `Attempt ${number}` },
        );
  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <button
        type="button"
        aria-expanded={outlineOpen}
        aria-controls={outlineId}
        onClick={() => setOutlineOpen((open) => !open)}
        className="mx-4 mb-2 flex h-9 items-center justify-between gap-3 rounded-md border px-3 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/70 md:mx-5 lg:hidden"
      >
        <span className="font-medium">Outline</span>
        <span className="flex items-center gap-2 text-muted-foreground">
          {selectionName}
          <CaretRightIcon
            aria-hidden="true"
            className={cn("size-3 transition-transform", outlineOpen && "rotate-90")}
          />
        </span>
      </button>
      <Outline
        id={outlineId}
        run={run}
        eventPreview={eventPreview(run.loop, detail.eventPayload)}
        document={document}
        selection={selection}
        reading={place}
        composerSession={composer?.key ?? null}
        machine={detail.machine}
        onSelect={select}
        onCheckpoint={(checkpoint, chapter) => {
          setChosen((previous) =>
            previous?._tag === "Attempt" && previous.attemptId === chapter.attemptId
              ? previous
              : { _tag: "Attempt", attemptId: chapter.attemptId, sessionKey: null },
          );
          setOutlineOpen(false);
          follow({ attemptId: chapter.attemptId, checkpointKey: checkpoint.key });
          show({ messageId: checkpoint.key, tool: null });
        }}
        errors={
          tally.errors.length === 0 && tally.recovered.length === 0 ? null : (
            <div className="space-y-0.5">
              <ErrorControls
                errors={tally.errors}
                selectedKey={selectedError}
                earlier={history.cursors.length > 0}
                onSelect={selectError}
              />
              <ErrorControls
                errors={tally.recovered}
                kind="recovered"
                selectedKey={selectedError}
                earlier={history.cursors.length > 0}
                onSelect={selectError}
              />
            </div>
          )
        }
        className={cn(
          "shrink-0 overflow-y-auto px-3 pb-4 lg:block lg:w-72 lg:border-r",
          outlineOpen
            ? "mx-4 mb-3 max-h-[60svh] rounded-md border md:mx-5 lg:mx-0 lg:mb-0 lg:max-h-none lg:rounded-none lg:border-y-0 lg:border-l-0"
            : "hidden",
        )}
      />
      <section
        aria-label="Reader"
        className="relative flex min-h-[28rem] min-w-0 flex-1 flex-col border-t lg:min-h-0 lg:border-t-0"
      >
        {selection._tag === "Task" && <TaskDocument task={run.task} />}
        {selection._tag === "Event" && <EventDocument detail={detail} />}
        {showsReader && githubChanges.isError && (
          <p className="mx-auto w-full max-w-[38.5rem] px-4 pt-3 text-xs text-muted-foreground sm:px-2">
            GitHub changes not loaded: {githubChanges.error.message}
          </p>
        )}
        <div className={cn("flex min-h-0 flex-1 flex-col", !showsReader && "hidden")}>
          <Conversation
            runId={run.id}
            document={document}
            through={through}
            revision={revision}
            runTask={run.task}
            history={history}
            active={showsReader}
            request={request}
            onReading={follow}
          />
        </div>
        {showsReader && composer !== undefined && (
          <div className="shrink-0 border-t">
            <div className="mx-auto w-full max-w-[38.5rem] px-4 py-3 sm:px-2">
              <ReaderLine>
                <SessionComposer
                  key={composer.key}
                  runId={run.id}
                  attemptId={composer.attemptId}
                  target={
                    composer.session._tag === "ParentSession"
                      ? new ParentTarget()
                      : new ChildTarget({ sessionId: composer.session.id })
                  }
                  paused={composer.paused}
                  held={composer.held}
                />
              </ReaderLine>
            </div>
          </div>
        )}
      </section>
    </div>
  );
};
