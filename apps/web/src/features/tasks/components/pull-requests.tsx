import { Fragment } from "react";
import type { ProjectId } from "@usine/core/project";
import { PullRequestChanges } from "~/features/tasks/components/pull-request/changes";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import type { TaskView } from "@usine/orchestrator/operator";
import { FillCell } from "~/components/fill-cell";
import { Table, TableBody, TableCell, TableRow } from "~/components/ui/table";
import { ItemMark } from "~/components/item/mark";
import {
  LinkedRow,
  rowLink,
  SectionEmpty,
  SectionHeading,
} from "~/features/tasks/components/section";

type TaskPullRequestsProps = { readonly task: TaskView; readonly project: ProjectId | undefined };

export const TaskPullRequests = ({ task, project }: TaskPullRequestsProps) => {
  const pullRequests = task.items.filter(({ kind }) => kind === "pr");
  return (
    <section aria-labelledby="task-pull-requests" className="flex flex-col gap-2">
      <SectionHeading id="task-pull-requests" title="Pull requests" count={pullRequests.length} />
      {pullRequests.length === 0 ? (
        <SectionEmpty title="No pull requests">
          Pull requests that close the issue, or that a run on the issue opened, appear here
        </SectionEmpty>
      ) : (
        <div className="-mx-2">
          <Table aria-labelledby="task-pull-requests">
            <TableBody divided>
              {pullRequests.map((pullRequest) => (
                <Fragment key={pullRequest.itemKey}>
                  <LinkedRow>
                    <TableCell size="roomy" className="w-0">
                      <ItemMark item={pullRequest} linked={false} />
                    </TableCell>
                    <FillCell size="roomy" className="whitespace-normal">
                      <a
                        data-row-link
                        href={pullRequest.url}
                        target="_blank"
                        rel="noreferrer"
                        className={`font-medium wrap-anywhere ${rowLink}`}
                      >
                        {pullRequest.title}
                        <ArrowSquareOutIcon
                          className="ml-1.5 inline size-3.5 text-muted-foreground"
                          aria-label="Opens on GitHub"
                        />
                      </a>
                    </FillCell>
                    <TableCell size="roomy" className="text-right">
                      {pullRequest.conflicting && (
                        <span className="text-xs text-destructive">Conflicts with base</span>
                      )}
                    </TableCell>
                  </LinkedRow>
                  {project !== undefined && (
                    <TableRow variant="plain">
                      <TableCell size="continuation" colSpan={3} className="max-w-0">
                        <PullRequestChanges
                          project={project}
                          task={task}
                          pullRequest={pullRequest}
                        />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
};
