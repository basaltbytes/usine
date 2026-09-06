import { CaretRightIcon } from "@phosphor-icons/react";
import type { AttemptView, TranscriptEventView } from "@usine/orchestrator/operator";
import { useMemo } from "react";
import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { MessageScrollerItem, useMessageScroller } from "@/components/ui/message-scroller";
import { Message, MessageContent, MessageHeader } from "@/components/ui/message";
import { TranscriptToolRow } from "./tool/tool.tsx";
import { cn } from "@/lib/utils";
import {
  matchesFilter,
  projectTranscript,
  sessionActivityLabel,
  type TranscriptEntry,
  type TranscriptFilter,
  type TranscriptNotice,
  type TranscriptSession,
} from "./model.ts";

interface TranscriptSource {
  readonly events: ReadonlyArray<TranscriptEventView>;
  readonly attempts: ReadonlyArray<AttemptView>;
}

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

const Entry = ({ entry }: { readonly entry: TranscriptEntry }) =>
  entry._tag === "Tool" ? <TranscriptToolRow entry={entry} /> : <Notice entry={entry} />;

const Child = ({
  session,
  filter,
}: {
  readonly session: TranscriptSession;
  readonly filter: TranscriptFilter;
}) => {
  const { scrollToMessage } = useMessageScroller();
  const entries = session.entries.filter((entry) => matchesFilter(entry, filter));
  const activity = sessionActivityLabel(session);
  return (
    <Collapsible
      data-transcript-id={session.key}
      className="min-w-0 rounded-md border"
      onOpenChange={(open) => {
        if (open) scrollToMessage(session.key, { align: "nearest", behavior: "instant" });
      }}
    >
      <CollapsibleTrigger
        aria-label={`${session.session.agent} activity · ${activity}`}
        render={
          <Button
            variant="ghost"
            size="sm"
            className="h-auto w-full justify-between gap-3 p-2 text-left data-[panel-open]:[&_svg]:rotate-90"
          />
        }
      >
        <span className="inline-flex min-w-0 items-center gap-1.5 font-mono">
          <CaretRightIcon aria-hidden="true" className="shrink-0 transition-transform" />
          <span className="truncate">{session.session.agent} activity</span>
        </span>
        <Badge variant="outline" className={cn(session.status === "Live" && "text-run-active")}>
          {activity}
        </Badge>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 border-t p-3">
        <p className="font-mono text-[0.625rem] text-muted-foreground">
          {session.session.brain.harness} · {session.session.brain.model} ·{" "}
          {session.session.brain.effort}
        </p>
        {entries.length === 0 ? (
          <p className="text-xs text-muted-foreground">No {filter} in this session.</p>
        ) : (
          entries.map((entry) => <Entry entry={entry} key={entry.key} />)
        )}
      </CollapsibleContent>
    </Collapsible>
  );
};

/** Parent prose and paired tool calls, with one child section per Attempt-scoped session. */
export const Transcript = ({
  events,
  attempts,
  filter,
}: TranscriptSource & { readonly filter: TranscriptFilter }) => {
  const projection = useMemo(() => projectTranscript(events, attempts), [events, attempts]);
  const items = projection.items.filter(
    (item) => item._tag === "Session" || matchesFilter(item, filter),
  );
  if (items.length === 0)
    return (
      <MessageScrollerItem messageId="empty">
        <p className="text-xs text-muted-foreground">
          {events.length === 0
            ? "No transcript events yet."
            : `No ${filter} in the loaded transcript.`}
        </p>
      </MessageScrollerItem>
    );
  return (
    <>
      {items.map((item) => (
        <MessageScrollerItem messageId={item.key} key={item.key}>
          {item._tag === "Session" ? (
            <Child session={item} filter={filter} />
          ) : (
            <Entry entry={item} />
          )}
        </MessageScrollerItem>
      ))}
    </>
  );
};

/** Keeps the latest Attempt's parent activity and child counts visible while the conversation scrolls. */
export const SessionActivity = ({ events, attempts }: TranscriptSource) => {
  const projection = useMemo(() => projectTranscript(events, attempts), [events, attempts]);
  const attempt = [...attempts].sort((left, right) => right.number - left.number)[0];
  if (attempt === undefined) return null;
  const sessions = projection.sessions.filter(({ attemptId }) => attemptId === attempt.id);
  const parent = sessions.find(({ session }) => session._tag === "ParentSession");
  const children = sessions.filter(({ session }) => session._tag === "ChildSession");
  const live = children.filter(({ status }) => status === "Live").length;
  const finished = children.filter(({ status }) => status === "Finished").length;
  const stopped = children.filter(({ status }) => status === "Stopped").length;
  const active =
    parent === undefined ? !projection.terminalAttempts.has(attempt.id) : parent.status === "Live";
  const status =
    parent === undefined ? (active ? "Awaiting parent activity" : "Ended") : parent.status;
  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-xs text-muted-foreground sm:px-6"
    >
      <span className={cn("inline-flex items-center gap-1.5", active && "motion-safe:shimmer")}>
        <span
          aria-hidden="true"
          className={cn("size-1.5 rounded-full", active ? "bg-run-active" : "bg-muted-foreground")}
        />
        Attempt {attempt.number} · {parent?.session.agent ?? "Parent"} ·{" "}
        {parent === undefined ? status : sessionActivityLabel(parent)}
      </span>
      {children.length > 0 && (
        <span>
          Children:{" "}
          {[
            live > 0 ? `${live} live` : "",
            finished > 0 ? `${finished} finished` : "",
            stopped > 0 ? `${stopped} stopped` : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      )}
    </div>
  );
};
