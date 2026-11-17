import { useNavigate } from "@tanstack/react-router";
import type { ConversationId } from "@usine/core/conversation";

/**
 * Returns a function that opens the supervisor inbox over the current route by setting the
 * `conversation` search param: a conversation, `new` for the form that starts one, or `inbox` for
 * the list with nothing open.
 */
export const useOpenConversation = () => {
  const navigate = useNavigate();
  return (conversation: ConversationId | "new" | "inbox") =>
    void navigate({ to: ".", search: (previous) => ({ ...previous, conversation }) });
};
