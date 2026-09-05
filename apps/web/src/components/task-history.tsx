import type { RunId } from "@usine/core/run";
import type { RunView } from "@usine/orchestrator/operator";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

/** Every Run in a task, in the chronological order supplied by the Board. */
export const TaskHistory = ({
  runs,
  openRun,
}: {
  readonly runs: ReadonlyArray<RunView>;
  readonly openRun: (id: RunId) => void;
}) => {
  if (runs.length === 0) return null;
  const attempts = runs.reduce((count, run) => count + run.attempts.length, 0);
  return (
    <div className="w-full min-w-0 space-y-2">
      <p className="text-muted-foreground">
        {runs.length} {runs.length === 1 ? "Run" : "Runs"} · {attempts}{" "}
        {attempts === 1 ? "Attempt" : "Attempts"}
      </p>
      <ScrollArea className={runs.length > 3 ? "h-48" : undefined} aria-label="Task Run history">
        <ol className="space-y-1 border-l border-border pl-2">
          {runs.map((run) => (
            <li key={run.id}>
              <Button
                variant="ghost"
                className="h-auto w-full flex-col items-start gap-1 px-2 py-2 text-left"
                onClick={() => openRun(run.id)}
                aria-label={`Open ${run.loop} Run: ${run.state}`}
              >
                <span className="flex w-full flex-wrap items-center gap-2">
                  <span className="break-all">{run.loop}</span>
                  <StatusBadge state={run.state} />
                </span>
                <span className="text-muted-foreground font-normal">
                  {run.agent} · {run.attempts.length}{" "}
                  {run.attempts.length === 1 ? "Attempt" : "Attempts"}
                </span>
                <time className="text-muted-foreground font-normal" dateTime={run.openedAt}>
                  {new Date(run.openedAt).toLocaleString()}
                </time>
              </Button>
            </li>
          ))}
        </ol>
      </ScrollArea>
    </div>
  );
};
