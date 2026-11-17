import { useNavigate } from "@tanstack/react-router";
import type { ConversationId } from "@usine/core/conversation";

/**
 * Returns a function that opens the conversation panel over the current route by setting the
 * `conversation` search param to a conversation, or to `new` for the form that starts one.
 */
export const useOpenConversation = () => {
  const navigate = useNavigate();
  return (conversation: ConversationId | "new") =>
    void navigate({ to: ".", search: (previous) => ({ ...previous, conversation }) });
};
