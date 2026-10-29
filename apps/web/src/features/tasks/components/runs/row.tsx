import { useProjectLinks } from "~/hooks/use-project-links";
import { Link } from "@tanstack/react-router";
import type { RunId } from "@usine/core/run";
import type { RunView, TaskItemView } from "@usine/orchestrator/operator";
import { Option } from "effect";
import { type ReactNode, useState } from "react";
import { FillCell } from "~/components/fill-cell";
import { ItemMark, type ItemRef } from "~/components/item/mark";
import { ApprovalLine } from "~/components/runs/approval";
import {
  EditAndRetry,
  editApplies,
  type EditIntent,
} from "~/components/runs/intervention/edit-and-retry";
import { RunAgainLine } from "~/components/runs/run-again";
import { StateMark } from "~/components/status-badge";
import { TableCell, TableRow } from "~/components/ui/table";
import { Duration } from "~/features/tasks/components/runs/duration";
import { FailureLine } from "~/features/tasks/components/runs/failure-line";
import { FoldedFacts } from "~/features/tasks/components/runs/folded-facts";
import { Opened } from "~/features/tasks/components/runs/opened";
import { PullRequest } from "~/features/tasks/components/runs/pull-request";
import { RowActions } from "~/features/tasks/components/runs/actions";
import { linkedRow, rowLink } from "~/features/tasks/components/section";

import { cn } from "~/lib/utils";

const COLUMNS = 8;

type RunRowProps = {
  readonly run: RunView;
  /** The Run's Item, if the Task has more than one Item and it isn't the Run's pull request. */
  readonly item: TaskItemView | null;
  /** The pull request the Run opened, with its state from the Task. */
  readonly pullRequest: Option.Option<ItemRef>;
  readonly openRun: (runId: RunId) => void;
};

export const RunRow = ({ run, item, pullRequest, openRun }: RunRowProps) => {
  const projectLinks = useProjectLinks();
  const [editing, setEditing] = useState<EditIntent | null>(null);
  const [status, setStatus] = useState<ReactNode>(null);
  return (
    <>
      <TableRow className={cn(linkedRow, "[&>td]:align-top")}>
        <TableCell className="hidden py-3 sm:table-cell">
          <span className="inline-flex items-center gap-2 text-foreground">
            <StateMark state={run.state} />
            {run.state}
          </span>
        </TableCell>
        <FillCell className="py-3 whitespace-normal">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="flex min-w-0 items-baseline gap-2">
              <StateMark state={run.state} className="self-center sm:hidden" />
              <Link
                data-row-link
                {...projectLinks.run(run.repository, run.id)}
                className={cn("font-medium wrap-anywhere", rowLink)}
              >
                {run.loop}
              </Link>
              {item !== null && <ItemMark item={item} className="relative z-10 shrink-0" />}
            </p>
            <FailureLine run={run} />
            {run.runAgain !== null && <RunAgainLine run={run} source="link" className="text-xs" />}
            {run.approval !== null && <ApprovalLine approval={run.approval} className="text-xs" />}
            <FoldedFacts run={run} pullRequest={pullRequest} />
            {status !== null && (
              <p role="status" className="text-xs">
                {status}
              </p>
            )}
          </div>
        </FillCell>
        <TableCell className="hidden py-3 xl:table-cell">{run.agent}</TableCell>
        <TableCell className="hidden py-3 text-right tabular-nums xl:table-cell">
          {run.attempts.length}
        </TableCell>
        <TableCell className="hidden py-3 text-right xl:table-cell">
          <Duration run={run} />
        </TableCell>
        <TableCell className="hidden py-3 xl:table-cell">
          <Opened run={run} />
        </TableCell>
        <TableCell className="hidden py-3 xl:table-cell">
          <PullRequest pullRequest={pullRequest} />
        </TableCell>
        <TableCell className="py-2.5">
          <RowActions run={run} onEdit={setEditing} openRun={openRun} status={setStatus} />
        </TableCell>
      </TableRow>
      {editing !== null && editApplies(run, editing) && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={COLUMNS} className="px-2 pt-1 pb-4 whitespace-normal">
            <EditAndRetry
              key={`${run.id}:${editing}`}
              run={run}
              intent={editing}
              close={() => setEditing(null)}
              openRun={openRun}
              className="max-w-2xl rounded-lg border p-4"
            />
          </TableCell>
        </TableRow>
      )}
    </>
  );
};
