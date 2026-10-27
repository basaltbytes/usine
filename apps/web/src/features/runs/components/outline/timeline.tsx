import { CaretRightIcon } from "@phosphor-icons/react";
import { useLayoutEffect, useRef, useState } from "react";
import { Collapsible, CollapsibleContent } from "~/components/ui/collapsible";
import { CheckpointButton } from "~/features/runs/components/outline/checkpoint-button";
import { checkpointRow } from "~/features/runs/lib/outline";
import {
  outlineEntries,
  type Chapter,
  type Checkpoint,
  type TurnsEntry,
} from "~/lib/runs/transcript/document/model";
import { cn } from "~/lib/utils";

type TimelineProps = {
  readonly chapter: Chapter;
  /** The checkpoint at the reader's reading line. */
  readonly current: string | null;
  readonly onCheckpoint: (checkpoint: Checkpoint) => void;
};

/**
 * Renders an Attempt's checkpoints in conversation order, with consecutive turns of one session in
 * one fold. The reading mark is on the checkpoint being read, or on its fold while the fold is closed.
 */
export const Timeline = ({ chapter, current, onCheckpoint }: TimelineProps) => {
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
    // Opening a fold moves the rows below it while it expands.
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
