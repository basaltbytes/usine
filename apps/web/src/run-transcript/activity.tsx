import type { AttemptView, TranscriptEventView } from "@usine/orchestrator/operator";
import { Option } from "effect";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { projectTranscript, type TranscriptSession } from "./model.ts";
import { presentTool } from "./tool/presentation.ts";

/** Formats elapsed activity time without implying that a quiet session has stalled. */
export const elapsedActivity = (startedAt: string, now: number): string => {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

/** Describes recorded work; terminal sessions never continue to advertise a running tool. */
export const describeActivity = (session: TranscriptSession) => {
  if (session.status !== "Live")
    return { label: session.status, detail: "", since: Option.none<string>() };
  const tool = [...session.entries]
    .reverse()
    .find((entry) => entry._tag === "Tool" && entry.state._tag === "Running");
  if (tool?._tag !== "Tool") return { label: "Working", detail: "", since: Option.none<string>() };
  const view = presentTool(tool);
  return {
    label: {
      command: "Running command",
      read: "Reading file",
      edit: "Editing file",
      write: "Writing file",
      search: "Searching",
      agent: "Delegating",
      tool: `Running ${view.title}`,
    }[view.category],
    detail: view.subject,
    since: Option.map(tool.start, ({ receivedAt }) => receivedAt),
  };
};

/** Keeps the latest Attempt's action, elapsed time, and child counts visible above the conversation. */
export const SessionActivity = ({
  events,
  attempts,
}: {
  readonly events: ReadonlyArray<TranscriptEventView>;
  readonly attempts: ReadonlyArray<AttemptView>;
}) => {
  const projection = useMemo(() => projectTranscript(events, attempts), [events, attempts]);
  const attempt = [...attempts].sort((left, right) => right.number - left.number)[0];
  const sessions = projection.sessions.filter(({ attemptId }) => attemptId === attempt?.id);
  const parent = sessions.find(({ session }) => session._tag === "ParentSession");
  const children = sessions.filter(({ session }) => session._tag === "ChildSession");
  const active =
    attempt !== undefined &&
    (parent === undefined
      ? !projection.terminalAttempts.has(attempt.id)
      : parent.status === "Live");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  if (attempt === undefined) return null;
  const activity =
    parent === undefined
      ? {
          label: active ? "Awaiting parent activity" : "Ended",
          detail: "",
          since: Option.none<string>(),
        }
      : describeActivity(parent);
  const lastActivity = [...events]
    .reverse()
    .find(
      (event) =>
        event.attemptId === attempt.id &&
        event.direction === "outbound" &&
        (event.payload._tag !== "SessionEvent" ||
          event.payload.event._tag !== "PoolRateLimitsUpdated"),
    );
  const childCounts = (["Live", "Finished", "Stopped"] as const).flatMap((status) => {
    const count = children.filter((child) => child.status === status).length;
    return count === 0 ? [] : [`${count} ${status.toLowerCase()}`];
  });
  return (
    <section
      aria-label="Current activity"
      className="shrink-0 space-y-1.5 border-b px-4 py-2 text-xs sm:px-6"
    >
      <div className="flex items-start justify-between gap-3">
        <div role="status" className="min-w-0 space-y-1.5">
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                active ? "bg-run-active" : "bg-muted-foreground",
              )}
            />
            <span>
              Attempt {attempt.number} · {parent?.session.agent ?? "Parent"} · {activity.label}
            </span>
          </div>
          {activity.detail !== "" && (
            <p className="truncate font-mono" title={activity.detail}>
              {activity.detail}
            </p>
          )}
        </div>
        {Option.match(activity.since, {
          onNone: () => null,
          onSome: (since) => (
            <span
              aria-live="off"
              className="shrink-0 font-mono tabular-nums text-muted-foreground"
              title={`Started ${since}`}
            >
              {elapsedActivity(since, now)}
            </span>
          ),
        })}
      </div>
      {(childCounts.length > 0 || (active && lastActivity !== undefined)) && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-muted-foreground">
          {childCounts.length > 0 && <span>Children: {childCounts.join(" · ")}</span>}
          {active && lastActivity !== undefined && (
            <span aria-live="off">
              Last activity {elapsedActivity(lastActivity.receivedAt, now)} ago
            </span>
          )}
        </div>
      )}
    </section>
  );
};
