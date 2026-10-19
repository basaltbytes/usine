import { ArrowDownIcon, ArrowUpIcon } from "@phosphor-icons/react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useMessageScroller } from "@/components/ui/message-scroller";
import { useTranscriptDisclosure } from "../grouping/disclosure.tsx";
import type { TranscriptUpdate } from "./model.ts";

/** A place in the reader to show: a row, an Attempt heading, or a tool call inside its folded burst. */
export interface ReaderTarget {
  /** The MessageScroller identity to bring to the top of the viewport. */
  readonly messageId: string;
  /** A tool call to open, together with the burst that folds it. */
  readonly tool: string | null;
}

/** The reader target of an indexed row; a tool error opens its call. */
export const updateTarget = (update: TranscriptUpdate): ReaderTarget => ({
  messageId: update.key,
  tool: update.isTool ? update.key : null,
});

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
      <span role="status" className="mr-auto text-xs tabular-nums text-destructive">
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
 * Reveals one pending target inside the scroller and disclosure providers. The caller
 * keeps the request and clears it only after this jump completes.
 */
export const RevealTarget = ({
  target,
  onRevealed,
}: {
  readonly target: ReaderTarget | null;
  readonly onRevealed: () => void;
}) => {
  const { state, reveal } = useTranscriptDisclosure();
  const { scrollToMessage } = useMessageScroller();
  useEffect(() => {
    if (target === null) return;
    // A tool can remain inspected after its surrounding burst is collapsed.
    // Revealing its durable identity must reopen both disclosure levels.
    if (
      target.tool !== null &&
      (state.get(target.tool)?.open !== true || state.get(target.tool)?.groupOpen !== true)
    ) {
      reveal({ _tag: "Item", key: target.tool, open: true });
      return;
    }
    // Base UI mounts newly opened panels before this frame. MessageScroller Items
    // register through their DOM refs, including rows inside those panels.
    let settleFrame: number | undefined;
    let completionFrame: number | undefined;
    const frame = requestAnimationFrame(() => {
      if (!scrollToMessage(target.messageId, { align: "start", behavior: "instant" })) return;
      // Rows the jump brings into view replace their estimated heights; jump again once measured.
      settleFrame = requestAnimationFrame(() => {
        scrollToMessage(target.messageId, { align: "start", behavior: "instant" });
        // The registry publishes scrollability on its next frame. Keep the request
        // pending until then so its previous "at latest" state cannot mark updates read.
        completionFrame = requestAnimationFrame(onRevealed);
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      if (settleFrame !== undefined) cancelAnimationFrame(settleFrame);
      if (completionFrame !== undefined) cancelAnimationFrame(completionFrame);
    };
  }, [target, state, reveal, scrollToMessage, onRevealed]);
  return null;
};
