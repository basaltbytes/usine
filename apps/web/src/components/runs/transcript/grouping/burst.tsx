import { CaretRightIcon } from "@phosphor-icons/react";
import { Option } from "effect";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import { MessageScrollerItem, useMessageScroller } from "~/components/ui/message-scroller";
import { durationLabel } from "~/lib/strings";
import type { Burst } from "~/lib/runs/transcript/document/model";
import type { TranscriptTool } from "~/lib/runs/transcript/model";
import { TranscriptToolRow } from "~/components/runs/transcript/tool/tool";
import {
  isGroupOpen,
  useTranscriptDisclosure,
} from "~/components/runs/transcript/grouping/disclosure";
import { burstSummary } from "~/lib/runs/transcript/grouping/summary";

/** Returns the milliseconds from the first call's start to the last recorded result, or `None` if no call has returned or the span is under one second. */
export const burstSpan = (tools: ReadonlyArray<TranscriptTool>): Option.Option<number> => {
  const ends = tools.flatMap(({ state }) =>
    state._tag === "Finished" || state._tag === "Error" ? [Date.parse(state.receivedAt)] : [],
  );
  const first = tools[0];
  if (first === undefined || ends.length === 0) return Option.none();
  const start = Option.match(first.start, {
    onNone: () => Date.parse(first.receivedAt),
    onSome: ({ receivedAt }) => Date.parse(receivedAt),
  });
  const span = Math.max(...ends) - start;
  return Number.isFinite(span) && span >= 1000 ? Option.some(span) : Option.none();
};

type ToolBurstProps = { readonly burst: Burst };

export const ToolBurst = ({ burst }: ToolBurstProps) => {
  const { state, change } = useTranscriptDisclosure();
  const { scrollToMessage } = useMessageScroller();
  const keys = burst.tools.map((tool) => tool.key);
  const failed = burst.tools.filter((tool) => tool.state._tag === "Error").length;
  const running = burst.tools.filter((tool) => tool.state._tag === "Running").length;
  const span = burstSpan(burst.tools);
  return (
    <Collapsible
      data-transcript-id={burst.key}
      open={isGroupOpen(state, keys)}
      onOpenChange={(open) => {
        if (open) scrollToMessage(burst.key, { align: "nearest", behavior: "instant" });
        change({ _tag: "Group", keys, open });
      }}
      className="min-w-0"
    >
      <CollapsibleTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="-mx-2 h-auto min-h-7 w-[calc(100%+1rem)] justify-start gap-2 px-2 py-1 text-left text-xs font-normal whitespace-normal text-muted-foreground hover:text-foreground aria-expanded:bg-transparent aria-expanded:hover:bg-muted/70 data-[panel-open]:[&>svg]:rotate-90"
          />
        }
      >
        <CaretRightIcon aria-hidden="true" className="shrink-0 transition-transform" />
        <span className="min-w-0">
          {burstSummary(burst)}
          {failed > 0 && <span className="text-destructive">, {failed} failed</span>}
          {running > 0 && <span className="text-run-active">, {running} running</span>}
          {Option.match(span, {
            onNone: () => null,
            onSome: (milliseconds) => (
              <>
                {" · "}
                <span className="font-mono tabular-nums">{durationLabel(milliseconds)}</span>
              </>
            ),
          })}
          <span className="sr-only">
            {" "}
            · {burst.tools.length} {burst.tools.length === 1 ? "tool call" : "tool calls"}
          </span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-motion -mx-2 space-y-1 px-2 pt-1 pb-2">
        {/* The burst row already has content-visibility, so its calls render at their real heights. */}
        {burst.tools.map((tool) => (
          <MessageScrollerItem
            key={tool.key}
            messageId={tool.key}
            className="-mx-2 px-2 [content-visibility:visible]"
          >
            <TranscriptToolRow entry={tool} />
          </MessageScrollerItem>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
};
