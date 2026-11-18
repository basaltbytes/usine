import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AccessScope } from "@usine/core/access";
import { type ConversationId, defaultFormat, MessageBody } from "@usine/core/conversation";
import type { ProjectId } from "@usine/core/project";
import { OperatorHttpError } from "@usine/orchestrator/operator/http";
import { Schema } from "effect";
import { type RefObject, useId, useState } from "react";
import { ErrorAlert } from "~/components/error-alert";
import { Bubble, BubbleContent } from "~/components/ui/bubble";
import { Label } from "~/components/ui/label";
import { Message, MessageContent, MessageFooter, MessageHeader } from "~/components/ui/message";
import { NativeSelect } from "~/components/ui/native-select";
import { PanelFooter } from "~/components/conversations/footer";
import { PaneHeader } from "~/components/conversations/pane-header";
import { PromptInput } from "~/components/conversations/prompt-input";
import { INSTANCE_CHOICE, useMember, useScopeChoices } from "~/hooks/use-conversation-access";
import { conversationApi, rejectionMessage } from "~/lib/api";
import { conversationsQuery } from "~/lib/conversations/queries";
import {
  newConversationLabel,
  noScopeToPost,
  notReadyTitle,
  readOnlyNotice,
  scopeLabel,
  signInToPost,
  unsentLabel,
} from "~/lib/conversations/strings";

type NewConversationProps = {
  /** The project of the page the inbox opened on, chosen first when the member can post there. */
  readonly project: ProjectId | undefined;
  readonly opened: (id: ConversationId) => void;
  readonly back: () => void;
  readonly composerRef: RefObject<HTMLTextAreaElement | null>;
};

/** Starts a conversation: picks its scope, then sends the first message. */
export const NewConversation = ({ project, opened, back, composerRef }: NewConversationProps) => {
  const queryClient = useQueryClient();
  const member = useMember();
  const choices = useScopeChoices();
  const select = useId();
  const [chosen, setChosen] = useState<string>();
  const [draft, setDraft] = useState("");
  const value =
    chosen ??
    choices.find((choice) => choice.value === project)?.value ??
    choices.find((choice) => choice.value !== INSTANCE_CHOICE)?.value ??
    choices[0]?.value;
  const scope = choices.find((choice) => choice.value === value)?.scope;
  const start = useMutation({
    mutationFn: ({ text, scope }: { readonly text: string; readonly scope: AccessScope }) =>
      conversationApi((client) =>
        client.startConversation({
          payload: {
            scope,
            message: {
              body: MessageBody.make(text),
              format: defaultFormat,
              reply: { format: defaultFormat },
            },
          },
        }),
      ),
    onMutate: () => setDraft(""),
    onError: (_error, { text }) => setDraft((current) => (current === "" ? text : current)),
    onSuccess: async (record) => {
      await queryClient.invalidateQueries({ queryKey: conversationsQuery().queryKey });
      opened(record.conversation.id);
    },
  });
  const failure = start.isError
    ? Schema.is(OperatorHttpError)(start.error) && start.error.error === "SupervisorNotReady"
      ? { title: notReadyTitle, message: start.error.message }
      : { message: rejectionMessage(start.error) }
    : undefined;
  return (
    <>
      <PaneHeader back={back} title={newConversationLabel}>
        <p className="text-sm text-muted-foreground">{readOnlyNotice}</p>
      </PaneHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-6 px-5 py-5">
          {choices.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={select}>{scopeLabel}</Label>
              <NativeSelect
                variant="form"
                id={select}
                value={value}
                disabled={start.isPending}
                className="w-full max-w-xs [&_select]:h-8 max-sm:[&_select]:h-11 pointer-coarse:[&_select]:h-11"
                onChange={(event) => setChosen(event.target.value)}
              >
                {choices.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}
          {start.isPending && start.variables !== undefined && member !== undefined && (
            <Message align="end" role="group" aria-label={`Message from ${member.login}`}>
              <MessageContent spacing="compact">
                <MessageHeader variant="speaker">{member.login}</MessageHeader>
                <Bubble variant="muted" align="end" className="max-w-[85%]">
                  <BubbleContent variant="message" pending>
                    <p className="text-md whitespace-pre-wrap wrap-anywhere">
                      {start.variables.text}
                    </p>
                  </BubbleContent>
                </Bubble>
                <MessageFooter variant="plain">{unsentLabel}</MessageFooter>
              </MessageContent>
            </Message>
          )}
        </div>
      </div>
      <PanelFooter
        readOnly={
          member === undefined ? signInToPost : scope === undefined ? noScopeToPost : undefined
        }
      >
        <div className="space-y-3">
          {failure !== undefined && <ErrorAlert {...failure} />}
          {scope !== undefined && (
            <PromptInput
              inputRef={composerRef}
              value={draft}
              change={setDraft}
              sending={start.isPending}
              send={() => start.mutate({ text: draft, scope })}
            />
          )}
        </div>
      </PanelFooter>
    </>
  );
};
