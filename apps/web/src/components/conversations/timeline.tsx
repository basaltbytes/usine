import { DateTime } from "effect";
import type { MemberMessage, SupervisorMessage } from "@usine/core/conversation";
import type { ReactNode } from "react";
import { Markdown } from "~/components/markdown";
import { StatusBadge } from "~/components/status-badge";
import { Bubble, BubbleContent } from "~/components/ui/bubble";
import { Button } from "~/components/ui/button";
import { Message, MessageContent, MessageFooter, MessageHeader } from "~/components/ui/message";
import { MessageScrollerItem } from "~/components/ui/message-scroller";
import { ConversationToolRow } from "~/components/conversations/tool-row";
import {
  canceledLabel,
  cancelingTurnLabel,
  cancelTurnLabel,
  failedLabel,
  failureReason,
  queuedBehindLabel,
  queuedLabel,
  runningLabel,
  supervisorSpeaker,
  unsentLabel,
} from "~/lib/conversations/strings";
import { bodyText, markdownBody, type TurnEntry } from "~/lib/conversations/timeline";
import { dayTimeLabel, timestampLabel } from "~/lib/strings";
import { cn } from "~/lib/utils";

type SpeakerProps = {
  readonly speaker: string;
  readonly at: DateTime.Utc | undefined;
  readonly className?: string;
};

const Speaker = ({ speaker, at, className }: SpeakerProps) => {
  const instant = at === undefined ? undefined : DateTime.formatIso(at);
  return (
    <MessageHeader className={cn("gap-2 text-xs", className)}>
      <span className="font-medium text-foreground">{speaker}</span>
      {instant !== undefined && (
        <time
          dateTime={instant}
          title={timestampLabel(instant)}
          className="font-mono font-normal tabular-nums"
        >
          {dayTimeLabel(instant)}
        </time>
      )}
    </MessageHeader>
  );
};

type MessageTextProps = {
  readonly message: MemberMessage | SupervisorMessage;
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
  const action =
    cancel === undefined ? null : (
      <Button
        variant="ghost"
        size="sm"
        className="pointer-coarse:h-11"
        onClick={cancel}
        disabled={canceling}
      >
        {canceling ? cancelingTurnLabel : cancelTurnLabel}
      </Button>
    );
  switch (state._tag) {
    case "Queued":
      return (
        <MessageFooter className="flex-wrap gap-x-3 gap-y-1 px-0 font-normal">
          <StatusBadge state="Queued" label={entry.behind ? queuedBehindLabel : queuedLabel} />
          {action}
        </MessageFooter>
      );
    case "Running":
      return (
        <MessageFooter className="flex-wrap gap-x-3 gap-y-1 px-0 font-normal">
          <StatusBadge state="Running" label={runningLabel} />
          {action}
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
        <MessageFooter className="px-0 font-normal">
          <StatusBadge state="Canceled" label={canceledLabel(state.by)} />
        </MessageFooter>
      );
    case "Succeeded":
      return null;
  }
};

type TurnMessagesProps = {
  readonly entry: TurnEntry;
  /** Whether the turn's member message is still being sent. */
  readonly pending: boolean;
  /** Whether the signed-in member posted the turn's message, which aligns it to the end. */
  readonly own: boolean;
  readonly cancel: (() => void) | undefined;
  readonly canceling: boolean;
};

/**
 * Renders one turn as two messages: the member's message, then the supervisor's text, tool calls,
 * state, and answer. The member's message is the scroll anchor while the answer streams in.
 */
export const TurnMessages = ({ entry, pending, own, cancel, canceling }: TurnMessagesProps) => {
  const { message, activity, reply } = entry;
  const align = own ? "end" : "start";
  return (
    <>
      {message !== undefined && (
        <MessageScrollerItem messageId={`${entry.turn.id}:message`} scrollAnchor>
          <Message align={align} aria-label={`Message from ${message.author}`} role="group">
            <MessageContent className="gap-1">
              <Speaker speaker={message.author} at={message.createdAt} />
              <Bubble variant="muted" align={align} className="max-w-[85%]">
                <BubbleContent className={cn("px-3 py-2", pending && "opacity-60")}>
                  <MessageText message={message} />
                </BubbleContent>
              </Bubble>
              {pending && <MessageFooter className="font-normal">{unsentLabel}</MessageFooter>}
            </MessageContent>
          </Message>
        </MessageScrollerItem>
      )}
      {!pending && (
        <MessageScrollerItem messageId={`${entry.turn.id}:reply`}>
          <Message aria-label="Answer" role="group" aria-busy={entry.turn.state._tag === "Running"}>
            <MessageContent className="gap-3">
              {(activity.length > 0 || reply !== undefined) && (
                <Speaker speaker={supervisorSpeaker} at={reply?.createdAt} className="px-0" />
              )}
              {activity.length > 0 && (
                <div className="space-y-1">
                  {activity.map((step) =>
                    step._tag === "Tool" ? (
                      <ConversationToolRow key={step.call.key} call={step.call} />
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
    </>
  );
};

type TimelineEmptyProps = { readonly children: ReactNode };

export const TimelineEmpty = ({ children }: TimelineEmptyProps) => (
  <MessageScrollerItem messageId="empty">
    <p className="text-sm text-muted-foreground">{children}</p>
  </MessageScrollerItem>
);
