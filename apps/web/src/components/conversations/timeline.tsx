import { DateTime } from "effect";
import type { MemberMessage, SupervisorMessage } from "@usine/core/conversation";
import type { ReactNode } from "react";
import { Markdown } from "~/components/markdown";
import { StatusBadge } from "~/components/status-badge";
import { Button } from "~/components/ui/button";
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
import { clockLabel, timestampLabel } from "~/lib/strings";
import { cn } from "~/lib/utils";

type SpeakerLineProps = {
  readonly speaker: string;
  readonly at: DateTime.Utc | undefined;
  readonly tone?: "plain" | "failed";
};

const SpeakerLine = ({ speaker, at, tone = "plain" }: SpeakerLineProps) => {
  const instant = at === undefined ? undefined : DateTime.formatIso(at);
  return (
    <p className="flex items-baseline gap-2 text-xs">
      <span className={cn("font-medium", tone === "failed" && "text-destructive")}>{speaker}</span>
      {instant !== undefined && (
        <time
          dateTime={instant}
          title={timestampLabel(instant)}
          className="font-mono tabular-nums text-muted-foreground"
        >
          {clockLabel(instant)}
        </time>
      )}
    </p>
  );
};

type MessageBodyProps = { readonly message: MemberMessage | SupervisorMessage };

const MessageBody = ({ message }: MessageBodyProps) => {
  const markdown = markdownBody(message);
  return markdown === undefined ? (
    <p className="text-md whitespace-pre-wrap wrap-anywhere">{bodyText(message.body)}</p>
  ) : (
    <Markdown className="text-md wrap-anywhere">{markdown}</Markdown>
  );
};

type TurnStateLineProps = {
  readonly entry: TurnEntry;
  readonly cancel: (() => void) | undefined;
  readonly canceling: boolean;
};

const TurnStateLine = ({ entry, cancel, canceling }: TurnStateLineProps) => {
  const { state } = entry.turn;
  const action =
    cancel === undefined ? null : (
      <Button variant="ghost" size="sm" onClick={cancel} disabled={canceling}>
        {canceling ? cancelingTurnLabel : cancelTurnLabel}
      </Button>
    );
  switch (state._tag) {
    case "Queued":
      return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <StatusBadge state="Queued" label={entry.behind ? queuedBehindLabel : queuedLabel} />
          {action}
        </div>
      );
    case "Running":
      return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <StatusBadge state="Running" label={runningLabel} />
          {action}
        </div>
      );
    case "Failed":
      return (
        <div className="rounded-lg border border-destructive/25 bg-destructive/8 px-3 pt-2 pb-2.5 text-sm">
          <p className="font-medium text-destructive">{failedLabel}</p>
          <p className="wrap-anywhere">{failureReason(state.failure)}</p>
        </div>
      );
    case "Canceled":
      return <StatusBadge state="Canceled" label={canceledLabel(state.by)} />;
    case "Succeeded":
      return null;
  }
};

type TurnBlockProps = {
  readonly entry: TurnEntry;
  /** Whether the turn's member message is still being sent. */
  readonly pending: boolean;
  readonly cancel: (() => void) | undefined;
  readonly canceling: boolean;
};

/** Renders one turn: the member's message, the session's text and tool calls, then the answer. */
export const TurnBlock = ({ entry, pending, cancel, canceling }: TurnBlockProps) => {
  const { message, activity, reply } = entry;
  return (
    <MessageScrollerItem
      messageId={entry.turn.id}
      scrollAnchor
      className="space-y-4"
      aria-busy={entry.turn.state._tag === "Running"}
    >
      {message !== undefined && (
        <section aria-label={`Message from ${message.author}`} className="space-y-1">
          <SpeakerLine speaker={message.author} at={message.createdAt} />
          <div className={cn(pending && "opacity-60")}>
            <MessageBody message={message} />
          </div>
          {pending && <p className="text-xs text-muted-foreground">{unsentLabel}</p>}
        </section>
      )}
      {activity.length > 0 && (
        <div className="space-y-2">
          {activity.map((step) =>
            step._tag === "Tool" ? (
              <ConversationToolRow key={step.call.key} call={step.call} />
            ) : (
              <Markdown key={step.key} className="text-md text-muted-foreground wrap-anywhere">
                {step.text}
              </Markdown>
            ),
          )}
        </div>
      )}
      {!pending && <TurnStateLine entry={entry} cancel={cancel} canceling={canceling} />}
      {reply !== undefined && (
        <section aria-label="Answer" className="space-y-1">
          <SpeakerLine speaker={supervisorSpeaker} at={reply.createdAt} />
          <MessageBody message={reply} />
        </section>
      )}
    </MessageScrollerItem>
  );
};

type TimelineEmptyProps = { readonly children: ReactNode };

export const TimelineEmpty = ({ children }: TimelineEmptyProps) => (
  <MessageScrollerItem messageId="empty">
    <p className="text-sm text-muted-foreground">{children}</p>
  </MessageScrollerItem>
);
