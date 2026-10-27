import type { ApprovalView } from "@usine/orchestrator/operator";
import { Option } from "effect";
import { cn } from "~/lib/utils";
import { approvalChannelLabel, dayTimeLabel, timestampLabel } from "~/lib/strings";

/** Renders nothing if there is no approval; without a recorded source, shows only that the Run was approved and when. */
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
