import { clockLabel, timestampLabel } from "~/lib/strings";
import { cn } from "~/lib/utils";
import { TextTooltip } from "~/components/text-tooltip";

type GutterProps = {
  readonly receivedAt?: string | undefined;
  readonly speaker?: string | null | undefined;
  readonly tone?: "plain" | "failed";
};

export const Gutter = ({ receivedAt, speaker, tone = "plain" }: GutterProps) => (
  <>
    {receivedAt !== undefined && (
      <TextTooltip text={timestampLabel(receivedAt)}>
        <time
          dateTime={receivedAt}
          className="font-mono text-xs leading-reader tabular-nums text-muted-foreground"
        >
          {clockLabel(receivedAt)}
        </time>
      </TextTooltip>
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
