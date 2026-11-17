import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AccessScope } from "@usine/core/access";
import { type ConversationId, defaultFormat, MessageBody } from "@usine/core/conversation";
import type { ProjectId } from "@usine/core/project";
import { OperatorHttpError } from "@usine/orchestrator/operator/http";
import { Schema } from "effect";
import { type RefObject, useId, useState } from "react";
import { ErrorAlert } from "~/components/error-alert";
import { Label } from "~/components/ui/label";
import { NativeSelect } from "~/components/ui/native-select";
import { SheetDescription, SheetHeader, SheetTitle } from "~/components/ui/sheet";
import { Composer } from "~/components/conversations/composer";
import { PanelFooter } from "~/components/conversations/footer";
import { RecentConversations } from "~/components/conversations/recent";
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
  /** The project of the page the panel opened on, chosen first when the member can post there. */
  readonly project: ProjectId | undefined;
  readonly opened: (id: ConversationId) => void;
  readonly composerRef: RefObject<HTMLTextAreaElement | null>;
};

/** Starts a conversation: picks its scope, then sends the first message. */
export const NewConversation = ({ project, opened, composerRef }: NewConversationProps) => {
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
      <SheetHeader className="shrink-0 gap-1.5 border-b px-5 pt-5 pb-4 pr-20">
        <SheetTitle>{newConversationLabel}</SheetTitle>
        <SheetDescription>{readOnlyNotice}</SheetDescription>
      </SheetHeader>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
        {choices.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={select}>{scopeLabel}</Label>
            <NativeSelect
              id={select}
              value={value}
              disabled={start.isPending}
              className="w-full max-w-xs [&_select]:h-8 [&_select]:text-sm max-sm:[&_select]:h-11 max-sm:[&_select]:text-lg pointer-coarse:[&_select]:h-11 pointer-coarse:[&_select]:text-lg"
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
          <section aria-label={`Message from ${member.login}`} className="space-y-1">
            <p className="text-xs font-medium">{member.login}</p>
            <p className="text-md whitespace-pre-wrap opacity-60 wrap-anywhere">
              {start.variables.text}
            </p>
            <p className="text-xs text-muted-foreground">{unsentLabel}</p>
          </section>
        )}
        {!start.isPending && <RecentConversations open={opened} />}
      </div>
      <PanelFooter
        readOnly={
          member === undefined ? signInToPost : scope === undefined ? noScopeToPost : undefined
        }
      >
        <div className="space-y-3">
          {failure !== undefined && <ErrorAlert {...failure} />}
          {scope !== undefined && (
            <Composer
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
