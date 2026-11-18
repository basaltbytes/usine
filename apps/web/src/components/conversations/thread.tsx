import { KanbanIcon, LinkSimpleIcon, SquaresFourIcon, UserIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type Conversation as ConversationRecord,
  type ConversationId,
  defaultFormat,
  MessageBody,
  type TurnId,
} from "@usine/core/conversation";
import { OperatorHttpError } from "@usine/orchestrator/operator/http";
import { DateTime, Schema } from "effect";
import { type RefObject, useMemo, useState } from "react";
import { ErrorAlert } from "~/components/error-alert";
import { PageFact } from "~/components/page";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "~/components/ui/message-scroller";
import { Skeleton } from "~/components/ui/skeleton";
import { PanelFooter } from "~/components/conversations/footer";
import { PaneHeader } from "~/components/conversations/pane-header";
import { PromptInput } from "~/components/conversations/prompt-input";
import { TimelineEmpty, TurnMessages } from "~/components/conversations/timeline";
import { useMember, useReadOnlyReason, useScopeName } from "~/hooks/use-conversation-access";
import { useMarkRead } from "~/hooks/use-mark-read";
import { conversationApi, rejectionMessage } from "~/lib/api";
import {
  conversationEventsQuery,
  conversationKey,
  conversationQuery,
  conversationsQuery,
} from "~/lib/conversations/queries";
import {
  conversationMissing,
  conversationMissingDetail,
  emptyConversation,
  loadingConversation,
  notReadyTitle,
} from "~/lib/conversations/strings";
import {
  type Conversation,
  conversationTimeline,
  isPending,
  withPendingPost,
} from "~/lib/conversations/timeline";
import { dayTimeLabel, timestampLabel } from "~/lib/strings";
import { TextTooltip } from "~/components/text-tooltip";

type ThreadFactsProps = { readonly conversation: ConversationRecord };

const ThreadFacts = ({ conversation }: ThreadFactsProps) => {
  const scope = useScopeName(conversation.scope);
  const started = DateTime.formatIso(conversation.createdAt);
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-muted-foreground">
      <PageFact
        icon={conversation.scope._tag === "Instance" ? SquaresFourIcon : KanbanIcon}
        title="Scope"
      >
        {scope}
      </PageFact>
      <PageFact
        icon={UserIcon}
        title="Started by"
        trailing={
          <TextTooltip text={timestampLabel(started)}>
            <time dateTime={started} className="font-mono text-xs tabular-nums">
              {dayTimeLabel(started)}
            </time>
          </TextTooltip>
        }
      >
        {conversation.createdBy}
      </PageFact>
      {conversation.anchor._tag === "Some" && (
        <PageFact icon={LinkSimpleIcon} title="Anchor">
          <span className="font-mono text-xs wrap-anywhere">{conversation.anchor.value.kind}</span>
        </PageFact>
      )}
    </div>
  );
};

const notReadyMessage = (cause: unknown) =>
  Schema.is(OperatorHttpError)(cause) && cause.error === "SupervisorNotReady"
    ? { title: notReadyTitle, message: cause.message }
    : { message: rejectionMessage(cause) };

type ThreadBodyProps = {
  readonly id: ConversationId;
  readonly record: Conversation;
  readonly composerRef: RefObject<HTMLTextAreaElement | null>;
};

const ThreadBody = ({ id, record, composerRef }: ThreadBodyProps) => {
  const queryClient = useQueryClient();
  const member = useMember();
  const readOnly = useReadOnlyReason(record.conversation.scope);
  const events = useQuery(conversationEventsQuery(queryClient, id));
  useMarkRead(id, record);
  const [draft, setDraft] = useState("");
  const timeline = useMemo(
    () => conversationTimeline(record, events.data ?? []),
    [record, events.data],
  );
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: conversationKey(id) }),
      queryClient.invalidateQueries({ queryKey: conversationsQuery().queryKey }),
    ]);
  const post = useMutation({
    mutationFn: (text: string) =>
      conversationApi((client) =>
        client.postMessage({
          params: { conversation: id },
          payload: {
            body: MessageBody.make(text),
            format: defaultFormat,
            reply: { format: defaultFormat },
          },
        }),
      ),
    onMutate: async (text) => {
      await queryClient.cancelQueries({ queryKey: conversationKey(id) });
      const previous = queryClient.getQueryData<Conversation>(conversationKey(id));
      if (previous !== undefined && member !== undefined)
        queryClient.setQueryData(
          conversationKey(id),
          withPendingPost(previous, text, member, DateTime.nowUnsafe()),
        );
      setDraft("");
      return { previous };
    },
    onError: (_error, text, context) => {
      if (context?.previous !== undefined)
        queryClient.setQueryData(conversationKey(id), context.previous);
      setDraft((current) => (current === "" ? text : current));
    },
    onSettled: refresh,
  });
  const cancel = useMutation({
    mutationFn: (turn: TurnId) =>
      conversationApi((client) => client.cancelTurn({ params: { conversation: id, turn } })),
    onSettled: refresh,
  });
  const failure = post.isError ? notReadyMessage(post.error) : undefined;
  const running = timeline.find(({ turn }) => turn.state._tag === "Running")?.turn;
  const canceling = (turn: TurnId) => cancel.isPending && cancel.variables === turn;
  return (
    <>
      <MessageScrollerProvider autoScroll defaultScrollPosition="end" scrollEdgeThreshold={8}>
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport aria-label="Messages">
            <MessageScrollerContent variant="conversation" className="mx-auto w-full max-w-3xl">
              {timeline.length === 0 ? (
                <TimelineEmpty>{emptyConversation}</TimelineEmpty>
              ) : (
                timeline.map((entry) => (
                  <TurnMessages
                    key={entry.turn.id}
                    entry={entry}
                    pending={isPending(entry.turn)}
                    own={member !== undefined && entry.turn.member.id === member.id}
                    canceling={canceling(entry.turn.id)}
                    cancel={
                      readOnly === undefined &&
                      !isPending(entry.turn) &&
                      entry.turn.state._tag === "Queued"
                        ? () => cancel.mutate(entry.turn.id)
                        : undefined
                    }
                  />
                ))
              )}
              {events.isError && <ErrorAlert message={rejectionMessage(events.error)} />}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
      <PanelFooter readOnly={readOnly}>
        <div className="space-y-3">
          {failure !== undefined && <ErrorAlert {...failure} />}
          {cancel.isError && <ErrorAlert message={rejectionMessage(cancel.error)} />}
          <PromptInput
            inputRef={composerRef}
            value={draft}
            change={setDraft}
            sending={post.isPending}
            send={() => post.mutate(draft)}
            stop={
              readOnly === undefined && running !== undefined
                ? () => cancel.mutate(running.id)
                : undefined
            }
            stopping={running !== undefined && canceling(running.id)}
          />
        </div>
      </PanelFooter>
    </>
  );
};

type ThreadProps = {
  readonly id: ConversationId;
  readonly composerRef: RefObject<HTMLTextAreaElement | null>;
  readonly back: () => void;
};

/** One conversation: its title and facts, its turns, and the prompt input. */
export const Thread = ({ id, composerRef, back }: ThreadProps) => {
  const record = useQuery(conversationQuery(id));
  if (record.data === undefined)
    return (
      <PaneHeader
        back={back}
        title={record.isError ? conversationMissing : loadingConversation}
        aria-busy={!record.isError}
      >
        {record.isError ? (
          <p className="text-sm text-muted-foreground">
            {Schema.is(OperatorHttpError)(record.error) &&
            record.error.error === "ConversationNotFound"
              ? conversationMissingDetail
              : rejectionMessage(record.error)}
          </p>
        ) : (
          // The height of the facts line, so the header keeps its size when they arrive.
          <Skeleton className="h-5 w-56" />
        )}
      </PaneHeader>
    );
  return (
    <>
      <PaneHeader back={back} title={record.data.conversation.title}>
        <ThreadFacts conversation={record.data.conversation} />
      </PaneHeader>
      <ThreadBody id={id} record={record.data} composerRef={composerRef} />
    </>
  );
};
