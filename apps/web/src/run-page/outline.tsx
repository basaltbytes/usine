import { CaretRightIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import type { AttemptId } from "@usine/core/attempt";
import type { RunView } from "@usine/orchestrator/operator";
import { Option } from "effect";
import type { ReactNode } from "react";
import { StateMark } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { dayTimeLabel, durationLabel } from "../operator-copy.ts";
import {
  chapterCheckpoints,
  type Chapter,
  type Checkpoint,
  type ReaderDocument,
} from "../run-transcript/document/model.ts";
import { previewText } from "../run-transcript/document/text.ts";
import { SessionHandoff } from "../run-transcript/handoff.tsx";
import type { TranscriptSession } from "../run-transcript/model.ts";

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

/** A live session's supervision state, worded for the outline. */
const sessionStatus = (
  session: TranscriptSession,
): { readonly text: string; readonly tone: string } | null => {
  if (session.status !== "Live") return null;
  if (session.paused) return { text: "Paused", tone: "text-needs-you" };
  if (session.held)
    return session.idle
      ? { text: "Held, waiting for you", tone: "text-needs-you" }
      : { text: "Held", tone: "text-run-active" };
  if (session.idle) return { text: "Waiting for you", tone: "text-needs-you" };
  return { text: "Working", tone: "text-run-active" };
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

const Checkpoints = ({
  checkpoints,
  onCheckpoint,
}: {
  readonly checkpoints: ReadonlyArray<Checkpoint>;
  readonly onCheckpoint: (checkpoint: Checkpoint) => void;
}) =>
  checkpoints.length === 0 ? null : (
    <ol className="mt-0.5 ml-2 space-y-px border-l pl-0.5">
      {checkpoints.map((checkpoint) => (
        <li key={checkpoint.key}>
          <button
            type="button"
            title={checkpoint.text}
            onClick={() => onCheckpoint(checkpoint)}
            className={cn(
              "block h-6.5 w-full truncate rounded-md pr-1 pl-1.5 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/70",
              checkpoint.tone === "failed" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {checkpoint.text}
          </button>
        </li>
      ))}
    </ol>
  );

const ChapterTree = ({
  chapter,
  selectedSession,
  onSession,
  onCheckpoint,
}: {
  readonly chapter: Chapter;
  readonly selectedSession: string | null;
  readonly onSession: (sessionKey: string) => void;
  readonly onCheckpoint: (checkpoint: Checkpoint) => void;
}) => {
  const checkpoints = chapterCheckpoints(chapter);
  const unattributed = checkpoints.filter(
    ({ sessionKey }) =>
      sessionKey === null || !chapter.sessions.some(({ key }) => key === sessionKey),
  );
  return (
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
                  <span className={cn("shrink-0 text-xs", status.tone)}>{status.text}</span>
                )}
              </button>
              {session.session._tag === "ChildSession" && <ResumeDetails session={session} />}
            </div>
            <Checkpoints
              checkpoints={checkpoints.filter(({ sessionKey }) => sessionKey === session.key)}
              onCheckpoint={onCheckpoint}
            />
          </div>
        );
      })}
      <Checkpoints checkpoints={unattributed} onCheckpoint={onCheckpoint} />
    </div>
  );
};

/** The Run's parts: Task and Event with a preview each, then each Attempt; the selected Attempt opens to its sessions and checkpoints. */
export const Outline = ({
  run,
  eventPreview,
  document,
  selection,
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
  /** The session the composer addresses, marked as selected. */
  readonly composerSession: string | null;
  readonly onSelect: (selection: OutlineSelection) => void;
  readonly onCheckpoint: (checkpoint: Checkpoint, chapter: Chapter) => void;
  readonly errors: ReactNode;
  readonly className?: string;
  readonly id?: string;
}) => (
  <nav id={id} aria-label="Run outline" className={cn("space-y-0.5 text-sm", className)}>
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
    </button>
    <div className="h-2.5" />
    {document.chapters.map((chapter) => {
      const expanded = selection._tag === "Attempt" && selection.attemptId === chapter.attemptId;
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
              onSome: ({ startedAt }) => (
                <span className="flex justify-between gap-3 font-mono text-xs tabular-nums text-muted-foreground">
                  <time dateTime={startedAt}>{dayTimeLabel(startedAt)}</time>
                  {Option.match(chapterSpan(chapter), {
                    onNone: () => null,
                    onSome: (span) => <span>{span}</span>,
                  })}
                </span>
              ),
            })}
          </button>
          {expanded && (
            <ChapterTree
              chapter={chapter}
              selectedSession={composerSession ?? selection.sessionKey}
              onSession={(sessionKey) =>
                onSelect({ _tag: "Attempt", attemptId: chapter.attemptId, sessionKey })
              }
              onCheckpoint={(checkpoint) => onCheckpoint(checkpoint, chapter)}
            />
          )}
        </div>
      );
    })}
    {errors !== null && <div className="mt-3 border-t px-2 pt-3">{errors}</div>}
  </nav>
);
