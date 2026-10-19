import { Option } from "effect";
import { StateMark } from "@/components/status-badge";
import { useNow } from "@/hooks/use-now";
import type { Chapter } from "./document/model.ts";
import { sessionActivityLabel, type TranscriptSession } from "./model.ts";
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

interface Activity {
  readonly label: string;
  readonly detail: string;
  readonly since: Option.Option<string>;
}

/** Describes recorded work; terminal sessions never continue to advertise a running tool. */
export const describeActivity = (session: TranscriptSession): Activity => {
  if (session.status !== "Live")
    return { label: session.status, detail: "", since: Option.none<string>() };
  if (session.paused || session.held || session.idle)
    return { label: sessionActivityLabel(session), detail: "", since: Option.none<string>() };
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

/** The session that best says what a live Attempt is doing: its most recently active live child, else its parent. */
export const currentSession = (
  sessions: ReadonlyArray<TranscriptSession>,
): TranscriptSession | undefined => {
  const live = sessions.filter(({ status }) => status === "Live");
  const children = live
    .filter(({ session }) => session._tag === "ChildSession")
    .sort((left, right) => right.latestSequence - left.latestSequence);
  return children[0] ?? live.find(({ session }) => session._tag === "ParentSession");
};

/** A live Attempt's current action, elapsed time, and last activity, as one quiet status line. */
export const CurrentActivity = ({ chapter }: { readonly chapter: Chapter }) => {
  const now = useNow(1_000);
  const session = currentSession(chapter.sessions);
  const activity: Activity =
    session === undefined
      ? {
          label: "Waiting for the parent session to start",
          detail: "",
          since: Option.none(),
        }
      : describeActivity(session);
  return (
    <div role="status" aria-label="Current activity" className="min-w-0 space-y-0.5 text-xs">
      <p className="flex min-w-0 items-center gap-2">
        <StateMark state="Running" />
        {session !== undefined && (
          <span className="shrink-0 font-medium text-foreground">
            {session.session._tag === "ParentSession" ? "Parent" : session.session.agent}
          </span>
        )}
        <span className="min-w-0 truncate text-muted-foreground">{activity.label}</span>
        {Option.match(activity.since, {
          onNone: () => null,
          onSome: (since) => (
            <span
              aria-live="off"
              className="ml-auto shrink-0 font-mono tabular-nums text-muted-foreground"
              title={`Started ${since}`}
            >
              {elapsedActivity(since, now)}
            </span>
          ),
        })}
      </p>
      {activity.detail !== "" && (
        <p className="truncate pl-3.5 font-mono text-muted-foreground" title={activity.detail}>
          {activity.detail}
        </p>
      )}
      {Option.match(chapter.lastActivityAt, {
        onNone: () => null,
        onSome: (at) => (
          <p aria-live="off" className="pl-3.5 text-muted-foreground">
            Last activity {elapsedActivity(at, now)} ago
          </p>
        ),
      })}
    </div>
  );
};
