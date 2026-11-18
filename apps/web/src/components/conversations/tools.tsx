import { Tool, ToolContent, ToolHeader } from "~/components/ai-elements/tool";
import { ToolGroup } from "~/components/runs/transcript/grouping/tool-group";
import { ToolDetails, toolIcons } from "~/components/runs/transcript/tool/tool";
import { MessageScrollerItem, useMessageScroller } from "~/components/ui/message-scroller";
import type { ToolGroupStep } from "~/lib/conversations/timeline";
import { currentCall } from "~/lib/runs/transcript/grouping/summary";
import type { ToolCall } from "~/lib/runs/transcript/model";
import { presentTool } from "~/lib/runs/transcript/tool/presentation";

/** Returns a handler that stops following the end of the thread before a disclosure opens. */
const useHoldPosition = (messageId: string) => {
  const { scrollToMessage } = useMessageScroller();
  return (open: boolean) => {
    if (open) scrollToMessage(messageId, { align: "nearest", behavior: "instant" });
  };
};

type ConversationToolRowProps = { readonly call: ToolCall };

/** Renders one tool call of a turn as the run reader does: collapsed to its name and subject. */
const ConversationToolRow = ({ call }: ConversationToolRowProps) => {
  const hold = useHoldPosition(call.key);
  const view = presentTool(call);
  const Icon = toolIcons[view.category];
  const status = call.state._tag === "Finished" ? "Completed" : call.state._tag;
  return (
    <MessageScrollerItem messageId={call.key} className="-mx-2 px-2 [content-visibility:visible]">
      <Tool data-conversation-tool={call.key} onOpenChange={hold}>
        <ToolHeader
          title={view.title}
          status={status}
          icon={<Icon aria-hidden="true" />}
          description={view.subject}
          aria-label={`${view.title}: ${view.subject} · ${status}`}
        />
        <ToolContent>
          <ToolDetails entry={call} view={view} />
        </ToolContent>
      </Tool>
    </MessageScrollerItem>
  );
};

type ConversationToolGroupProps = { readonly group: ToolGroupStep };

/**
 * Renders the tool calls of a turn between two texts as the run reader's group line, with the
 * running call under it while the turn runs.
 */
export const ConversationToolGroup = ({ group }: ConversationToolGroupProps) => {
  const hold = useHoldPosition(group.key);
  return (
    <MessageScrollerItem messageId={group.key} className="[content-visibility:visible]">
      <ToolGroup tools={group.calls} current={currentCall(group.calls)} onOpenChange={hold}>
        {group.calls.map((call) => (
          <ConversationToolRow key={call.key} call={call} />
        ))}
      </ToolGroup>
    </MessageScrollerItem>
  );
};
