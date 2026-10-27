import { Match, Option } from "effect";
import { StateMark } from "~/components/status-badge";
import { useNow } from "~/hooks/use-now";
import { cn } from "~/lib/utils";
import { clockLabel, timestampLabel } from "~/lib/strings";
import type { ConnectivityWarning } from "~/lib/runs/transcript/document/connectivity";
import type { Chapter } from "~/lib/runs/transcript/document/model";
import {
  retriesLabel,
  sessionActivityLabel,
  type TranscriptSession,
} from "~/lib/runs/transcript/model";
import { presentTool } from "~/lib/runs/transcript/tool/presentation";

/** Returns the elapsed time since `startedAt` as `45s`, `3m 12s`, or `2h 5m`. */
export const elapsedActivity = (startedAt: string, now: number): string => {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

/** Renders the elapsed time since `since`, updated every second. */
export const Elapsed = ({
  since,
  className,
}: {
  readonly since: string;
  readonly className?: string;
}) => {
  const now = useNow(1_000);
  return (
    <time
      dateTime={since}
      aria-live="off"
      className={cn("font-mono tabular-nums", className)}
      title={`Since ${timestampLabel(since)}`}
    >
      {elapsedActivity(since, now)}
    </time>
  );
};

interface Activity {
  readonly label: string;
  readonly detail: string;
  readonly since: Option.Option<string>;
}

/** Returns the session's activity; a session that is not `Live` never reports a running tool. */
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

/** Returns the most recently active live child session, else the parent session. */
const currentSession = (
  sessions: ReadonlyArray<TranscriptSession>,
): TranscriptSession | undefined => {
  const live = sessions.filter(({ status }) => status === "Live");
  const children = live
    .filter(({ session }) => session._tag === "ChildSession")
    .sort((left, right) => right.latestSequence - left.latestSequence);
  return children[0] ?? live.find(({ session }) => session._tag === "ParentSession");
};

export const CurrentActivity = ({ chapter }: { readonly chapter: Chapter }) => {
  const now = useNow(1_000);
  const session = currentSession(chapter.sessions);
  const activity: Activity =
    session === undefined
      ? {
          label: "Parent session starting",
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
              title={`Started ${timestampLabel(since)}`}
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
      {chapter.connectivity.map((warning) => (
        <ConnectivityLine
          key={
            warning._tag === "WorkerSilent" ? warning.worker : `${warning.agent}:${warning.since}`
          }
          warning={warning}
          now={now}
        />
      ))}
    </div>
  );
};

const ConnectivityLine = ({
  warning,
  now,
}: {
  readonly warning: ConnectivityWarning;
  readonly now: number;
}) => {
  const line = Match.valueTags(warning, {
    WorkerSilent: ({ worker, lastAnsweredAt }) => ({
      text: `${worker} silent since ${clockLabel(lastAnsweredAt)}`,
      since: lastAnsweredAt,
      detail: null,
    }),
    ProviderRetrying: ({ agent, retries, since, message }) => ({
      text: `${agent}: provider unreachable, ${retriesLabel(retries)} since ${clockLabel(since)}`,
      since,
      detail: message,
    }),
  });
  return (
    <>
      <p className="flex min-w-0 items-baseline gap-2 pl-3.5">
        <span className="min-w-0 text-warning">
          <span className="sr-only">Warning: </span>
          {line.text}
        </span>
        <span
          aria-live="off"
          className="ml-auto shrink-0 font-mono tabular-nums text-muted-foreground"
          title={`Since ${timestampLabel(line.since)}`}
        >
          {elapsedActivity(line.since, now)}
        </span>
      </p>
      {line.detail !== null && (
        <p className="truncate pl-3.5 text-muted-foreground" title={line.detail}>
          {line.detail}
        </p>
      )}
    </>
  );
};
