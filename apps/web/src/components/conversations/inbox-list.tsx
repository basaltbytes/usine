import { PlusIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import type { ConversationId } from "@usine/core/conversation";
import { DateTime } from "effect";
import type { KeyboardEvent } from "react";
import { EmptyList } from "~/components/empty-list";
import { ErrorAlert } from "~/components/error-alert";
import { StateMark } from "~/components/status-badge";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { SetupRequired } from "~/components/conversations/footer";
import { useScopeName } from "~/hooks/use-conversation-access";
import { rejectionMessage } from "~/lib/api";
import {
  type ConversationRow,
  conversationsQuery,
  conversationStatusQuery,
  unreadCount,
} from "~/lib/conversations/queries";
import {
  conversationListLabel,
  emptyListDescription,
  emptyListTitle,
  failedLabel,
  loadingConversations,
  newConversationLabel,
  queuedLabel,
  runningLabel,
  unreadCountLabel,
  unreadLabel,
} from "~/lib/conversations/strings";
import { elapsedLabel, timestampLabel } from "~/lib/strings";
import { cn } from "~/lib/utils";

/** The last turn's state when the row shows it: only while it waits, runs, or has failed. */
const shownState = (row: ConversationRow) => {
  switch (row.lastTurn?.state._tag) {
    case "Queued":
      return { state: "Queued", label: queuedLabel };
    case "Running":
      return { state: "Running", label: runningLabel };
    case "Failed":
      return { state: "Failed", label: failedLabel };
    default:
      return undefined;
  }
};

type RowProps = {
  readonly row: ConversationRow;
  readonly selected: boolean;
  readonly now: number;
  readonly open: (id: ConversationId) => void;
};

const Row = ({ row, selected, now, open }: RowProps) => {
  const { conversation } = row;
  const scope = useScopeName(conversation.scope);
  const activity = DateTime.formatIso(row.lastActivity);
  const unread = row.unread === true;
  const state = shownState(row);
  return (
    <li>
      <button
        type="button"
        data-inbox-row={conversation.id}
        aria-current={selected ? "true" : undefined}
        onClick={() => open(conversation.id)}
        className={cn(
          "grid w-full min-w-0 grid-cols-[0.5rem_minmax(0,1fr)_auto] items-baseline gap-x-2.5 gap-y-0.5 rounded-md px-3 py-2.5 text-left outline-none select-none",
          "transition-colors duration-100 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-inset active:bg-muted/70",
          "aria-[current=true]:bg-muted",
        )}
      >
        <span className="row-span-3 flex h-5 items-center self-start">
          {unread && (
            <>
              <span
                aria-hidden="true"
                className="pointer-events-none size-2 rounded-full bg-primary"
              />
              <span className="sr-only">{unreadLabel}</span>
            </>
          )}
        </span>
        <span
          className={cn(
            "truncate text-md",
            unread ? "font-semibold text-foreground" : "font-normal text-foreground/90",
          )}
        >
          {conversation.title}
        </span>
        <time
          dateTime={activity}
          title={timestampLabel(activity)}
          className={cn(
            "font-mono text-xs tabular-nums",
            unread ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {elapsedLabel(activity, now)}
        </time>
        <span className="col-span-2 truncate text-sm text-muted-foreground">
          {row.preview === "" ? " " : row.preview}
        </span>
        <span className="col-span-2 flex min-w-0 items-center gap-2 text-xs text-faint">
          <span className="truncate">
            {scope} · {conversation.createdBy}
          </span>
          {state !== undefined && (
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-muted-foreground">
              <StateMark state={state.state} />
              {state.label}
            </span>
          )}
        </span>
      </button>
    </li>
  );
};

/** Moves focus between rows with the arrow keys or j and k. */
const moveFocus = (event: KeyboardEvent<HTMLUListElement>) => {
  const step =
    event.key === "ArrowDown" || event.key === "j"
      ? 1
      : event.key === "ArrowUp" || event.key === "k"
        ? -1
        : 0;
  if (step === 0 || event.metaKey || event.ctrlKey || event.altKey) return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-inbox-row]")];
  const current = rows.findIndex((row) => row === document.activeElement);
  const next = rows[Math.min(rows.length - 1, Math.max(0, current + step))];
  if (next === undefined) return;
  event.preventDefault();
  next.focus();
};

const LoadingRows = () => (
  <div aria-busy="true" aria-label={loadingConversations} className="space-y-1 px-2 py-1">
    {[0, 1, 2].map((index) => (
      <div key={index} className="space-y-2 px-3 py-3">
        <Skeleton className="h-3.5 w-3/4" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-2.5 w-1/3" />
      </div>
    ))}
  </div>
);

type InboxListProps = {
  readonly selected: ConversationId | undefined;
  readonly open: (id: ConversationId) => void;
  /** Starts a new conversation; `undefined` when this member can't start one. */
  readonly start: (() => void) | undefined;
};

/** The inbox's list: each conversation the member can read, latest activity first. */
export const InboxList = ({ selected, open, start }: InboxListProps) => {
  const list = useQuery(conversationsQuery());
  const status = useQuery(conversationStatusQuery());
  const now = Date.now();
  const rows = list.data?.conversations ?? [];
  const unread = list.data === undefined ? 0 : unreadCount(list.data);
  return (
    <section aria-label={conversationListLabel} className="flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-16 shrink-0 items-center gap-3 border-b px-5 py-3.5 pr-4 @max-3xl/inbox:pr-[var(--inbox-controls,1rem)]">
        <h2 className="text-lg/snug font-semibold">{conversationListLabel}</h2>
        {unread > 0 && (
          <span className="text-sm whitespace-nowrap text-muted-foreground tabular-nums">
            {unreadCountLabel(unread)}
          </span>
        )}
        {start !== undefined && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon"
                  className="ml-auto shrink-0 pointer-coarse:size-11"
                  aria-label={newConversationLabel}
                  onClick={start}
                />
              }
            >
              <PlusIcon />
            </TooltipTrigger>
            <TooltipContent side="bottom">{newConversationLabel}</TooltipContent>
          </Tooltip>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-thin">
        {selected === undefined && status.data?.state === "setup-required" && (
          <div className="px-4 pt-4">
            <SetupRequired reason={status.data.reason ?? ""} />
          </div>
        )}
        {list.isError ? (
          <div className="px-4 pt-4">
            <ErrorAlert message={rejectionMessage(list.error)} />
          </div>
        ) : list.data === undefined ? (
          <LoadingRows />
        ) : rows.length === 0 ? (
          <div className="px-4 pt-4">
            <EmptyList
              title={emptyListTitle}
              description={emptyListDescription}
              action={
                start === undefined ? undefined : (
                  <Button size="sm" onClick={start}>
                    {newConversationLabel}
                  </Button>
                )
              }
            />
          </div>
        ) : (
          <ul className="space-y-0.5 px-2 py-2" onKeyDown={moveFocus}>
            {rows.map((row) => (
              <Row
                key={row.conversation.id}
                row={row}
                selected={row.conversation.id === selected}
                now={now}
                open={open}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
};
