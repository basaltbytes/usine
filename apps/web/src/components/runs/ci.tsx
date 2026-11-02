import type { RunSummaryView } from "@usine/orchestrator/operator";
import { Link } from "@tanstack/react-router";
import { ciFailedOn, continuesTheWork, waitingForCi } from "~/lib/runs/strings";

type CiWaitLineProps = { readonly run: RunSummaryView };

export const CiWaitLine = ({ run }: CiWaitLineProps) =>
  run.ciWait === null ? null : (
    <a
      href={`https://github.com/${run.repository}/pull/${run.ciWait.pullRequest}/checks`}
      target="_blank"
      rel="noreferrer"
      className="text-primary hover:underline"
      onClick={(event) => event.stopPropagation()}
    >
      {waitingForCi}
    </a>
  );

export const CiHandoffLine = ({ run }: CiWaitLineProps) => {
  const handoff = run.handoff;
  return handoff === null ? null : (
    <span className="text-muted-foreground" title={handoff.reason}>
      {ciFailedOn(handoff.head)}
      <Link
        to="."
        search={(previous) => ({ ...previous, run: handoff.fixRunId })}
        className="text-primary hover:underline"
        onClick={(event) => event.stopPropagation()}
      >
        {handoff.fixLoop} run {handoff.fixRunId.slice(0, 8)}
      </Link>
      {continuesTheWork}
    </span>
  );
};
