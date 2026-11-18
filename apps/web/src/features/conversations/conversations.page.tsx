import { useRef } from "react";
import { Inbox, type InboxTarget } from "~/components/conversations/inbox";
import { useOpenConversation } from "~/hooks/use-open-conversation";

type ConversationsPageProps = {
  readonly target: InboxTarget;
};

/** The supervisor inbox as a full page: the list, and the conversation the search param opens. */
export const ConversationsPage = ({ target }: ConversationsPageProps) => {
  const composer = useRef<HTMLTextAreaElement>(null);
  const openConversation = useOpenConversation();
  return (
    <Inbox
      target={target}
      select={openConversation}
      project={undefined}
      composerRef={composer}
      escapeToList
      className="flex-1"
    />
  );
};
