import { CaretRightIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import type { AttemptId } from "@usine/core/attempt";
import type { RunView } from "@usine/orchestrator/operator";
import { Option } from "effect";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { StateMark } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  attemptStartLabel,
  dayTimeLabel,
  durationLabel,
  timestampLabel,
} from "../operator-copy.ts";
import { Elapsed } from "../run-transcript/activity.tsx";
import {
  outlineEntries,
  type Chapter,
  type Checkpoint,
  type ReaderDocument,
  type ReadingPlace,
  type TurnsEntry,
} from "../run-transcript/document/model.ts";
import { previewText } from "../run-transcript/document/text.ts";
import { SessionHandoff } from "../run-transcript/handoff.tsx";
import type { TranscriptSession } from "../run-transcript/model.ts";
import { ApprovalLine } from "./approval.tsx";
import { RunAgainLine } from "./run-again.tsx";

/** The part of the Run the reader shows: the Task, the Event, or an Attempt and one of its sessions. */
export type OutlineSelection =
  | { readonly _tag: "Task" }
  | { readonly _tag: "Event" }
  | {
      readonly _tag: "Attempt";
      readonly attemptId: AttemptId;
      /** The session chosen in the outline; the composer addresses it while it is live. */
      readonly sessionKey: string | null;
    };

const entry =
  "relative block w-full rounded-md py-1.5 pr-2 pl-6 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/70 aria-[current=true]:bg-muted";

const chapterState = (chapter: Chapter): string =>
  chapter.live
    ? "Running"
    : Option.match(
        Option.flatMap(chapter.attempt, ({ outcome }) => Option.fromNullishOr(outcome)),
        {
          onNone: () => {
            const ending = chapter.rows.at(-1);
            return ending?._tag === "Ending" ? ending.end._tag : "Ended";
          },
          onSome: ({ _tag }) => _tag,
        },
      );

/** An Attempt's span, from its start to its recorded end. */
const chapterSpan = (chapter: Chapter): Option.Option<string> =>
  Option.flatMap(chapter.attempt, ({ startedAt }) =>
    Option.map(chapter.endedAt, (ended) =>
      durationLabel(Date.parse(ended) - Date.parse(startedAt)),
    ),
  );

/** A live session's supervision state, worded for the outline; a working session counts its time. */
const sessionStatus = (
  session: TranscriptSession,
): { readonly text: string; readonly tone: string; readonly since?: string } | null => {
  if (session.status !== "Live") return null;
  if (session.paused) return { text: "Paused", tone: "text-needs-you" };
  if (session.held)
    return session.idle
      ? { text: "Held, waiting for you", tone: "text-needs-you" }
      : { text: "Held", tone: "text-run-active" };
  if (session.idle) return { text: "Waiting for you", tone: "text-needs-you" };
  return { text: "Working", tone: "text-run-active", since: session.receivedAt };
};

const sessionName = (session: TranscriptSession) =>
  session.session._tag === "ParentSession" ? "Parent" : session.session.agent;

const ResumeDetails = ({ session }: { readonly session: TranscriptSession }) => (
  <Popover>
    <PopoverTrigger
      render={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Resume details for ${sessionName(session)}`}
          title="Resume details"
          className="text-muted-foreground"
        />
      }
    >
      <TerminalWindowIcon aria-hidden="true" />
    </PopoverTrigger>
    <PopoverContent
      side="right"
      align="start"
      className="w-[28rem] max-w-[calc(100vw-2rem)] p-3 shadow-raised"
    >
      <SessionHandoff session={session} />
    </PopoverContent>
  </Popover>
);

const checkpointRow =
  "flex h-6.5 w-full min-w-0 items-center gap-1.5 rounded-md pr-1 pl-1.5 text-left outline-none transition-colors duration-(--duration-fast) ease-out-expo hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/70 aria-[current=location]:font-medium";

const checkpointTone = (tone: Checkpoint["tone"]) =>
  tone === "failed"
    ? "text-destructive"
    : tone === "warning"
      ? "text-warning"
      : "text-muted-foreground aria-[current=location]:text-foreground";

const CheckpointButton = ({
  checkpoint,
  current,
  named,
  onCheckpoint,
}: {
  readonly checkpoint: Checkpoint;
  readonly current: string | null;
  /** Shows who said it, for a checkpoint listed outside its session's folded turns. */
  readonly named: boolean;
  readonly onCheckpoint: (checkpoint: Checkpoint) => void;
}) => (
  <button
    type="button"
    title={checkpoint.text}
    aria-current={checkpoint.key === current ? "location" : undefined}
    onClick={() => onCheckpoint(checkpoint)}
    className={cn(checkpointRow, checkpointTone(checkpoint.tone))}
  >
    {named && checkpoint.speaker !== null && (
      <span className="shrink-0 text-sidebar-foreground">{checkpoint.speaker}</span>
    )}
    <span className="truncate">{checkpoint.label}</span>
  </button>
);

/**
 * An Attempt's checkpoints on one rail, in conversation order: each run of one
 * session's turns as one entry that opens to its sentences, and every other
 * checkpoint as its own entry. The reading mark sits on the checkpoint being
 * read, or on its folded entry while that entry is closed.
 */
const Timeline = ({
  chapter,
  current,
  onCheckpoint,
}: {
  readonly chapter: Chapter;
  /** The checkpoint at the reader's reading line, marked on the rail. */
  readonly current: string | null;
  readonly onCheckpoint: (checkpoint: Checkpoint) => void;
}) => {
  const entries = outlineEntries(chapter);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const marked =
    entries.find(
      (entry): entry is TurnsEntry =>
        entry._tag === "Turns" &&
        !opened.has(entry.key) &&
        entry.turns.some(({ key }) => key === current),
    )?.key ?? current;
  const railRef = useRef<HTMLOListElement>(null);
  const [mark, setMark] = useState<number | null>(null);
  useLayoutEffect(() => {
    const rail = railRef.current;
    if (rail === null) return;
    const place = () => {
      const row = Array.from(rail.querySelectorAll<HTMLElement>("[data-outline-mark]")).find(
        (element) => element.dataset.outlineMark === marked,
      );
      setMark(
        row === undefined
          ? null
          : row.getBoundingClientRect().top - rail.getBoundingClientRect().top + 4,
      );
    };
    place();
    // Opening a fold moves the rows below it while it grows.
    const observer = new ResizeObserver(place);
    observer.observe(rail);
    return () => observer.disconnect();
  }, [marked]);
  if (entries.length === 0) return null;
  const toggle = (key: string) =>
    setOpened((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return (
    <ol ref={railRef} className="relative mt-1 ml-2 space-y-px border-l pl-0.5">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-0 -left-px h-4.5 w-px bg-foreground transition-[transform,opacity] duration-(--duration-base) ease-out-expo"
        style={{ transform: `translateY(${mark ?? 0}px)`, opacity: mark === null ? 0 : 1 }}
      />
      {entries.map((entry) => {
        if (entry._tag === "Mark")
          return (
            <li key={entry.checkpoint.key} data-outline-mark={entry.checkpoint.key}>
              <CheckpointButton
                checkpoint={entry.checkpoint}
                current={current}
                named
                onCheckpoint={onCheckpoint}
              />
            </li>
          );
        const open = opened.has(entry.key);
        const reading = entry.turns.some(({ key }) => key === current);
        const count = `${entry.turns.length} ${entry.turns.length === 1 ? "message" : "messages"}`;
        return (
          <li key={entry.key}>
            <button
              type="button"
              data-outline-mark={entry.key}
              aria-expanded={open}
              aria-current={!open && reading ? "location" : undefined}
              aria-label={`${entry.speaker}, ${count}`}
              onClick={() => toggle(entry.key)}
              className={cn(
                checkpointRow,
                "justify-between text-muted-foreground aria-[current=location]:text-foreground",
              )}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <CaretRightIcon
                  aria-hidden="true"
                  className={cn(
                    "size-3 shrink-0 transition-transform duration-(--duration-fast) ease-out-expo",
                    open && "rotate-90",
                  )}
                />
                <span className="truncate text-sidebar-foreground">{entry.speaker}</span>
              </span>
              <span className="shrink-0 text-xs tabular-nums">{count}</span>
            </button>
            <Collapsible open={open}>
              <CollapsibleContent className="collapsible-motion">
                <ol className="space-y-px pl-4.5">
                  {entry.turns.map((turn) => (
                    <li key={turn.key} data-outline-mark={turn.key}>
                      <CheckpointButton
                        checkpoint={turn}
                        current={current}
                        named={false}
                        onCheckpoint={onCheckpoint}
                      />
                    </li>
                  ))}
                </ol>
              </CollapsibleContent>
            </Collapsible>
          </li>
        );
      })}
    </ol>
  );
};

const ChapterTree = ({
  chapter,
  selectedSession,
  current,
  onSession,
  onCheckpoint,
}: {
  readonly chapter: Chapter;
  readonly selectedSession: string | null;
  readonly current: string | null;
  readonly onSession: (sessionKey: string) => void;
  readonly onCheckpoint: (checkpoint: Checkpoint) => void;
}) => (
  <div className="space-y-0.5 pt-0.5 pb-1.5 pl-4">
    {chapter.sessions.map((session) => {
      const status = sessionStatus(session);
      return (
        <div key={session.key}>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              aria-current={selectedSession === session.key}
              onClick={() => onSession(session.key)}
              className="flex h-7 min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-2 text-left text-sidebar-foreground outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/70 aria-[current=true]:font-medium aria-[current=true]:text-foreground"
            >
              <span className="truncate">{sessionName(session)}</span>
              {status !== null && (
                <span className={cn("flex shrink-0 items-baseline gap-1.5 text-xs", status.tone)}>
                  {status.text}
                  {status.since !== undefined && (
                    <Elapsed since={status.since} className="text-muted-foreground" />
                  )}
                </span>
              )}
            </button>
            {session.session._tag === "ChildSession" && <ResumeDetails session={session} />}
          </div>
        </div>
      );
    })}
    <Timeline chapter={chapter} current={current} onCheckpoint={onCheckpoint} />
  </div>
);

/**
 * The Run's parts: Task and Event with a preview each, the Event with who ran the Run again and
 * its approval when it has them, then each Attempt. While the reader
 * is shown, the Attempt being read opens to its sessions and checkpoints, and the
 * checkpoint at the reading line is marked.
 */
export const Outline = ({
  run,
  eventPreview,
  document,
  selection,
  reading,
  composerSession,
  onSelect,
  onCheckpoint,
  errors,
  className,
  id,
}: {
  readonly run: RunView;
  readonly eventPreview: string;
  readonly document: ReaderDocument;
  readonly selection: OutlineSelection;
  /** Where the reader is; it decides the open Attempt while an Attempt is selected. */
  readonly reading: ReadingPlace | null;
  /** The session the composer addresses, marked as selected. */
  readonly composerSession: string | null;
  readonly onSelect: (selection: OutlineSelection) => void;
  readonly onCheckpoint: (checkpoint: Checkpoint, chapter: Chapter) => void;
  readonly errors: ReactNode;
  readonly className?: string;
  readonly id?: string;
}) => {
  const navRef = useRef<HTMLElement>(null);
  const open = selection._tag === "Attempt" ? (reading?.attemptId ?? selection.attemptId) : null;
  const current = selection._tag === "Attempt" ? (reading?.checkpointKey ?? null) : null;
  useEffect(() => {
    // Keep the marked checkpoint in view when the outline scrolls on its own.
    const nav = navRef.current;
    if (nav === null || current === null || nav.scrollHeight <= nav.clientHeight) return;
    const marked = nav.querySelector<HTMLElement>('[aria-current="location"]');
    if (marked === null) return;
    const bounds = marked.getBoundingClientRect();
    const frame = nav.getBoundingClientRect();
    if (bounds.top < frame.top) nav.scrollTop -= frame.top - bounds.top + 8;
    else if (bounds.bottom > frame.bottom) nav.scrollTop += bounds.bottom - frame.bottom + 8;
  }, [current]);
  return (
    <nav
      ref={navRef}
      id={id}
      aria-label="Run outline"
      className={cn("space-y-0.5 text-sm", className)}
    >
      <button
        type="button"
        aria-current={selection._tag === "Task"}
        onClick={() => onSelect({ _tag: "Task" })}
        className={entry}
      >
        <span className="block font-medium">Task</span>
        <span className="line-clamp-2 text-xs text-muted-foreground">{previewText(run.task)}</span>
      </button>
      <button
        type="button"
        aria-current={selection._tag === "Event"}
        onClick={() => onSelect({ _tag: "Event" })}
        className={entry}
      >
        <span className="block font-medium">Event</span>
        <span className="line-clamp-2 text-xs text-muted-foreground">{eventPreview}</span>
        <RunAgainLine run={run} className="mt-0.5 block text-xs" />
        <ApprovalLine approval={run.approval} className="mt-0.5 block text-xs" />
      </button>
      <div className="h-2.5" />
      {document.chapters.map((chapter) => {
        const expanded = open === chapter.attemptId;
        const state = chapterState(chapter);
        const name = Option.match(chapter.attempt, {
          onNone: () => "Attempt",
          onSome: ({ number }) => `Attempt ${number}`,
        });
        return (
          <div key={chapter.key}>
            <button
              type="button"
              aria-current={expanded}
              aria-expanded={expanded}
              aria-label={`${name}, ${state.toLowerCase()}`}
              onClick={() =>
                onSelect({ _tag: "Attempt", attemptId: chapter.attemptId, sessionKey: null })
              }
              className={entry}
            >
              <StateMark state={state} className="absolute top-3 left-2.5" />
              <span className="flex items-center justify-between font-medium">
                {name}
                <CaretRightIcon
                  aria-hidden="true"
                  className={cn(
                    "size-3 text-muted-foreground transition-transform",
                    expanded && "rotate-90",
                  )}
                />
              </span>
              {Option.match(chapter.attempt, {
                onNone: () => null,
                onSome: ({ startedAt, start, reattachedAt }) => (
                  <>
                    {start !== null && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {attemptStartLabel(start)}
                      </span>
                    )}
                    {reattachedAt !== null && (
                      <span
                        className="block truncate text-xs text-muted-foreground"
                        title={`Reattached ${timestampLabel(reattachedAt)}`}
                      >
                        Reattached after a restart
                      </span>
                    )}
                    <span className="flex justify-between gap-3 font-mono text-xs tabular-nums text-muted-foreground">
                      <time dateTime={startedAt}>{dayTimeLabel(startedAt)}</time>
                      {chapter.live ? (
                        <Elapsed since={startedAt} />
                      ) : (
                        Option.match(chapterSpan(chapter), {
                          onNone: () => null,
                          onSome: (span) => <span>{span}</span>,
                        })
                      )}
                    </span>
                  </>
                ),
              })}
            </button>
            <Collapsible open={expanded}>
              <CollapsibleContent className="collapsible-motion">
                <ChapterTree
                  chapter={chapter}
                  selectedSession={
                    composerSession ??
                    (selection._tag === "Attempt" && selection.attemptId === chapter.attemptId
                      ? selection.sessionKey
                      : null)
                  }
                  current={current}
                  onSession={(sessionKey) =>
                    onSelect({ _tag: "Attempt", attemptId: chapter.attemptId, sessionKey })
                  }
                  onCheckpoint={(checkpoint) => onCheckpoint(checkpoint, chapter)}
                />
              </CollapsibleContent>
            </Collapsible>
          </div>
        );
      })}
      {errors !== null && <div className="mt-3 border-t px-2 pt-3">{errors}</div>}
    </nav>
  );
};
