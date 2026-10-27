import { ArrowDownIcon, ArrowUpIcon } from "@phosphor-icons/react";
import { useEffect } from "react";
import { Button } from "~/components/ui/button";
import { useMessageScroller } from "~/components/ui/message-scroller";
import { cn } from "~/lib/utils";
import { useTranscriptDisclosure } from "~/components/runs/transcript/grouping/disclosure";
import type { NavigableRow } from "~/lib/runs/transcript/navigation/model";

/** A reader location: a row, an Attempt heading, or a tool call in a folded burst. */
export interface ReaderTarget {
  /** The MessageScroller ID to scroll to the top of the viewport. */
  readonly messageId: string;
  /** The tool call to open along with its burst, or `null`. */
  readonly tool: string | null;
}

/** Returns the reader target of a row; for a tool error, the target opens the call. */
export const updateTarget = (update: NavigableRow): ReaderTarget => ({
  messageId: update.key,
  tool: update.isTool ? update.key : null,
});

const wording = {
  errors: {
    count: (total: number, earlier: boolean) =>
      `${total} ${earlier ? "loaded " : ""}${total === 1 ? "error" : "errors"}`,
    name: "error",
    group: "Conversation errors",
    title: undefined,
  },
  recovered: {
    count: (total: number, earlier: boolean) => `${total}${earlier ? "+" : ""} recovered`,
    name: "recovered tool failure",
    group: "Recovered tool failures",
    title: "Failed tool calls followed by more activity in the attempt",
  },
} as const;

/** Renders controls that step through the loaded errors and recovered tool failures in conversation order (see `errorTally`). */
export const ErrorControls = ({
  errors,
  kind = "errors",
  selectedKey,
  earlier,
  onSelect,
}: {
  readonly errors: ReadonlyArray<NavigableRow>;
  readonly kind?: keyof typeof wording;
  readonly selectedKey: string | null;
  readonly earlier: boolean;
  readonly onSelect: (target: NavigableRow) => void;
}) => {
  const first = errors[0];
  const last = errors.at(-1);
  if (first === undefined || last === undefined) return null;
  const words = wording[kind];
  const index = errors.findIndex((error) => error.key === selectedKey);
  const previous = errors[index - 1] ?? last;
  const next = errors[index + 1] ?? first;
  const count = words.count(errors.length, earlier);
  return (
    <div role="group" aria-label={words.group} className="flex items-center gap-1">
      <span
        role="status"
        title={words.title}
        className={cn(
          "mr-auto text-xs tabular-nums",
          kind === "errors" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {index < 0 ? count : `${index + 1} of ${count}`}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Previous ${words.name}`}
        title={`Previous ${words.name}`}
        className={kind === "recovered" ? "text-muted-foreground" : undefined}
        onClick={() => onSelect(previous)}
      >
        <ArrowUpIcon aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Next ${words.name}`}
        title={`Next ${words.name}`}
        className={kind === "recovered" ? "text-muted-foreground" : undefined}
        onClick={() => onSelect(next)}
      >
        <ArrowDownIcon aria-hidden="true" />
      </Button>
    </div>
  );
};

/** Scrolls to `target` and opens its disclosures; the caller keeps the request until `onRevealed` is called. */
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
    // A tool can stay open after its burst is collapsed, so the burst and the tool are reopened.
    if (
      target.tool !== null &&
      (state.get(target.tool)?.open !== true || state.get(target.tool)?.groupOpen !== true)
    ) {
      reveal({ _tag: "Item", key: target.tool, open: true });
      return;
    }
    // Base UI mounts opened panels before this frame, and MessageScroller items register through
    // their DOM refs, so rows inside those panels can be scrolled to.
    let settleFrame: number | undefined;
    let completionFrame: number | undefined;
    const frame = requestAnimationFrame(() => {
      if (!scrollToMessage(target.messageId, { align: "start", behavior: "instant" })) return;
      // Rows scrolled into view replace their estimated heights, so the next frame scrolls again.
      settleFrame = requestAnimationFrame(() => {
        scrollToMessage(target.messageId, { align: "start", behavior: "instant" });
        // The registry updates scrollability on the next frame; the request stays pending until
        // then so its previous "at latest" state does not mark updates as read.
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
