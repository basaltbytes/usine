import { createFileRoute } from "@tanstack/react-router";
import { ConversationsPage } from "~/features/conversations/conversations.page";
import { conversationsQuery, conversationStatusQuery } from "~/lib/conversations/queries";

export const Route = createFileRoute("/conversations")({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(conversationsQuery()),
      context.queryClient.ensureQueryData(conversationStatusQuery()),
    ]),
  component: ConversationsPage,
});
