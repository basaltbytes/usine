import { KanbanIcon, LinkSimpleIcon, SquaresFourIcon, UserIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type Conversation as ConversationRecord,
  type ConversationId,
  defaultFormat,
  MessageBody,
  type TurnId,
} from "@usine/core/conversation";
import { DateTime, Schema } from "effect";
import { type RefObject, useMemo, useState } from "react";
import { ErrorAlert } from "~/components/error-alert";
import { PageFact } from "~/components/page";
import { SheetDescription, SheetHeader, SheetTitle } from "~/components/ui/sheet";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "~/components/ui/message-scroller";
import { Composer } from "~/components/conversations/composer";
import { PanelFooter } from "~/components/conversations/footer";
import { TimelineEmpty, TurnBlock } from "~/components/conversations/timeline";
import { useMember, useReadOnlyReason, useScopeName } from "~/hooks/use-conversation-access";
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
import { OperatorHttpError } from "@usine/orchestrator/operator/http";
import { dayTimeLabel, timestampLabel } from "~/lib/strings";

type ConversationHeaderProps = { readonly conversation: ConversationRecord };

const ConversationHeader = ({ conversation }: ConversationHeaderProps) => {
  const scope = useScopeName(conversation.scope);
  const started = DateTime.formatIso(conversation.createdAt);
  return (
    <>
      <SheetTitle className="wrap-anywhere">{conversation.title}</SheetTitle>
      <SheetDescription render={<div />} className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
        <PageFact
          icon={conversation.scope._tag === "Instance" ? SquaresFourIcon : KanbanIcon}
          title="Scope"
        >
          {scope}
        </PageFact>
        <PageFact icon={UserIcon} title="Started by">
          {conversation.createdBy}
          <time dateTime={started} title={timestampLabel(started)} className="font-mono text-xs">
            {dayTimeLabel(started)}
          </time>
        </PageFact>
        {conversation.anchor._tag === "Some" && (
          <PageFact icon={LinkSimpleIcon} title="Anchor">
            <span className="font-mono text-xs wrap-anywhere">
              {conversation.anchor.value.kind}
            </span>
          </PageFact>
        )}
      </SheetDescription>
    </>
  );
};

const notReadyMessage = (cause: unknown) =>
  Schema.is(OperatorHttpError)(cause) && cause.error === "SupervisorNotReady"
    ? { title: notReadyTitle, message: cause.message }
    : { message: rejectionMessage(cause) };

type ConversationBodyProps = {
  readonly id: ConversationId;
  readonly record: Conversation;
  readonly composerRef: RefObject<HTMLTextAreaElement | null>;
};

const ConversationBody = ({ id, record, composerRef }: ConversationBodyProps) => {
  const queryClient = useQueryClient();
  const member = useMember();
  const readOnly = useReadOnlyReason(record.conversation.scope);
  const events = useQuery(conversationEventsQuery(queryClient, id));
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
  return (
    <>
      <MessageScrollerProvider autoScroll defaultScrollPosition="end" scrollEdgeThreshold={8}>
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport aria-label="Messages">
            <MessageScrollerContent className="gap-6 px-5 pt-5 pb-8">
              {timeline.length === 0 ? (
                <TimelineEmpty>{emptyConversation}</TimelineEmpty>
              ) : (
                timeline.map((entry) => (
                  <TurnBlock
                    key={entry.turn.id}
                    entry={entry}
                    pending={isPending(entry.turn)}
                    canceling={cancel.isPending && cancel.variables === entry.turn.id}
                    cancel={
                      readOnly === undefined &&
                      !isPending(entry.turn) &&
                      (entry.turn.state._tag === "Queued" || entry.turn.state._tag === "Running")
                        ? () => cancel.mutate(entry.turn.id)
                        : undefined
                    }
                  />
                ))
              )}
              {events.isError && <ErrorAlert message={rejectionMessage(events.error)} />}
              {cancel.isError && <ErrorAlert message={rejectionMessage(cancel.error)} />}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
      <PanelFooter readOnly={readOnly}>
        <div className="space-y-3">
          {failure !== undefined && <ErrorAlert {...failure} />}
          <Composer
            inputRef={composerRef}
            value={draft}
            change={setDraft}
            sending={post.isPending}
            send={() => post.mutate(draft)}
          />
        </div>
      </PanelFooter>
    </>
  );
};

type ConversationViewProps = {
  readonly id: ConversationId;
  readonly composerRef: RefObject<HTMLTextAreaElement | null>;
};

/** Renders one conversation in the panel: its header, its turns, and the composer. */
export const ConversationView = ({ id, composerRef }: ConversationViewProps) => {
  const record = useQuery(conversationQuery(id));
  if (record.data === undefined)
    return (
      <SheetHeader className="shrink-0 gap-1.5 border-b px-5 pt-5 pb-4 pr-20">
        <SheetTitle>{record.isError ? conversationMissing : loadingConversation}</SheetTitle>
        <SheetDescription>
          {record.isError
            ? Schema.is(OperatorHttpError)(record.error) &&
              record.error.error === "ConversationNotFound"
              ? conversationMissingDetail
              : rejectionMessage(record.error)
            : loadingConversation}
        </SheetDescription>
      </SheetHeader>
    );
  return (
    <>
      <SheetHeader className="shrink-0 gap-1.5 border-b px-5 pt-5 pb-4 pr-20">
        <ConversationHeader conversation={record.data.conversation} />
      </SheetHeader>
      <ConversationBody id={id} record={record.data} composerRef={composerRef} />
    </>
  );
};
