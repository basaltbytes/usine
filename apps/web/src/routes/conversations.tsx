import { createFileRoute, useSearch } from "@tanstack/react-router";
import { ConversationsPage } from "~/features/conversations/conversations.page";
import { conversationsQuery, conversationStatusQuery } from "~/lib/conversations/queries";

const Conversations = () => {
  const { conversation } = useSearch({ from: "__root__" });
  return <ConversationsPage target={conversation ?? "inbox"} />;
};

export const Route = createFileRoute("/conversations")({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(conversationsQuery()),
      context.queryClient.ensureQueryData(conversationStatusQuery()),
    ]),
  component: Conversations,
});
