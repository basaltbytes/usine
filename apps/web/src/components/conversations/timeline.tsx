import { DateTime } from "effect";
import type { MemberMessage, OutcomesMessage, SupervisorMessage } from "@usine/core/conversation";
import type { ProjectId } from "@usine/core/project";
import type { ReactNode } from "react";
import { Markdown } from "~/components/markdown";
import { ReferenceScopeContext } from "~/components/references/scope";
import { StatusBadge } from "~/components/status-badge";
import { TwoStepButton } from "~/components/two-step-button";
import { Bubble, BubbleContent } from "~/components/ui/bubble";
import { Message, MessageContent, MessageFooter, MessageHeader } from "~/components/ui/message";
import { MessageScrollerItem } from "~/components/ui/message-scroller";
import { PermissionRequestBlock } from "~/components/conversations/permission-request";
import { ConversationToolGroup } from "~/components/conversations/tools";
import {
  canceledLabel,
  cancelingTurnLabel,
  cancelTurnLabel,
  confirmCancelLabel,
  failedLabel,
  failureReason,
  keepQueuedLabel,
  outcomesLabel,
  outcomesSpeaker,
  queuedBehindLabel,
  queuedLabel,
  runningLabel,
  supervisorSpeaker,
  unsentLabel,
} from "~/lib/conversations/strings";
import { bodyText, markdownBody, type TurnEntry } from "~/lib/conversations/timeline";
import { dayTimeLabel, timestampLabel } from "~/lib/strings";
import { cn } from "~/lib/utils";
import { TextTooltip } from "~/components/text-tooltip";

type SpeakerProps = {
  readonly speaker: string;
  readonly at: DateTime.Utc | undefined;
  readonly inset?: boolean;
};

const Speaker = ({ speaker, at, inset }: SpeakerProps) => {
  const instant = at === undefined ? undefined : DateTime.formatIso(at);
  return (
    <MessageHeader variant="metadata" inset={inset}>
      <span className="font-medium text-foreground">{speaker}</span>
      {instant !== undefined && (
        <TextTooltip text={timestampLabel(instant)}>
          <time dateTime={instant} className="font-mono font-normal tabular-nums">
            {dayTimeLabel(instant)}
          </time>
        </TextTooltip>
      )}
    </MessageHeader>
  );
};

type MessageTextProps = {
  readonly message: MemberMessage | SupervisorMessage | OutcomesMessage;
  readonly className?: string;
};

const MessageText = ({ message, className }: MessageTextProps) => {
  const markdown = markdownBody(message);
  return markdown === undefined ? (
    <p className={cn("text-md whitespace-pre-wrap wrap-anywhere", className)}>
      {bodyText(message.body)}
    </p>
  ) : (
    <Markdown className={cn("text-md wrap-anywhere", className)}>{markdown}</Markdown>
  );
};

type TurnStateProps = {
  readonly entry: TurnEntry;
  readonly cancel: (() => void) | undefined;
  readonly canceling: boolean;
};

const TurnState = ({ entry, cancel, canceling }: TurnStateProps) => {
  const { state } = entry.turn;
  switch (state._tag) {
    case "Queued":
      return (
        <MessageFooter variant="metadata" className="flex-wrap">
          <StatusBadge state="Queued" label={entry.behind ? queuedBehindLabel : queuedLabel} />
          {cancel !== undefined && (
            <TwoStepButton
              label={cancelTurnLabel}
              keepLabel={keepQueuedLabel}
              confirmLabel={confirmCancelLabel}
              pendingLabel={cancelingTurnLabel}
              pending={canceling}
              confirm={cancel}
            />
          )}
        </MessageFooter>
      );
    case "Running":
      return (
        <MessageFooter variant="flush">
          <StatusBadge state="Running" label={runningLabel} />
        </MessageFooter>
      );
    case "Failed":
      return (
        <div className="rounded-lg border border-destructive/25 bg-destructive/8 px-3 pt-2 pb-2.5 text-sm">
          <p className="font-medium text-destructive">{failedLabel}</p>
          <p className="wrap-anywhere">{failureReason(state.failure)}</p>
        </div>
      );
    case "Canceled":
      return (
        <MessageFooter variant="flush">
          <StatusBadge state="Canceled" label={canceledLabel(state.by)} />
        </MessageFooter>
      );
    case "Succeeded":
      return null;
  }
};

type TurnMessagesProps = {
  readonly entry: TurnEntry;
  /** The conversation's project, or `undefined` on the instance; its board resolves references. */
  readonly project: ProjectId | undefined;
  /** Whether the turn's member message is still being sent. */
  readonly pending: boolean;
  /** Whether the signed-in member posted the turn's message, which aligns it to the end. */
  readonly own: boolean;
  /** Cancels the turn while it is queued, or `undefined` when the member may not cancel it. */
  readonly cancel: (() => void) | undefined;
  readonly canceling: boolean;
};

/**
 * Renders one turn as two messages: the member's message, then the supervisor's texts, groups of
 * tool calls, state, and answer. The member's message is the scroll anchor while the answer
 * streams in. References in the turn's Markdown resolve in `project`, and source lines link to the
 * commits that the answer records.
 */
export const TurnMessages = ({
  entry,
  project,
  pending,
  own,
  cancel,
  canceling,
}: TurnMessagesProps) => {
  const { message, outcomes, activity, reply } = entry;
  const align = own ? "end" : "start";
  return (
    <ReferenceScopeContext
      value={{ project, repository: undefined, sources: reply?.sources ?? [] }}
    >
      {outcomes !== undefined && (
        <MessageScrollerItem messageId={`${entry.turn.id}:outcomes`} scrollAnchor>
          <Message aria-label={outcomesLabel} role="group">
            <MessageContent spacing="compact">
              <Speaker speaker={outcomesSpeaker} at={outcomes.createdAt} inset={false} />
              <MessageText message={outcomes} className="text-sm text-muted-foreground" />
            </MessageContent>
          </Message>
        </MessageScrollerItem>
      )}
      {message !== undefined && (
        <MessageScrollerItem messageId={`${entry.turn.id}:message`} scrollAnchor>
          <Message align={align} aria-label={`Message from ${message.author}`} role="group">
            <MessageContent spacing="compact">
              <Speaker speaker={message.author} at={message.createdAt} />
              <Bubble variant="muted" align={align} className="max-w-[85%]">
                <BubbleContent variant="message" pending={pending}>
                  <MessageText message={message} />
                </BubbleContent>
              </Bubble>
              {pending && <MessageFooter variant="plain">{unsentLabel}</MessageFooter>}
            </MessageContent>
          </Message>
        </MessageScrollerItem>
      )}
      {!pending && (
        <MessageScrollerItem messageId={`${entry.turn.id}:reply`}>
          <Message aria-label="Answer" role="group" aria-busy={entry.turn.state._tag === "Running"}>
            <MessageContent spacing="relaxed">
              {(activity.length > 0 || reply !== undefined) && (
                <Speaker speaker={supervisorSpeaker} at={reply?.createdAt} inset={false} />
              )}
              {activity.length > 0 && (
                <div className="space-y-1">
                  {activity.map((step) =>
                    step._tag === "Tools" ? (
                      <ConversationToolGroup key={step.key} group={step} />
                    ) : step._tag === "Request" ? (
                      <PermissionRequestBlock key={step.key} request={step.request} />
                    ) : (
                      <Markdown
                        key={step.key}
                        className="py-1 text-md text-muted-foreground wrap-anywhere"
                      >
                        {step.text}
                      </Markdown>
                    ),
                  )}
                </div>
              )}
              {reply !== undefined && <MessageText message={reply} />}
              <TurnState entry={entry} cancel={cancel} canceling={canceling} />
            </MessageContent>
          </Message>
        </MessageScrollerItem>
      )}
    </ReferenceScopeContext>
  );
};

type TimelineEmptyProps = { readonly children: ReactNode };

export const TimelineEmpty = ({ children }: TimelineEmptyProps) => (
  <MessageScrollerItem messageId="empty">
    <p className="text-sm text-muted-foreground">{children}</p>
  </MessageScrollerItem>
);
