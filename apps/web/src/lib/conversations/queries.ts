import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type {
  ConversationId,
  EventSequence,
  MessageSequence,
  TurnEvent,
} from "@usine/core/conversation";
import { type ConversationsView, EVENTS_PAGE } from "@usine/orchestrator/operator/http";
import { conversationApi } from "~/lib/api";
import { changes } from "~/lib/query-changes";

/** Whether the supervisor takes messages on this instance, and why not. */
export const conversationStatusQuery = () =>
  queryOptions({
    queryKey: ["conversation-status"],
    queryFn: () => conversationApi((client) => client.conversationStatus()),
    staleTime: 60_000,
    meta: { refreshLabel: "Supervisor status", changes: changes.kind("configuration") },
  });

export type ConversationList = typeof ConversationsView.Type;
export type ConversationRow = ConversationList["conversations"][number];

/**
 * The conversations that the member can read, latest activity first, each with its latest turn,
 * a preview of its latest message, and whether the member has read it.
 */
export const conversationsQuery = () =>
  queryOptions({
    queryKey: ["conversations"],
    queryFn: () => conversationApi((client) => client.conversations({ query: {} })),
    staleTime: 30_000,
    meta: { refreshLabel: "Conversations", changes: changes.kind("conversation") },
  });

/** Returns how many conversations of `list` have unread activity. */
export const unreadCount = (list: ConversationList): number =>
  list.conversations.filter(({ unread }) => unread === true).length;

/** Returns `list` with `id` read through `through`, which clears it once that is its last message. */
export const withRead = (
  list: ConversationList,
  id: ConversationId,
  through: MessageSequence,
): ConversationList => ({
  conversations: list.conversations.map((row) =>
    row.conversation.id === id && row.lastMessage <= through ? { ...row, unread: false } : row,
  ),
});

export const conversationKey = (id: ConversationId) => ["conversation", id] as const;

/** One conversation with its messages and turns. */
export const conversationQuery = (id: ConversationId) =>
  queryOptions({
    queryKey: conversationKey(id),
    queryFn: () =>
      conversationApi((client) => client.conversation({ params: { conversation: id } })),
    staleTime: 30_000,
    meta: { refreshLabel: "Conversation", changes: changes.conversation(id) },
  });

const conversationEventsKey = (id: ConversationId) => ["conversation-events", id] as const;

/**
 * The session events of a conversation's turns. Each read asks only for the events after the last
 * cached one and appends them; a change notice for the conversation starts the next read.
 */
export const conversationEventsQuery = (queryClient: QueryClient, id: ConversationId) => {
  const key = conversationEventsKey(id);
  return queryOptions({
    queryKey: key,
    queryFn: async (): Promise<ReadonlyArray<TurnEvent>> => {
      let events: ReadonlyArray<TurnEvent> = queryClient.getQueryData(key) ?? [];
      let after: EventSequence | 0 = events.at(-1)?.sequence ?? 0;
      while (true) {
        const page = await conversationApi((client) =>
          client.conversationEvents({ params: { conversation: id }, query: { after } }),
        );
        events = [...events, ...page.events];
        if (page.events.length < EVENTS_PAGE) return events;
        after = page.next;
      }
    },
    staleTime: 30_000,
    meta: { refreshLabel: "Conversation events", changes: changes.conversation(id) },
  });
};
