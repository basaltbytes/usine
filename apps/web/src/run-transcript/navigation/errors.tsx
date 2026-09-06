import { ArrowDownIcon, ArrowUpIcon } from "@phosphor-icons/react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useMessageScroller } from "@/components/ui/message-scroller";
import { useTranscriptDisclosure } from "../grouping/disclosure.tsx";
import type { TranscriptFilter } from "../model.ts";
import type { TranscriptUpdate } from "./model.ts";

/** Cycles loaded errors in conversation order while selection follows the original row identity. */
export const ErrorControls = ({
  errors,
  selectedKey,
  earlier,
  onSelect,
}: {
  readonly errors: ReadonlyArray<TranscriptUpdate>;
  readonly selectedKey: string | null;
  readonly earlier: boolean;
  readonly onSelect: (target: TranscriptUpdate) => void;
}) => {
  const first = errors[0];
  const last = errors.at(-1);
  if (first === undefined || last === undefined) return null;
  const index = errors.findIndex((error) => error.key === selectedKey);
  const previous = errors[index - 1] ?? last;
  const next = errors[index + 1] ?? first;
  const count = `${errors.length} ${earlier ? "loaded " : ""}${errors.length === 1 ? "error" : "errors"}`;
  return (
    <div role="group" aria-label="Conversation errors" className="flex items-center gap-1">
      <span role="status" className="text-xs tabular-nums text-destructive">
        {index < 0 ? count : `${index + 1} of ${count}`}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Previous error"
        title="Previous error"
        onClick={() => onSelect(previous)}
      >
        <ArrowUpIcon aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Next error"
        title="Next error"
        onClick={() => onSelect(next)}
      >
        <ArrowDownIcon aria-hidden="true" />
      </Button>
    </div>
  );
};

/**
 * Reveals one pending error inside the scroller and disclosure providers. The caller
 * keeps the request above the filter key and clears it only after this jump completes.
 */
export const RevealError = ({
  target,
  filter,
  onRevealed,
}: {
  readonly target: TranscriptUpdate | null;
  readonly filter: TranscriptFilter;
  readonly onRevealed: () => void;
}) => {
  const { state, change } = useTranscriptDisclosure();
  const { scrollToMessage } = useMessageScroller();
  useEffect(() => {
    if (target === null || filter !== "all") return;
    const disclosures = [
      ...(target.childKey === null ? [] : [target.childKey]),
      ...(target.isTool ? [target.key] : []),
    ];
    const closed = disclosures.filter((key) => state.get(key)?.open !== true);
    if (closed.length > 0) {
      for (const key of closed) change({ _tag: "Item", key, open: true });
      return;
    }
    // Base UI mounts newly opened panels before this frame. MessageScroller Items
    // register through their DOM refs, including rows inside those child panels.
    let completionFrame: number | undefined;
    const frame = requestAnimationFrame(() => {
      if (scrollToMessage(target.key, { align: "start", behavior: "instant" })) {
        // The registry publishes scrollability on its next frame. Keep the request
        // pending until then so its previous "at latest" state cannot mark updates read.
        completionFrame = requestAnimationFrame(onRevealed);
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      if (completionFrame !== undefined) cancelAnimationFrame(completionFrame);
    };
  }, [target, filter, state, change, scrollToMessage, onRevealed]);
  return null;
};
