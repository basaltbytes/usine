import { Fragment } from "react";
import { totalsFigures, type TaskTotals } from "~/lib/tasks/model";

type TotalsLineProps = { readonly totals: TaskTotals };

/** Renders the totals of all listed Tasks, for example `9 runs, 6 h 12 min elapsed, 4.8M tokens,
 * $14.20 estimated`; each lower bound is marked `*` with the reason in its title. */
export const TotalsLine = ({ totals }: TotalsLineProps) => (
  <p className="-mt-2 text-sm text-muted-foreground tabular-nums">
    {totalsFigures(totals).map(({ figure, words, lowerBound }, index) => (
      <Fragment key={words}>
        {index > 0 && ", "}
        {lowerBound === null ? figure : <span title={lowerBound}>{`${figure}*`}</span>} {words}
      </Fragment>
    ))}
  </p>
);
