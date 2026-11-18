import { Option } from "effect";
import { MessageScrollerItem, useMessageScroller } from "~/components/ui/message-scroller";
import type { Burst } from "~/lib/runs/transcript/document/model";
import type { TranscriptTool } from "~/lib/runs/transcript/model";
import { TranscriptToolRow } from "~/components/runs/transcript/tool/tool";
import {
  isGroupOpen,
  useTranscriptDisclosure,
} from "~/components/runs/transcript/grouping/disclosure";
import { ToolGroup } from "~/components/runs/transcript/grouping/tool-group";

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
  return (
    <ToolGroup
      data-transcript-id={burst.key}
      tools={burst.tools}
      span={burstSpan(burst.tools)}
      open={isGroupOpen(state, keys)}
      onOpenChange={(open) => {
        if (open) scrollToMessage(burst.key, { align: "nearest", behavior: "instant" });
        change({ _tag: "Group", keys, open });
      }}
    >
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
    </ToolGroup>
  );
};
