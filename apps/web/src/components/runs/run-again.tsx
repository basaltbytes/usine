import { Link } from "@tanstack/react-router";
import type { RunView } from "@usine/orchestrator/operator";
import { Option } from "effect";
import { cn } from "~/lib/utils";
import { dayTimeLabel, timestampLabel } from "~/lib/strings";
import { projectParams } from "~/lib/overview";

/** If the Run was opened by its trigger, renders nothing. */
export const RunAgainLine = ({
  run,
  source,
  className,
}: {
  readonly run: Pick<RunView, "runAgain" | "openedAt" | "repository">;
  /** `link` links the earlier Run's short ID to its Run page; `text` is for use inside another link or button. */
  readonly source: "link" | "text";
  readonly className?: string;
}) => {
  if (run.runAgain === null) return null;
  const { from, requestedBy } = run.runAgain;
  const id = from.slice(0, 8);
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
        from run{" "}
        {source === "link" ? (
          // Raised above the row-covering link on a Task page.
          <Link
            to="/projects/$owner/$name/runs/$run"
            params={{ ...projectParams(run.repository), run: from }}
            className="relative z-10 font-mono text-xs text-primary underline-offset-4 hover:underline"
          >
            {id}
          </Link>
        ) : (
          <span className="font-mono text-xs">{id}</span>
        )}
      </span>
    </span>
  );
};
