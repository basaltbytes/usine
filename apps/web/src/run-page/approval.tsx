import type { ApprovalView } from "@usine/orchestrator/operator";
import { Option } from "effect";
import { cn } from "@/lib/utils";
import { approvalChannelLabel, dayTimeLabel, timestampLabel } from "../operator-copy.ts";

/**
 * Who approved the Run, when, and from where, as one quiet line that wraps only
 * between its parts. An approval given before usine recorded its source shows
 * only that it happened and when; a Run with no approval shows nothing.
 */
export const ApprovalLine = ({
  approval,
  className,
}: {
  readonly approval: ApprovalView | null;
  readonly className?: string;
}) => {
  if (approval === null) return null;
  const source = Option.fromNullishOr(approval.source);
  const approver = Option.flatMap(source, ({ approver }) => approver);
  return (
    <span className={cn("text-muted-foreground", className)}>
      <span className="whitespace-nowrap">
        {Option.match(approver, {
          onNone: () => "Approved",
          onSome: (login) => `Approved by ${login}`,
        })}
      </span>
      {" · "}
      <time
        dateTime={approval.approvedAt}
        title={timestampLabel(approval.approvedAt)}
        className="font-mono text-xs whitespace-nowrap tabular-nums"
      >
        {dayTimeLabel(approval.approvedAt)}
      </time>
      {Option.match(source, {
        onNone: () => null,
        onSome: ({ channel }) => (
          <>
            {" · "}
            <span className="whitespace-nowrap">{approvalChannelLabel[channel]}</span>
          </>
        ),
      })}
    </span>
  );
};
