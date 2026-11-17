import { ListBulletsIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type { ConversationId } from "@usine/core/conversation";
import type { ProjectId } from "@usine/core/project";
import { useRef } from "react";
import { buttonVariants } from "~/components/ui/button";
import { Sheet, SheetContent } from "~/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { ConversationView } from "~/components/conversations/conversation-view";
import { NewConversation } from "~/components/conversations/new-conversation";
import { useOpenConversation } from "~/hooks/use-open-conversation";
import { allConversationsLabel, conversationPanelLabel } from "~/lib/conversations/strings";
import { cn } from "~/lib/utils";

/** What the panel shows: a conversation, or the form that starts one. */
export type ConversationTarget = ConversationId | "new";

type ConversationPanelProps = {
  readonly target: ConversationTarget;
  /** If `false`, the panel stays mounted until the sheet's exit transition ends. */
  readonly open: boolean;
  readonly close: () => void;
  /** The project of the current page, chosen first for a new conversation. */
  readonly project: ProjectId | undefined;
};

/** The conversation panel: a right sheet over any page, opened by the `conversation` search param. */
export const ConversationPanel = ({ target, open, close, project }: ConversationPanelProps) => {
  const composer = useRef<HTMLTextAreaElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const openConversation = useOpenConversation();
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <SheetContent
        side="right"
        ref={popup}
        aria-label={conversationPanelLabel}
        // Without a composer, the panel itself takes focus, not the first message.
        initialFocus={() => composer.current ?? popup.current}
        className="gap-0 outline-none data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
      >
        {target === "new" ? (
          <NewConversation project={project} opened={openConversation} composerRef={composer} />
        ) : (
          <ConversationView key={target} id={target} composerRef={composer} />
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Link
                to="/conversations"
                search={{}}
                aria-label={allConversationsLabel}
                className={cn(
                  buttonVariants({ variant: "ghost", size: "icon-sm" }),
                  "absolute top-4 right-11",
                )}
              />
            }
          >
            <ListBulletsIcon aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent side="bottom">{allConversationsLabel}</TooltipContent>
        </Tooltip>
      </SheetContent>
    </Sheet>
  );
};
