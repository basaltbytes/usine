import { clockLabel, timestampLabel } from "~/lib/strings";
import { cn } from "~/lib/utils";

type GutterProps = {
  readonly receivedAt?: string | undefined;
  readonly speaker?: string | null | undefined;
  readonly tone?: "plain" | "failed";
};

export const Gutter = ({ receivedAt, speaker, tone = "plain" }: GutterProps) => (
  <>
    {receivedAt !== undefined && (
      <time
        dateTime={receivedAt}
        title={timestampLabel(receivedAt)}
        className="font-mono text-xs leading-[1.4rem] tabular-nums text-muted-foreground"
      >
        {clockLabel(receivedAt)}
      </time>
    )}
    {speaker !== null && speaker !== undefined && (
      <span
        className={cn(
          "truncate text-xs font-medium",
          tone === "failed" ? "text-destructive" : "text-foreground",
        )}
      >
        {speaker}
      </span>
    )}
  </>
);
