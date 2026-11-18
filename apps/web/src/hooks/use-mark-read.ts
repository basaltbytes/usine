import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ConversationId, MessageSequence } from "@usine/core/conversation";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useMember } from "~/hooks/use-conversation-access";
import { conversationApi } from "~/lib/api";
import { type ConversationList, conversationsQuery, withRead } from "~/lib/conversations/queries";
import { type Conversation, isPending } from "~/lib/conversations/timeline";

const subscribeVisibility = (change: () => void) => {
  document.addEventListener("visibilitychange", change);
  return () => document.removeEventListener("visibilitychange", change);
};
const pageVisible = () => document.visibilityState === "visible";

/**
 * Marks the open conversation read through its last message while the page is visible: once on
 * open, then again when a message arrives or a turn fails. The list shows it read at once; marking
 * read sends no change notice, so the response is the only update.
 */
export const useMarkRead = (id: ConversationId, record: Conversation) => {
  const queryClient = useQueryClient();
  const member = useMember();
  const visible = useSyncExternalStore(subscribeVisibility, pageVisible);
  const listKey = conversationsQuery().queryKey;
  const { mutate } = useMutation({
    mutationFn: (through: MessageSequence) =>
      conversationApi((client) =>
        client.markRead({ params: { conversation: id }, payload: { through } }),
      ),
    onMutate: (through) => {
      const previous = queryClient.getQueryData<ConversationList>(listKey);
      if (previous !== undefined)
        queryClient.setQueryData(listKey, withRead(previous, id, through));
      return { previous };
    },
    onError: (_error, _through, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData(listKey, context.previous);
    },
    // A list read that started before the marker was stored still says unread.
    onSuccess: (marker) =>
      queryClient.setQueryData<ConversationList>(listKey, (current) =>
        current === undefined ? current : withRead(current, id, marker.through),
      ),
  });
  const sent = record.messages.filter(
    (message) => !record.turns.some((turn) => turn.id === message.turn && isPending(turn)),
  );
  const last = sent.at(-1)?.sequence;
  const failed = record.turns.filter(({ state }) => state._tag === "Failed").length;
  const marked = useRef<string>(undefined);
  // oxlint-disable-next-line usine/no-unreasoned-effect -- Persist visible conversation read markers to the server.
  useEffect(() => {
    const seen = `${last}:${failed}`;
    if (!visible || member === undefined || last === undefined || marked.current === seen) return;
    marked.current = seen;
    mutate(last);
  }, [visible, member, last, failed, mutate]);
};
