import { CaretRightIcon } from "@phosphor-icons/react";
import type { RunId } from "@usine/core/run";
import { ChildTarget } from "@usine/core/attempt/channel";
import { SessionComposer } from "../run-intervention/session-composer.tsx";
import { useMemo } from "react";
import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { MessageScrollerItem, useMessageScroller } from "@/components/ui/message-scroller";
import { Message, MessageContent, MessageHeader } from "@/components/ui/message";
import { TranscriptToolRow } from "./tool/tool.tsx";
import { CompletedTools } from "./grouping/group.tsx";
import { groupTranscript, type GroupedItem, type GroupedSession } from "./grouping/model.ts";
import { useTranscriptDisclosure } from "./grouping/disclosure.tsx";
import { SessionHandoff } from "./handoff.tsx";
import { cn } from "@/lib/utils";
import {
  matchesFilter,
  type TranscriptFilter,
  type TranscriptNotice,
  type TranscriptProjection,
} from "./model.ts";

const Timestamp = ({ receivedAt }: { readonly receivedAt: string }) => {
  const age = Math.max(0, Date.now() - Date.parse(receivedAt));
  const label =
    age < 60_000
      ? "now"
      : age < 3_600_000
        ? `${Math.floor(age / 60_000)}m ago`
        : age < 86_400_000
          ? `${Math.floor(age / 3_600_000)}h ago`
          : `${Math.floor(age / 86_400_000)}d ago`;
  return (
    <time
      dateTime={receivedAt}
      title={receivedAt}
      className="shrink-0 font-mono tabular-nums text-muted-foreground"
    >
      {label}
    </time>
  );
};

const Notice = ({ entry }: { readonly entry: TranscriptNotice }) => (
  <Message data-transcript-id={entry.key} className="motion-safe:animate-in motion-safe:fade-in">
    <MessageContent>
      <MessageHeader
        className={cn("justify-between gap-3 px-0", entry.isError && "text-destructive")}
      >
        <span>{entry.label}</span>
        <Timestamp receivedAt={entry.receivedAt} />
      </MessageHeader>
      {entry.detail !== "" &&
        (entry.format === "markdown" ? (
          <Markdown>{entry.detail}</Markdown>
        ) : (
          <p
            className={cn(
              "text-xs/relaxed whitespace-pre-wrap wrap-anywhere",
              entry.isError ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {entry.detail}
          </p>
        ))}
    </MessageContent>
  </Message>
);

const Entry = ({
  entry,
}: {
  readonly entry: Exclude<GroupedItem, { readonly _tag: "Session" }>;
}) =>
  entry._tag === "ToolGroup" ? (
    <CompletedTools group={entry} />
  ) : entry._tag === "Tool" ? (
    <TranscriptToolRow entry={entry} />
  ) : (
    <Notice entry={entry} />
  );

const visible = (item: GroupedItem, filter: TranscriptFilter) =>
  item._tag === "Session" ||
  (item._tag === "ToolGroup" ? filter !== "messages" : matchesFilter(item, filter));

const Child = ({
  session,
  filter,
  runId,
}: {
  readonly runId: RunId;
  readonly session: GroupedSession;
  readonly filter: TranscriptFilter;
}) => {
  const { scrollToMessage } = useMessageScroller();
  const { state, change } = useTranscriptDisclosure();
  const entries = session.entries.filter((entry) => visible(entry, filter));
  const activity = session.activity;
  return (
    <Collapsible
      data-transcript-id={session.key}
      open={state.get(session.key)?.open === true}
      className="min-w-0 rounded-md border"
      onOpenChange={(open) => {
        if (open) scrollToMessage(session.key, { align: "nearest", behavior: "instant" });
        change({ _tag: "Item", key: session.key, open });
      }}
    >
      <CollapsibleTrigger
        aria-label={`${session.session.agent} activity · ${activity}`}
        render={
          <Button
            variant="ghost"
            size="sm"
            className="h-auto w-full flex-wrap justify-between gap-3 p-2 text-left data-[panel-open]:[&_svg]:rotate-90"
          />
        }
      >
        <span className="inline-flex min-w-0 items-center gap-1.5 font-mono">
          <CaretRightIcon aria-hidden="true" className="shrink-0 transition-transform" />
          <span className="truncate">{session.session.agent} activity</span>
        </span>
        <Badge
          variant="outline"
          className={cn(
            "h-auto max-w-full whitespace-normal wrap-anywhere",
            session.status === "Live" && "text-run-active",
          )}
        >
          {activity}
        </Badge>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 px-3 pb-3">
        <p className="font-mono text-[0.625rem] text-muted-foreground">
          {session.session.brain.harness} · {session.session.brain.model} ·{" "}
          {session.session.brain.effort}
        </p>
        <SessionHandoff session={session} />
        {entries.length === 0 ? (
          <p className="text-xs text-muted-foreground">No {filter} in this session.</p>
        ) : (
          entries.map((entry) => (
            <MessageScrollerItem
              key={entry.key}
              messageId={entry.key}
              className={
                entry._tag === "ToolGroup" || entry._tag === "Tool" ? "-mx-2 px-2" : undefined
              }
            >
              <Entry entry={entry} />
            </MessageScrollerItem>
          ))
        )}
        {session.status === "Live" && (
          <SessionComposer
            runId={runId}
            attemptId={session.attemptId}
            target={new ChildTarget({ sessionId: session.session.id })}
            paused={session.paused}
          />
        )}
      </CollapsibleContent>
    </Collapsible>
  );
};

/** Parent prose and paired tool calls, with one child section per Attempt-scoped session. */
export const Transcript = ({
  projection,
  filter,
  runId,
}: {
  readonly projection: TranscriptProjection;
  readonly filter: TranscriptFilter;
  readonly runId: RunId;
}) => {
  const grouped = useMemo(() => groupTranscript(projection), [projection]);
  const items = grouped.filter((item) => visible(item, filter));
  if (items.length === 0)
    return (
      <MessageScrollerItem messageId="empty">
        <p className="text-xs text-muted-foreground">
          {projection.items.length === 0
            ? "No transcript events yet."
            : `No ${filter} in the loaded transcript.`}
        </p>
      </MessageScrollerItem>
    );
  return (
    <>
      {/* Reserve space for tool and group backgrounds outside the text column:
          MessageScrollerItem paint containment would otherwise clip it. */}
      {items.map((item) => (
        <MessageScrollerItem
          messageId={item.key}
          key={item.key}
          className={item._tag === "ToolGroup" || item._tag === "Tool" ? "-mx-2 px-2" : undefined}
        >
          {item._tag === "Session" ? (
            <Child session={item} filter={filter} runId={runId} />
          ) : (
            <Entry entry={item} />
          )}
        </MessageScrollerItem>
      ))}
    </>
  );
};
