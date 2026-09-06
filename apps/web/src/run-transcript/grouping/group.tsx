import { CaretRightIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { MessageScrollerItem, useMessageScroller } from "@/components/ui/message-scroller";
import { TranscriptToolRow } from "../tool/tool.tsx";
import { isGroupOpen, useTranscriptDisclosure } from "./disclosure.tsx";
import { groupSummary, type ToolGroup } from "./model.ts";

/** A quiet expandable summary of successful calls, with every original tool available inside. */
export const CompletedTools = ({ group }: { readonly group: ToolGroup }) => {
  const { state, change } = useTranscriptDisclosure();
  const { scrollToMessage } = useMessageScroller();
  const keys = group.tools.map((tool) => tool.key);
  return (
    <Collapsible
      data-transcript-id={group.key}
      open={isGroupOpen(state, keys)}
      onOpenChange={(open) => {
        if (open) scrollToMessage(group.key, { align: "nearest", behavior: "instant" });
        change({ _tag: "Group", keys, open });
      }}
      className="min-w-0"
    >
      <CollapsibleTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="-mx-2 h-auto w-[calc(100%+1rem)] justify-start gap-2 border-0 whitespace-normal px-2 py-1 text-left text-muted-foreground data-[panel-open]:[&_svg:first-child]:rotate-90"
          />
        }
      >
        <CaretRightIcon aria-hidden="true" className="shrink-0 transition-transform" />
        <span>{groupSummary(group)}</span>
        <span className="sr-only"> · Completed tools</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 pl-3 pt-2">
        {group.tools.map((tool) => (
          <MessageScrollerItem key={tool.key} messageId={tool.key}>
            <TranscriptToolRow entry={tool} />
          </MessageScrollerItem>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
};
