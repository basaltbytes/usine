import type { RunView } from "@usine/orchestrator/operator";
import { waitingForCi } from "~/lib/runs/strings";

type CiWaitLineProps = { readonly run: RunView };

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
