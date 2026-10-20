import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import type { TaskView } from "@usine/orchestrator/operator";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { itemStateLabel } from "./model.ts";
import { linkedRow, rowLink, SectionEmpty, SectionHeading } from "./section.tsx";

/** The Task's pull requests, each opening on GitHub, with its state and whether it conflicts with its base. */
export const TaskPullRequests = ({ task }: { readonly task: TaskView }) => {
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
            <TableBody className="border-t">
              {pullRequests.map((pullRequest) => (
                <TableRow key={pullRequest.itemKey} className={linkedRow}>
                  <TableCell className="w-0 py-3 font-mono text-xs text-muted-foreground">
                    #{pullRequest.number}
                  </TableCell>
                  <TableCell className="w-full py-3 whitespace-normal">
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
                  </TableCell>
                  <TableCell className="py-3 text-right">
                    <span className="inline-flex flex-col items-end gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
                      {pullRequest.conflicting && (
                        <span className="text-xs text-destructive">Conflicts with base</span>
                      )}
                      <span>{itemStateLabel(pullRequest.state)}</span>
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
};
