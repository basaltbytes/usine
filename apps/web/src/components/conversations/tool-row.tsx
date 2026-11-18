import { Tool, ToolContent, ToolHeader } from "~/components/ai-elements/tool";
import { ToolDetails, toolIcons } from "~/components/runs/transcript/tool/tool";
import type { ToolCall } from "~/lib/runs/transcript/model";
import { presentTool } from "~/lib/runs/transcript/tool/presentation";

type ConversationToolRowProps = { readonly call: ToolCall };

/** Renders one tool call of a turn as the run reader does: collapsed to its name and subject. */
export const ConversationToolRow = ({ call }: ConversationToolRowProps) => {
  const view = presentTool(call);
  const Icon = toolIcons[view.category];
  const status = call.state._tag === "Finished" ? "Completed" : call.state._tag;
  return (
    <Tool data-conversation-tool={call.key}>
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
  );
};
