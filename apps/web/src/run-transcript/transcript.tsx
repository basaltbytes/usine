import { CaretRightIcon } from "@phosphor-icons/react";
import type { AttemptView, TranscriptEventView } from "@usine/orchestrator/operator";
import { Match, Option } from "effect";
import { useMemo } from "react";
import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Marker } from "@/components/ui/marker";
import { Message, MessageContent, MessageHeader } from "@/components/ui/message";
import { cn } from "@/lib/utils";
import {
  matchesFilter,
  projectTranscript,
  sessionActivityLabel,
  type TranscriptEntry,
  type TranscriptFilter,
  type TranscriptNotice,
  type TranscriptSession,
  type TranscriptTool,
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

const Tool = ({ entry }: { readonly entry: TranscriptTool }) => {
  const start = entry.start;
  const state = entry.state;
  const preview = Option.match(start, {
    onNone: () => "Earlier input is not loaded",
    onSome: ({ input }) => {
      const text = Match.value(input).pipe(
        Match.when({ command: Match.string }, ({ command }) => command),
        Match.when({ path: Match.string }, ({ path }) => path),
        Match.when({ query: Match.string }, ({ query }) => query),
        Match.orElse((value) => JSON.stringify(value)),
      );
      return text.length > 120 ? `${text.slice(0, 120)}…` : text;
    },
  });
  const duration = Option.match(start, {
    onNone: () => "",
    onSome: ({ receivedAt }) => {
      if (state._tag !== "Finished" && state._tag !== "Error") return "";
      const elapsed = Date.parse(state.receivedAt) - Date.parse(receivedAt);
      if (!Number.isFinite(elapsed) || elapsed < 0) return "";
      return elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`;
    },
  });
  return (
    <Collapsible
      data-transcript-id={entry.key}
      className="min-w-0 motion-safe:animate-in motion-safe:fade-in"
    >
      <CollapsibleTrigger
        aria-label={`${entry.name} · ${state._tag}`}
        render={
          <Button
            variant="ghost"
            size="sm"
            className="h-auto w-full min-w-0 justify-start gap-2 px-2 py-1.5 text-left data-[panel-open]:[&_svg]:rotate-90"
          />
        }
      >
        <Marker render={<span />} className="gap-2">
          <CaretRightIcon aria-hidden="true" className="shrink-0 transition-transform" />
          <span className="shrink-0 font-mono">{entry.name}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[0.625rem] text-muted-foreground">
            {preview}
          </span>
          <span
            className={cn(
              "shrink-0 text-[0.625rem]",
              state._tag === "Error" && "text-destructive",
              state._tag === "Running" && "text-run-active motion-safe:shimmer",
            )}
          >
            {state._tag}
          </span>
          {duration !== "" && (
            <span className="shrink-0 font-mono text-[0.625rem] text-muted-foreground">
              {duration}
            </span>
          )}
        </Marker>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 border-t p-3 text-xs/relaxed">
        <div className="flex justify-between gap-3 text-muted-foreground">
          <span>Tool activity</span>
          <Timestamp receivedAt={entry.receivedAt} />
        </div>
        <div>
          <p className="mb-1 font-medium">Input</p>
          {Option.match(start, {
            onNone: () => (
              <p className="text-muted-foreground">
                The start of this call is outside the loaded transcript.
              </p>
            ),
            onSome: ({ input }) => (
              <pre className="font-mono text-[0.625rem]/relaxed whitespace-pre-wrap wrap-anywhere">
                {JSON.stringify(input, null, 2)}
              </pre>
            ),
          })}
        </div>
        <div>
          <p className="mb-1 font-medium">Output</p>
          {state._tag === "Finished" || state._tag === "Error" ? (
            <pre
              className={cn(
                "font-mono text-[0.625rem]/relaxed whitespace-pre-wrap wrap-anywhere",
                state._tag === "Error" && "text-destructive",
              )}
            >
              {JSON.stringify(state.output, null, 2)}
            </pre>
          ) : (
            <p className="text-muted-foreground">
              {state._tag === "Running"
                ? "Waiting for a result."
                : "The session ended without a recorded result for this call."}
            </p>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

const Entry = ({ entry }: { readonly entry: TranscriptEntry }) =>
  entry._tag === "Tool" ? <Tool entry={entry} /> : <Notice entry={entry} />;

const Child = ({
  session,
  filter,
}: {
  readonly session: TranscriptSession;
  readonly filter: TranscriptFilter;
}) => {
  const entries = session.entries.filter((entry) => matchesFilter(entry, filter));
  const activity = sessionActivityLabel(session);
  return (
    <Collapsible data-transcript-id={session.key} className="min-w-0 rounded-md border">
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
      <p className="text-xs text-muted-foreground">
        {events.length === 0
          ? "No transcript events yet."
          : `No ${filter} in the loaded transcript.`}
      </p>
    );
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {items.map((item) =>
        item._tag === "Session" ? (
          <Child session={item} filter={filter} key={item.key} />
        ) : (
          <Entry entry={item} key={item.key} />
        ),
      )}
    </div>
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
