import { Option } from "effect";
import { Elapsed } from "~/components/runs/transcript/activity";
import { sessionName } from "~/features/runs/lib/outline";
import { ResumeDetails } from "~/features/runs/components/outline/resume-details";
import { Timeline } from "~/features/runs/components/outline/timeline";
import { type Chapter, type Checkpoint } from "~/lib/runs/transcript/document/model";
import type { TranscriptSession } from "~/lib/runs/transcript/model";
import { cn } from "~/lib/utils";

/** Returns a live session's status text; for a working session, it includes the elapsed time. */
const sessionStatus = (
  session: TranscriptSession,
): { readonly text: string; readonly tone: string; readonly since?: string } | null => {
  if (session.status !== "Live") return null;
  if (session.paused) return { text: "Paused", tone: "text-needs-you" };
  if (session.held)
    return session.idle
      ? { text: "Held, waiting for input", tone: "text-needs-you" }
      : { text: "Held", tone: "text-run-active" };
  if (session.idle) return { text: "Waiting for input", tone: "text-needs-you" };
  return { text: "Working", tone: "text-run-active", since: session.receivedAt };
};

type ChapterTreeProps = {
  readonly chapter: Chapter;
  readonly selectedSession: string | null;
  readonly current: string | null;
  readonly onSession: (sessionKey: string) => void;
  readonly onCheckpoint: (checkpoint: Checkpoint) => void;
};

export const ChapterTree = ({
  chapter,
  selectedSession,
  current,
  onSession,
  onCheckpoint,
}: ChapterTreeProps) => (
  <div className="space-y-0.5 pt-0.5 pb-1.5 pl-4">
    {chapter.sessions.map((session) => {
      const status = sessionStatus(session);
      return (
        <div key={session.key}>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              aria-current={selectedSession === session.key}
              onClick={() => onSession(session.key)}
              className="flex h-7 min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-2 text-left text-sidebar-foreground outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/70 aria-[current=true]:font-medium aria-[current=true]:text-foreground"
            >
              <span className="truncate">{sessionName(session)}</span>
              {status !== null && (
                <span className={cn("flex shrink-0 items-baseline gap-1.5 text-xs", status.tone)}>
                  {status.text}
                  {status.since !== undefined && (
                    <Elapsed since={status.since} className="text-muted-foreground" />
                  )}
                </span>
              )}
            </button>
            {session.session._tag === "ChildSession" && Option.isSome(chapter.attempt) && (
              <ResumeDetails session={session} attempt={chapter.attempt.value} />
            )}
          </div>
        </div>
      );
    })}
    <Timeline chapter={chapter} current={current} onCheckpoint={onCheckpoint} />
  </div>
);
