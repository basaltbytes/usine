import { CaretRightIcon } from "@phosphor-icons/react";
import type { AttemptId } from "@usine/core/attempt";
import type { MachineView, RunView } from "@usine/orchestrator/operator";
import { Option } from "effect";
import { useEffect, useRef, type ReactNode } from "react";
import { ApprovalLine } from "~/components/runs/approval";
import { RunAgainLine } from "~/components/runs/run-again";
import { Elapsed } from "~/components/runs/transcript/activity";
import { StateMark } from "~/components/status-badge";
import { Collapsible, CollapsibleContent } from "~/components/ui/collapsible";
import { ChapterTree } from "~/features/runs/components/outline/chapter-tree";
import { MachineStep } from "~/features/runs/components/outline/machine-step";
import {
  type Chapter,
  type Checkpoint,
  type ReaderDocument,
  type ReadingPlace,
} from "~/lib/runs/transcript/document/model";
import { previewText } from "~/lib/runs/transcript/document/text";
import { dayTimeLabel, durationLabel, timestampLabel } from "~/lib/strings";
import { attemptStartLabel } from "~/lib/runs/strings";
import { cn } from "~/lib/utils";

/** The part of the Run shown in the reader: the Task, the Event, or an Attempt and one of its sessions. */
export type OutlineSelection =
  | { readonly _tag: "Task" }
  | { readonly _tag: "Event" }
  | {
      readonly _tag: "Attempt";
      readonly attemptId: AttemptId;
      /** The session selected in the outline; while it is live, the composer sends to it. */
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

/** Returns the Attempt's span from start to recorded end, or `None` before it starts. */
const chapterSpan = (chapter: Chapter): Option.Option<string> =>
  Option.flatMap(chapter.attempt, ({ startedAt }) =>
    Option.map(chapter.endedAt, (ended) =>
      durationLabel(Date.parse(ended) - Date.parse(startedAt)),
    ),
  );

type OutlineProps = {
  readonly run: RunView;
  readonly eventPreview: string;
  readonly document: ReaderDocument;
  readonly selection: OutlineSelection;
  /** The reader's position; while an Attempt is selected, it determines the expanded Attempt. */
  readonly reading: ReadingPlace | null;
  /** The session the composer sends to, shown as selected. */
  readonly composerSession: string | null;
  readonly onSelect: (selection: OutlineSelection) => void;
  readonly onCheckpoint: (checkpoint: Checkpoint, chapter: Chapter) => void;
  readonly errors: ReactNode;
  /** The machine a provisioned Worker creates or holds for the Run's next or running Attempt. */
  readonly machine?: MachineView | null;
  readonly className?: string;
  readonly id?: string;
};

/**
 * While the reader is shown, expands the Attempt being read to its sessions and checkpoints and marks
 * the checkpoint at the reading line. Ends with `machine` while a queued Run's next Attempt waits for it.
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
  machine = null,
  className,
  id,
}: OutlineProps) => {
  const navRef = useRef<HTMLElement>(null);
  const awaitedMachine =
    run.state === "Queued" &&
    machine !== null &&
    (machine.state === "creating" || (machine.state === "ready" && machine.attemptId === null))
      ? machine
      : null;
  const open = selection._tag === "Attempt" ? (reading?.attemptId ?? selection.attemptId) : null;
  const current = selection._tag === "Attempt" ? (reading?.checkpointKey ?? null) : null;
  useEffect(() => {
    // If the outline is scrollable, keeps the marked checkpoint in view.
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
        <RunAgainLine run={run} source="text" className="mt-0.5 block text-xs" />
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
      {awaitedMachine !== null && (
        <MachineStep machine={awaitedMachine} attemptNumber={run.attempts.length + 1} />
      )}
      {errors !== null && <div className="mt-3 border-t px-2 pt-3">{errors}</div>}
    </nav>
  );
};
