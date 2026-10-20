import type { RunView } from "@usine/orchestrator/operator";
import { Option } from "effect";
import { cn } from "@/lib/utils";
import { dayTimeLabel, timestampLabel } from "../operator-copy.ts";

/**
 * Who ran an earlier Run again to open this one, when, and which Run it was, as one quiet line
 * that wraps only between its parts. A Run its trigger opened shows nothing.
 */
export const RunAgainLine = ({
  run,
  className,
}: {
  readonly run: Pick<RunView, "runAgain" | "openedAt">;
  readonly className?: string;
}) => {
  if (run.runAgain === null) return null;
  const { from, requestedBy } = run.runAgain;
  return (
    <span className={cn("text-muted-foreground", className)}>
      <span className="whitespace-nowrap">
        {Option.match(requestedBy, {
          onNone: () => "Run again",
          onSome: (login) => `Run again by ${login}`,
        })}
      </span>
      {" · "}
      <time
        dateTime={run.openedAt}
        title={timestampLabel(run.openedAt)}
        className="font-mono text-xs whitespace-nowrap tabular-nums"
      >
        {dayTimeLabel(run.openedAt)}
      </time>
      {" · "}
      <span className="whitespace-nowrap">
        from run <span className="font-mono text-xs">{from.slice(0, 8)}</span>
      </span>
    </span>
  );
};
