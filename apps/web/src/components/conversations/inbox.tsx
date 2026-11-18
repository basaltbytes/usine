import { ChatsCircleIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import type { ConversationId } from "@usine/core/conversation";
import type { ProjectId } from "@usine/core/project";
import { type RefObject, useEffect, useRef } from "react";
import { InboxList } from "~/components/conversations/inbox-list";
import { NewConversation } from "~/components/conversations/new-conversation";
import { Thread } from "~/components/conversations/thread";
import { useMember, useScopeChoices } from "~/hooks/use-conversation-access";
import { conversationStatusQuery } from "~/lib/conversations/queries";
import { noConversationOpen, noConversationOpenDetail } from "~/lib/conversations/strings";
import { cn } from "~/lib/utils";

/** What the inbox shows beside its list: a conversation, the form that starts one, or nothing. */
export type InboxTarget = ConversationId | "new" | "inbox";

const NoneOpen = () => (
  <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
    <ChatsCircleIcon aria-hidden="true" className="mb-2 size-6 text-faint" />
    <p className="text-md font-medium">{noConversationOpen}</p>
    <p className="text-sm text-muted-foreground">{noConversationOpenDetail}</p>
  </div>
);

type InboxProps = {
  readonly target: InboxTarget;
  readonly select: (target: InboxTarget) => void;
  /** The project of the current page, chosen first for a new conversation. */
  readonly project: ProjectId | undefined;
  readonly composerRef: RefObject<HTMLTextAreaElement | null>;
  /** Handles Escape on the open pane; the panel leaves it to its sheet. */
  readonly escapeToList?: boolean;
  readonly className?: string;
};

/**
 * The supervisor inbox: the conversation list and the open pane. From 768px of its own width it
 * shows both side by side; narrower, it shows the list, or the open pane with a back control.
 */
export const Inbox = ({
  target,
  select,
  project,
  composerRef,
  escapeToList = false,
  className,
}: InboxProps) => {
  const status = useQuery(conversationStatusQuery());
  const member = useMember();
  const choices = useScopeChoices();
  const start =
    status.data?.state === "ready" && member !== undefined && choices.length > 0
      ? () => select("new")
      : undefined;
  const opened = target !== "inbox";
  const root = useRef<HTMLDivElement>(null);
  const previous = useRef(target);
  // Returning to the list focuses the row of the conversation that was open. Opening one while
  // the list is hidden moves focus to the pane, which would otherwise be left on a hidden row.
  useEffect(() => {
    const was = previous.current;
    previous.current = target;
    if (target === was) return;
    if (target !== "inbox") {
      const back = root.current?.querySelector<HTMLElement>("[data-pane-back]");
      if (back?.checkVisibility() === true) back.focus();
      return;
    }
    const rows = root.current?.querySelectorAll<HTMLElement>("[data-inbox-row]") ?? [];
    const row = [...rows].find((candidate) => candidate.dataset.inboxRow === was) ?? rows[0];
    row?.focus();
  }, [target]);
  return (
    <div
      ref={root}
      className={cn("@container/inbox flex h-full min-h-0 w-full", className)}
      onKeyDown={(event) => {
        if (escapeToList && opened && event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          select("inbox");
        }
      }}
    >
      <div
        className={cn(
          "flex min-h-0 w-full flex-col @3xl/inbox:w-80 @3xl/inbox:shrink-0 @3xl/inbox:border-r",
          opened && "@max-3xl/inbox:hidden",
        )}
      >
        <InboxList
          selected={target === "new" || target === "inbox" ? undefined : target}
          open={select}
          start={start}
        />
      </div>
      <div
        className={cn("flex min-h-0 min-w-0 flex-1 flex-col", !opened && "@max-3xl/inbox:hidden")}
      >
        {target === "inbox" ? (
          <NoneOpen />
        ) : target === "new" ? (
          <NewConversation
            project={project}
            opened={select}
            back={() => select("inbox")}
            composerRef={composerRef}
          />
        ) : (
          <Thread key={target} id={target} composerRef={composerRef} back={() => select("inbox")} />
        )}
      </div>
    </div>
  );
};
