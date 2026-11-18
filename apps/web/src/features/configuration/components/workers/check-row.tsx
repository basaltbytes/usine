import type { PreflightCheckView } from "@usine/orchestrator/operator";
import { FillCell } from "~/components/fill-cell";
import { TableCell, TableRow } from "~/components/ui/table";
import { CheckResult } from "~/features/configuration/components/workers/check-result";
import { dayTimeLabel } from "~/lib/strings";

type CheckRowProps = {
  readonly subject: string;
  readonly detail: string;
  readonly check: PreflightCheckView;
};

/** Renders one preflight check; below a 42rem table, its time and message fold into the first two
 * cells. */
export const CheckRow = ({ subject, detail, check }: CheckRowProps) => {
  const message = check._tag === "Passed" ? null : check.message;
  const checkedLabel = dayTimeLabel(check.checkedAt);
  return (
    <TableRow variant="static">
      <TableCell size="roomy" className="align-top whitespace-normal @2xl:min-w-56">
        <p className="font-medium">{subject}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
        {message !== null && <p className="mt-1 wrap-anywhere @2xl:hidden">{message}</p>}
      </TableCell>
      <TableCell size="roomy" className="align-top">
        <CheckResult check={check} />
        <p className="mt-1 font-mono text-xs text-muted-foreground tabular-nums @2xl:hidden">
          {checkedLabel}
        </p>
      </TableCell>
      <TableCell
        size="roomy"
        variant="numeric"
        tone="muted"
        className="hidden align-top @2xl:table-cell"
      >
        {checkedLabel}
      </TableCell>
      <FillCell
        size="roomy"
        className="hidden align-top whitespace-normal wrap-anywhere @2xl:table-cell"
      >
        {message}
      </FillCell>
    </TableRow>
  );
};
