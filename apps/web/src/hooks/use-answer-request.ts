import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ConversationId } from "@usine/core/conversation";
import type { Answer, PermissionRequestId } from "@usine/core/permission-request";
import { DateTime } from "effect";
import { useMember } from "~/hooks/use-conversation-access";
import { conversationApi } from "~/lib/api";
import { allowedCallsQuery, conversationKey, grantsQuery } from "~/lib/conversations/queries";
import { withAnswer } from "~/lib/conversations/requests";
import type { Conversation } from "~/lib/conversations/timeline";

type AnswerVariables = {
  readonly request: PermissionRequestId;
  readonly answer: Answer;
};

/**
 * Answers a permission request of `conversation`. The conversation shows the answer at once; a
 * refused answer, such as a request that another member answered first, restores it.
 */
export const useAnswerRequest = (conversation: ConversationId) => {
  const queryClient = useQueryClient();
  const member = useMember();
  const key = conversationKey(conversation);
  return useMutation({
    mutationFn: ({ request, answer }: AnswerVariables) =>
      conversationApi((client) =>
        client.answerRequest({ params: { conversation, request }, payload: { answer } }),
      ),
    onMutate: async ({ request, answer }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<Conversation>(key);
      if (previous !== undefined && member !== undefined)
        queryClient.setQueryData(
          key,
          withAnswer(previous, request, answer, member, DateTime.nowUnsafe()),
        );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData(key, context.previous);
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: key }),
        queryClient.invalidateQueries({ queryKey: grantsQuery().queryKey }),
        queryClient.invalidateQueries({ queryKey: allowedCallsQuery().queryKey }),
      ]),
  });
};
