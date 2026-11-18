import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import type { ProjectId } from "@usine/core/project";
import { useRef } from "react";
import { ButtonLink } from "~/components/button-link";
import { Sheet, SheetContent, SheetTitle } from "~/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { Inbox, type InboxTarget } from "~/components/conversations/inbox";
import { useOpenConversation } from "~/hooks/use-open-conversation";
import { allConversationsLabel, conversationPanelLabel } from "~/lib/conversations/strings";

type ConversationPanelProps = {
  readonly target: InboxTarget;
  /** If `false`, the panel stays mounted until the sheet's exit transition ends. */
  readonly open: boolean;
  readonly close: () => void;
  /** The project of the current page, chosen first for a new conversation. */
  readonly project: ProjectId | undefined;
};

/**
 * The supervisor inbox in a right sheet over any page, opened by the `conversation` search param.
 * Escape goes back from a conversation to the list, then closes the sheet.
 */
export const ConversationPanel = ({ target, open, close, project }: ConversationPanelProps) => {
  const composer = useRef<HTMLTextAreaElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const openConversation = useOpenConversation();
  return (
    <Sheet
      open={open}
      onOpenChange={(next, details) => {
        if (next) return;
        if (details.reason === "escape-key" && target !== "inbox") openConversation("inbox");
        else close();
      }}
    >
      <SheetContent
        side="right"
        ref={popup}
        // Focus goes to the prompt input, else to the open row, else to the first row.
        initialFocus={() =>
          composer.current ??
          popup.current?.querySelector<HTMLElement>(
            '[data-inbox-row][aria-current="true"], [data-inbox-row]',
          ) ??
          popup.current
        }
        // Room for the sheet's close and page buttons in the headers under them.
        className="gap-0 outline-none [--inbox-controls:5rem] data-[side=right]:w-full data-[side=right]:sm:max-w-xl data-[side=right]:lg:max-w-4xl"
      >
        <SheetTitle className="sr-only">{conversationPanelLabel}</SheetTitle>
        <Inbox target={target} select={openConversation} project={project} composerRef={composer} />
        <Tooltip>
          <TooltipTrigger
            render={
              <ButtonLink
                to="/conversations"
                search={target === "inbox" ? {} : { conversation: target }}
                aria-label={allConversationsLabel}
                variant="ghost"
                size="icon-sm"
                className="absolute top-4 right-11 max-md:hidden"
              />
            }
          >
            <ArrowSquareOutIcon aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent side="bottom">{allConversationsLabel}</TooltipContent>
        </Tooltip>
      </SheetContent>
    </Sheet>
  );
};
